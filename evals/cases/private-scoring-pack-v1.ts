import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import { z } from "zod";
import ts from "typescript";

import { canonicalizeJson, canonicalSha256 } from "../../src/contracts";

const FROZEN_PUBLIC_CORPUS_COMMIT =
  "aa880976bcb06b32e4c38a5589e82ca101f9f160";
const FROZEN_PUBLIC_CORPUS_TREE =
  "c601c8ce1f89144118895b2b990965a669fdad42";
const TRUSTED_PUBLICATION_BASE_COMMIT =
  "5e9a639e0f40f417163ad613cf191f9228ddd7cf";
const TRUSTED_PUBLICATION_BASE_TREE =
  "a9fd88fc9c8756a720cd0c9aba3959d3024dd714";

const PUBLICATION_SCAN_LIMITS = Object.freeze({
  sourceBytes: 262_144,
  decodedBytes: 500_000,
  decodedVariants: 8,
  decodedRounds: 2,
  astNodes: 16_384,
  materializationDepth: 128,
  materializationNodes: 4_096,
  staticAliasBindings: 33,
  unresolvedNodes: 4_096,
});
const FROZEN_CORPUS_DECODED_BYTES = 64 * 1024 * 1024;
const FROZEN_CORPUS_DECODED_VARIANTS = 32;
const FROZEN_CORPUS_DECODED_ROUNDS = 8;

class PublicationScanIndeterminateError extends Error {
  readonly code = "PUBLICATION_SCAN_INDETERMINATE";

  constructor(readonly boundary: string) {
    super(`publication scan indeterminate: ${boundary} budget exceeded`);
    this.name = "PublicationScanIndeterminateError";
  }
}

function failIndeterminate(boundary: string): never {
  throw new PublicationScanIndeterminateError(boundary);
}

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const JsonObjectSchema = z.record(z.string(), z.json());

const ExpectedPublicSetSchema = z
  .object({
    setHash: HashSchema,
    cases: z
      .array(
        z
          .object({ id: IdSchema, version: SemverSchema })
          .strict(),
      )
      .length(6),
  })
  .strict()
  .superRefine(({ cases }, context) => {
    if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "public identities must be distinct",
      });
    }
  });

const PrivateEntrySchema = z
  .object({
    publicCaseId: IdSchema,
    publicCaseVersion: SemverSchema,
    privatePayload: JsonObjectSchema,
    privatePayloadHash: HashSchema,
  })
  .strict();

const PrivatePackWithoutHashSchema = z
  .object({
    formatVersion: z.literal("1.0.0"),
    evidenceMode: z.literal("fixture"),
    publicSetHash: HashSchema,
    entries: z.array(PrivateEntrySchema).length(6),
    privateSetPayload: JsonObjectSchema,
    privateSetPayloadHash: HashSchema,
  })
  .strict();

const PrivatePackSchema = PrivatePackWithoutHashSchema.extend({
  packHash: HashSchema,
}).strict();

type ExpectedPublicSet = z.infer<typeof ExpectedPublicSetSchema>;
type PrivatePack = z.infer<typeof PrivatePackSchema>;
type PrivateState = {
  bindingHash: string;
  trustedPackFileHash: string;
  pack: PrivatePack;
  revoked: boolean;
};

const privateStates = new WeakMap<object, PrivateState>();
type PublicCorpusState = {
  repositoryRoot: string;
  publicValues: ReadonlySet<string>;
};
const publicCorpusStates = new WeakMap<object, PublicCorpusState>();
const frozenPublicValuesByRepository = new Map<string, ReadonlySet<string>>();

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{N}]/gu, "");
}

function parseExpectedPublicSet(input: unknown) {
  const parsed = ExpectedPublicSetSchema.parse(structuredClone(input));
  return {
    ...parsed,
    cases: [...parsed.cases].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

function bindingHash(publicSet: ExpectedPublicSet) {
  return canonicalSha256({
    setHash: publicSet.setHash,
    cases: publicSet.cases,
  });
}

function parsePrivatePack(
  path: string,
  expectedPublicSet: unknown,
  trustedPackFileHash: unknown,
) {
  if (typeof window !== "undefined") {
    throw new Error("private scoring pack loading is server-only");
  }
  const publicSet = parseExpectedPublicSet(expectedPublicSet);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error("private scoring pack is missing or unreadable");
  }
  const trustedHash = HashSchema.safeParse(trustedPackFileHash);
  const actualFileHash = createHash("sha256").update(raw, "utf8").digest("hex");
  if (!trustedHash.success || actualFileHash !== trustedHash.data) {
    throw new Error("trusted private scoring pack identity mismatch");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("private scoring pack is malformed");
  }

  const result = PrivatePackSchema.safeParse(decoded);
  if (!result.success) throw new Error("private scoring pack is malformed");
  const pack = result.data;
  const sortedEntries = [...pack.entries].sort((left, right) =>
    left.publicCaseId.localeCompare(right.publicCaseId),
  );
  const expectedCases = publicSet.cases.map(({ id, version }) => ({
    publicCaseId: id,
    publicCaseVersion: version,
  }));
  if (
    pack.publicSetHash !== publicSet.setHash ||
    JSON.stringify(
      sortedEntries.map(({ publicCaseId, publicCaseVersion }) => ({
        publicCaseId,
        publicCaseVersion,
      })),
    ) !== JSON.stringify(expectedCases)
  ) {
    throw new Error("private scoring pack does not match the public case set");
  }
  const uniquePublicIdentities = new Set(
    sortedEntries.map(({ publicCaseId }) => publicCaseId),
  );
  if (uniquePublicIdentities.size !== 6) {
    throw new Error("private scoring pack public case set is not distinct");
  }
  for (const entry of sortedEntries) {
    if (entry.privatePayloadHash !== canonicalSha256(entry.privatePayload)) {
      throw new Error("private scoring pack payload hash mismatch");
    }
  }
  if (
    pack.privateSetPayloadHash !== canonicalSha256(pack.privateSetPayload)
  ) {
    throw new Error("private scoring pack set payload hash mismatch");
  }
  const { packHash, ...withoutHash } = pack;
  if (packHash !== canonicalSha256(withoutHash)) {
    throw new Error("private scoring pack hash mismatch");
  }
  return {
    pack: structuredClone(pack),
    publicSet,
    trustedPackFileHash: trustedHash.data,
  };
}

function requireState(handle: unknown) {
  if (
    (typeof handle !== "object" && typeof handle !== "function") ||
    handle === null
  ) {
    throw new Error("invalid private scoring pack authority");
  }
  const state = privateStates.get(handle);
  if (!state) throw new Error("invalid private scoring pack authority");
  if (state.revoked) throw new Error("private scoring pack authority is revoked");
  return state;
}

export function loadPrivateScoringPack(
  path: string,
  expectedPublicSet: unknown,
  trustedPackFileHash: string,
) {
  const { pack, publicSet, trustedPackFileHash: acceptedPackFileHash } =
    parsePrivatePack(
      path,
      expectedPublicSet,
      trustedPackFileHash,
    );
  const handle = Object.freeze(Object.create(null)) as object;
  privateStates.set(handle, {
    bindingHash: bindingHash(publicSet),
    trustedPackFileHash: acceptedPackFileHash,
    pack,
    revoked: false,
  });
  return handle;
}

export function assertPrivateScoringPackActive(
  handle: unknown,
  expectedPublicSet: unknown,
  trustedPackFileHash: string,
) {
  const state = requireState(handle);
  const publicSet = parseExpectedPublicSet(expectedPublicSet);
  if (state.bindingHash !== bindingHash(publicSet)) {
    throw new Error("private scoring pack authority uses another public case set");
  }
  if (state.trustedPackFileHash !== trustedPackFileHash) {
    throw new Error("private scoring pack authority uses another trusted pack");
  }
}

export function revokePrivateScoringPack(handle: unknown) {
  const state = requireState(handle);
  state.revoked = true;
}

function decodedVariants(
  value: string,
  maxDecodedBytes = FROZEN_CORPUS_DECODED_BYTES,
  maxDecodedRounds = FROZEN_CORPUS_DECODED_ROUNDS,
  maxDecodedVariants = FROZEN_CORPUS_DECODED_VARIANTS,
) {
  const variants = new Set([value]);
  const accepted = new Set([value]);
  let decodedBytes = Buffer.byteLength(value, "utf8");
  const add = (candidate: string) => {
    if (accepted.has(candidate)) return;
    const nextBytes = decodedBytes + Buffer.byteLength(candidate, "utf8");
    if (
      accepted.size >= maxDecodedVariants ||
      nextBytes > maxDecodedBytes
    ) {
      failIndeterminate("decoded expansion");
    }
    accepted.add(candidate);
    variants.add(candidate);
    decodedBytes = nextBytes;
  };
  const decodePercentRuns = (candidate: string) => {
    if (!/%[a-f0-9]{2}/i.test(candidate)) return candidate;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return candidate.replaceAll(/(?:%[a-f0-9]{2})+/gi, (run) => {
      const encodedBytes = run.match(/[a-f0-9]{2}/gi) ?? [];
      const bytes = Uint8Array.from(
        encodedBytes.map((encoded) => Number.parseInt(encoded, 16)),
      );
      try {
        return decoder.decode(bytes);
      } catch {
        failIndeterminate("invalid percent-encoded UTF-8");
      }
    });
  };
  const decodeEscapedSequences = (candidate: string) => {
    if (!/[\\&]/.test(candidate)) return candidate;
    return candidate
      .replaceAll(/\\u\{([a-f0-9]{1,6})\}/gi, (_, codePoint: string) =>
        String.fromCodePoint(Number.parseInt(codePoint, 16)),
      )
      .replaceAll(/\\u([a-f0-9]{4})/gi, (_, codePoint: string) =>
        String.fromCodePoint(Number.parseInt(codePoint, 16)),
      )
      .replaceAll(/\\x([a-f0-9]{2})/gi, (_, codePoint: string) =>
        String.fromCodePoint(Number.parseInt(codePoint, 16)),
      )
      .replaceAll(/&#x([a-f0-9]+);/gi, (_, codePoint: string) =>
        String.fromCodePoint(Number.parseInt(codePoint, 16)),
      )
      .replaceAll(/&#([0-9]+);/g, (_, codePoint: string) =>
        String.fromCodePoint(Number.parseInt(codePoint, 10)),
      );
  };
  for (let round = 0; round < maxDecodedRounds; round += 1) {
    const acceptedBeforeRound = accepted.size;
    for (const candidate of [...variants]) {
      add(decodePercentRuns(candidate));
      add(decodeEscapedSequences(candidate));
    }
    if (accepted.size === acceptedBeforeRound) break;
  }
  for (const candidate of accepted) {
    if (
      !accepted.has(decodePercentRuns(candidate)) ||
      !accepted.has(decodeEscapedSequences(candidate))
    ) {
      failIndeterminate("decoded iteration");
    }
  }
  return accepted;
}

function samePath(left: string, right: string) {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function trustedGitText(repositoryRoot: string, args: readonly string[]) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("trusted frozen public corpus identity mismatch");
  }
}

function trustedRepositoryRoot(repositoryPath: unknown) {
  if (typeof repositoryPath !== "string") {
    throw new Error("invalid frozen public corpus repository");
  }
  let requestedRoot: string;
  try {
    requestedRoot = realpathSync.native(repositoryPath);
  } catch {
    throw new Error("invalid frozen public corpus repository");
  }
  const discoveredRoot = realpathSync.native(
    trustedGitText(requestedRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (!samePath(requestedRoot, discoveredRoot)) {
    throw new Error("invalid frozen public corpus repository");
  }
  return discoveredRoot;
}

function collectCanonicalDocumentValues(documents: readonly string[]) {
  const values = new Set<string>();
  const add = (value: string) => {
    const canonical = normalized(value);
    if (canonical.length > 0) values.add(canonical);
  };
  const addJsonItems = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(addJsonItems);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        add(key);
        addJsonItems(entry);
      }
      return;
    }
    add(canonicalizeJson(value));
  };
  for (const bytes of documents) {
    for (const decoded of decodedVariants(bytes)) {
      for (const line of decoded.split(/\r?\n/)) {
        add(line);
        line.split(/[:=|;,]/).forEach(add);
      }
      for (const match of decoded.matchAll(/[\p{L}\p{N}_-]+/gu)) add(match[0]);
      for (const match of decoded.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
        for (const literal of decodedVariants(match[2])) add(literal);
      }
      try {
        addJsonItems(JSON.parse(decoded) as unknown);
      } catch {
        // Non-JSON public source still contributes exact lexical items above.
      }
    }
  }
  return values;
}

type CompositeSignature = {
  canonical: string;
  keys: ReadonlySet<string>;
  scalars: ReadonlySet<string>;
};

function compositeSignature(value: unknown): CompositeSignature {
  const keys = new Set<string>();
  const scalars = new Set<string>();
  const collect = (entry: unknown) => {
    if (Array.isArray(entry)) {
      entry.forEach(collect);
      return;
    }
    if (typeof entry === "object" && entry !== null) {
      for (const [key, child] of Object.entries(entry)) {
        const canonicalKey = normalized(key);
        if (canonicalKey.length > 0) keys.add(canonicalKey);
        collect(child);
      }
      return;
    }
    const canonicalScalar = normalized(canonicalizeJson(entry));
    if (canonicalScalar.length > 0) scalars.add(canonicalScalar);
  };
  collect(value);
  return {
    canonical: normalized(canonicalizeJson(value)),
    keys,
    scalars,
  };
}

const notStatic = Symbol("not-static");
type StaticResult = unknown | typeof notStatic;
type StaticBinding = {
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
  scope: StaticScope;
};
type StaticScope = {
  parent?: StaticScope;
  bindings: Map<string, StaticBinding | null>;
};

function analyzeStaticSource(
  source: string,
  addComposite: (value: unknown) => void,
  addUnresolved: (signature: CompositeSignature) => void,
) {
  const sourceFile = ts.createSourceFile(
    "publication-candidate.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const rootScope: StaticScope = { bindings: new Map() };
  const scopes = new WeakMap<ts.Node, StaticScope>();
  let boundAstNodes = 0;
  const register = (
    scope: StaticScope,
    name: string,
    binding: StaticBinding | null,
  ) => {
    if (scope.bindings.has(name)) {
      scope.bindings.set(name, null);
    } else {
      scope.bindings.set(name, binding);
    }
  };
  const blockBindingName = (scope: StaticScope, name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      register(scope, name.text, null);
      return;
    }
    name.elements.forEach((element) => {
      if (!ts.isOmittedExpression(element)) blockBindingName(scope, element.name);
    });
  };
  const isFunctionNode = (node: ts.Node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
  const createsScope = (node: ts.Node) =>
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSwitchStatement(node) ||
    isFunctionNode(node);
  const bindDeclarations = (node: ts.Node, incomingScope: StaticScope) => {
    boundAstNodes += 1;
    if (boundAstNodes > PUBLICATION_SCAN_LIMITS.astNodes) {
      failIndeterminate("AST node traversal");
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      register(incomingScope, node.name.text, null);
    }
    let scope = incomingScope;
    if (node !== sourceFile && createsScope(node)) {
      scope = { parent: incomingScope, bindings: new Map() };
    }
    scopes.set(node, scope);
    if (isFunctionNode(node)) {
      node.parameters.forEach((parameter) =>
        blockBindingName(scope, parameter.name),
      );
      if (ts.isFunctionExpression(node) && node.name) {
        register(scope, node.name.text, null);
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      blockBindingName(scope, node.variableDeclaration.name);
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const isConst =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (ts.isIdentifier(node.name)) {
        const binding =
          isConst && node.initializer
            ? { declaration: node, initializer: node.initializer, scope }
            : null;
        register(scope, node.name.text, binding);
      } else {
        blockBindingName(scope, node.name);
      }
    }
    if (ts.isImportClause(node) && node.name) register(scope, node.name.text, null);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      register(scope, node.name.text, null);
    }
    ts.forEachChild(node, (child) => bindDeclarations(child, scope));
  };
  bindDeclarations(sourceFile, rootScope);

  const propertyName = (
    name: ts.PropertyName,
    scope: StaticScope,
    resolving: Set<ts.VariableDeclaration>,
    depth: number,
    budget: { remaining: number },
  ): string | typeof notStatic => {
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name)
    ) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      const computed = materialize(
        name.expression,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      return typeof computed === "string" || typeof computed === "number"
        ? String(computed)
        : notStatic;
    }
    return notStatic;
  };
  const resolveIdentifier = (
    identifier: ts.Identifier,
    initialScope: StaticScope,
    resolving: Set<ts.VariableDeclaration>,
    depth: number,
    budget: { remaining: number },
  ): StaticResult => {
    let scope: StaticScope | undefined = initialScope;
    while (scope) {
      if (scope.bindings.has(identifier.text)) {
        const binding = scope.bindings.get(identifier.text);
        if (
          !binding ||
          binding.declaration.getStart(sourceFile) >= identifier.getStart(sourceFile)
        ) {
          return notStatic;
        }
        if (resolving.has(binding.declaration)) return notStatic;
        if (resolving.size >= PUBLICATION_SCAN_LIMITS.staticAliasBindings) {
          failIndeterminate("static alias graph");
        }
        resolving.add(binding.declaration);
        const value = materialize(
          binding.initializer,
          binding.scope,
          resolving,
          depth + 1,
          budget,
        );
        resolving.delete(binding.declaration);
        return value;
      }
      scope = scope.parent;
    }
    return notStatic;
  };
  const materialize = (
    node: ts.Expression,
    scope: StaticScope,
    resolving: Set<ts.VariableDeclaration>,
    depth: number,
    budget: { remaining: number },
  ): StaticResult => {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      failIndeterminate("static materialization node");
    }
    if (depth > PUBLICATION_SCAN_LIMITS.materializationDepth) {
      failIndeterminate("static materialization depth");
    }
    if (ts.isParenthesizedExpression(node)) {
      return materialize(node.expression, scope, resolving, depth + 1, budget);
    }
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return materialize(node.expression, scope, resolving, depth + 1, budget);
    }
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      return resolveIdentifier(node, scope, resolving, depth, budget);
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const expression = materialize(
          span.expression,
          scope,
          resolving,
          depth + 1,
          budget,
        );
        if (
          expression === notStatic ||
          (typeof expression !== "string" &&
            typeof expression !== "number" &&
            typeof expression !== "boolean")
        ) {
          return notStatic;
        }
        value += `${expression}${span.literal.text}`;
      }
      return value;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = materialize(
        node.left,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      const right = materialize(
        node.right,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      if (left === notStatic || right === notStatic) return notStatic;
      if (typeof left === "number" && typeof right === "number") {
        return left + right;
      }
      if (
        (typeof left === "string" || typeof left === "number") &&
        (typeof right === "string" || typeof right === "number")
      ) {
        return `${left}${right}`;
      }
      return notStatic;
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusToken ||
        node.operator === ts.SyntaxKind.MinusToken)
    ) {
      const operand = materialize(
        node.operand,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      if (typeof operand !== "number") return notStatic;
      return node.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: unknown[] = [];
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) return notStatic;
        if (ts.isSpreadElement(element)) {
          const spread = materialize(
            element.expression,
            scope,
            resolving,
            depth + 1,
            budget,
          );
          if (!Array.isArray(spread)) return notStatic;
          values.push(...spread);
          continue;
        }
        const value = materialize(
          element,
          scope,
          resolving,
          depth + 1,
          budget,
        );
        if (value === notStatic) return notStatic;
        values.push(value);
      }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const record: Record<string, unknown> = {};
      const define = (key: string, value: unknown) => {
        Object.defineProperty(record, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      };
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = materialize(
            property.expression,
            scope,
            resolving,
            depth + 1,
            budget,
          );
          if (
            typeof spread !== "object" ||
            spread === null ||
            Array.isArray(spread)
          ) {
            return notStatic;
          }
          for (const [key, value] of Object.entries(spread)) {
            define(key, value);
          }
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          if (property.objectAssignmentInitializer) return notStatic;
          const value = resolveIdentifier(
            property.name,
            scope,
            resolving,
            depth + 1,
            budget,
          );
          if (value === notStatic) return notStatic;
          define(property.name.text, value);
          continue;
        }
        if (!ts.isPropertyAssignment(property)) return notStatic;
        const name = propertyName(
          property.name,
          scope,
          resolving,
          depth + 1,
          budget,
        );
        const value = materialize(
          property.initializer,
          scope,
          resolving,
          depth + 1,
          budget,
        );
        if (name === notStatic || value === notStatic) return notStatic;
        define(name, value);
      }
      return record;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = materialize(
        node.expression,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      if (
        typeof target !== "object" ||
        target === null ||
        !Object.hasOwn(target, node.name.text)
      ) {
        return notStatic;
      }
      return (target as Record<string, unknown>)[node.name.text];
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const target = materialize(
        node.expression,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      const key = materialize(
        node.argumentExpression,
        scope,
        resolving,
        depth + 1,
        budget,
      );
      if (
        typeof target !== "object" ||
        target === null ||
        (typeof key !== "string" && typeof key !== "number") ||
        !Object.hasOwn(target, String(key))
      ) {
        return notStatic;
      }
      return (target as Record<string, unknown>)[String(key)];
    }
    return notStatic;
  };
  const resolveStatic = (node: ts.Expression) =>
    materialize(
      node,
      scopes.get(node) ?? rootScope,
      new Set(),
      0,
      { remaining: PUBLICATION_SCAN_LIMITS.materializationNodes },
    );
  const mergeSignature = (
    target: { keys: Set<string>; scalars: Set<string> },
    signature: CompositeSignature,
  ) => {
    signature.keys.forEach((key) => target.keys.add(key));
    signature.scalars.forEach((scalar) => target.scalars.add(scalar));
  };
  const unresolvedSignature = (
    root: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ) => {
    const signature = { keys: new Set<string>(), scalars: new Set<string>() };
    let remaining = PUBLICATION_SCAN_LIMITS.unresolvedNodes;
    const collect = (node: ts.Node) => {
      remaining -= 1;
      if (remaining < 0) {
        failIndeterminate("unresolved static structure");
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property) ||
            ts.isMethodDeclaration(property) ||
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property)
          ) {
            const name = propertyName(
              property.name,
              scopes.get(property) ?? rootScope,
              new Set(),
              0,
              { remaining: PUBLICATION_SCAN_LIMITS.materializationNodes },
            );
            if (name !== notStatic) {
              const canonicalKey = normalized(name);
              if (canonicalKey.length > 0) signature.keys.add(canonicalKey);
            }
          }
          if (ts.isPropertyAssignment(property)) {
            const value = resolveStatic(property.initializer);
            if (value !== notStatic) {
              mergeSignature(signature, compositeSignature(value));
            } else {
              collect(property.initializer);
            }
          } else if (ts.isShorthandPropertyAssignment(property)) {
            const value = resolveStatic(property.name);
            if (value !== notStatic) {
              mergeSignature(signature, compositeSignature(value));
            }
          } else if (ts.isSpreadAssignment(property)) {
            const value = resolveStatic(property.expression);
            if (value !== notStatic) {
              mergeSignature(signature, compositeSignature(value));
            } else {
              collect(property.expression);
            }
          }
        }
        return;
      }
      if (ts.isArrayLiteralExpression(node)) {
        node.elements.forEach((element) => {
          if (ts.isOmittedExpression(element)) return;
          const expression = ts.isSpreadElement(element)
            ? element.expression
            : element;
          const value = resolveStatic(expression);
          if (value !== notStatic) {
            mergeSignature(signature, compositeSignature(value));
          } else {
            collect(expression);
          }
        });
        return;
      }
      if (ts.isExpression(node)) {
        const value = resolveStatic(node);
        if (value !== notStatic) {
          mergeSignature(signature, compositeSignature(value));
          return;
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(root);
    return {
      canonical: "",
      keys: signature.keys,
      scalars: signature.scalars,
    } satisfies CompositeSignature;
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      const value = resolveStatic(node);
      if (value === notStatic) {
        addUnresolved(unresolvedSignature(node));
      } else {
        addComposite(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectCanonicalDocumentSearches(documents: readonly string[]) {
  const searches = new Set<string>();
  const composites = new Set<string>();
  const unresolved: CompositeSignature[] = [];
  const add = (value: string) => {
    const canonical = normalized(value);
    if (canonical.length > 0) searches.add(canonical);
  };
  const addCanonicalStructures = (value: unknown) => {
    if (Array.isArray(value)) {
      const signature = compositeSignature(value);
      composites.add(signature.canonical);
      add(canonicalizeJson(value));
      value.forEach(addCanonicalStructures);
      return;
    }
    if (typeof value === "object" && value !== null) {
      const signature = compositeSignature(value);
      composites.add(signature.canonical);
      add(canonicalizeJson(value));
      Object.values(value).forEach(addCanonicalStructures);
    }
  };
  for (const bytes of documents) {
    for (const decoded of decodedVariants(
      bytes,
      PUBLICATION_SCAN_LIMITS.decodedBytes,
      PUBLICATION_SCAN_LIMITS.decodedRounds,
      PUBLICATION_SCAN_LIMITS.decodedVariants,
    )) {
      add(decoded);
      try {
        addCanonicalStructures(JSON.parse(decoded) as unknown);
      } catch {
        // Source and prose remain searchable through normalized bytes.
      }
      analyzeStaticSource(decoded, addCanonicalStructures, (signature) => {
        unresolved.push(signature);
      });
    }
  }
  return { searches, composites, unresolved };
}

function readPublicCandidate(path: string) {
  const size = statSync(path).size;
  if (size > PUBLICATION_SCAN_LIMITS.sourceBytes) {
    failIndeterminate("public source size");
  }
  const source = readFileSync(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > PUBLICATION_SCAN_LIMITS.sourceBytes) {
    failIndeterminate("public source size");
  }
  return source;
}

function collectPrivateValues(
  pack: PrivatePack,
  publicValues: ReadonlySet<string>,
) {
  const vocabulary = new Set<string>();
  const composites = new Map<string, CompositeSignature>();
  const commitments = new Set<string>();
  const addVocabulary = (value: string) => {
    const canonical = normalized(value);
    if (canonical.length > 0) vocabulary.add(canonical);
  };
  const collect = (value: unknown, path: string[]) => {
    commitments.add(normalized(canonicalSha256(value)));
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      const signature = compositeSignature(value);
      if (signature.canonical.length > 0) {
        composites.set(signature.canonical, signature);
      }
    }
    if (typeof value === "string") {
      addVocabulary(value);
      return;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      addVocabulary(canonicalizeJson(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collect(entry, [...path, String(index)]));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        addVocabulary(key);
        collect(entry, [...path, key]);
      }
    }
  };
  for (const entry of pack.entries) {
    collect(entry.privatePayload, ["privatePayload"]);
    commitments.add(normalized(entry.privatePayloadHash));
  }
  collect(pack.privateSetPayload, ["privateSetPayload"]);
  commitments.add(normalized(pack.privateSetPayloadHash));
  commitments.add(normalized(pack.packHash));
  return {
    textual: new Set([
      ...commitments,
      ...[...vocabulary].filter((value) => !publicValues.has(value)),
    ]),
    composites: [...composites.values()],
  };
}

function requirePublicCorpusState(
  authority: unknown,
  repositoryPath: unknown,
) {
  if (
    (typeof authority !== "object" && typeof authority !== "function") ||
    authority === null
  ) {
    throw new Error("invalid frozen public corpus authority");
  }
  const state = publicCorpusStates.get(authority);
  if (!state) throw new Error("invalid frozen public corpus authority");
  const repositoryRoot = trustedRepositoryRoot(repositoryPath);
  if (!samePath(state.repositoryRoot, repositoryRoot)) {
    throw new Error("frozen public corpus authority uses another repository");
  }
  return state;
}

export function loadFrozenPublicCorpusAuthority(
  repositoryPath: string,
  publicationBase: string,
) {
  const repositoryRoot = trustedRepositoryRoot(repositoryPath);
  const commit = trustedGitText(repositoryRoot, [
    "rev-parse",
    `${FROZEN_PUBLIC_CORPUS_COMMIT}^{commit}`,
  ]);
  const tree = trustedGitText(repositoryRoot, [
    "rev-parse",
    `${FROZEN_PUBLIC_CORPUS_COMMIT}^{tree}`,
  ]);
  if (commit !== FROZEN_PUBLIC_CORPUS_COMMIT || tree !== FROZEN_PUBLIC_CORPUS_TREE) {
    throw new Error("trusted frozen public corpus identity mismatch");
  }
  const baseCommit = trustedGitText(repositoryRoot, [
    "rev-parse",
    `${publicationBase}^{commit}`,
  ]);
  const baseTree = trustedGitText(repositoryRoot, [
    "rev-parse",
    `${publicationBase}^{tree}`,
  ]);
  if (
    baseCommit !== TRUSTED_PUBLICATION_BASE_COMMIT ||
    baseTree !== TRUSTED_PUBLICATION_BASE_TREE
  ) {
    throw new Error("trusted publication base identity mismatch");
  }
  trustedGitText(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    FROZEN_PUBLIC_CORPUS_COMMIT,
    TRUSTED_PUBLICATION_BASE_COMMIT,
  ]);
  let publicValues = frozenPublicValuesByRepository.get(repositoryRoot);
  if (!publicValues) {
    const corpus = trustedGitText(repositoryRoot, [
      "grep",
      "-I",
      "-h",
      "-e",
      ".",
      FROZEN_PUBLIC_CORPUS_COMMIT,
      "--",
    ]);
    publicValues = collectCanonicalDocumentValues([corpus]);
    frozenPublicValuesByRepository.set(repositoryRoot, publicValues);
  }
  const handle = Object.freeze(Object.create(null)) as object;
  publicCorpusStates.set(handle, {
    repositoryRoot,
    publicValues,
  });
  return handle;
}

export function scanPublicBlobsForPrivateValues(
  path: string,
  expectedPublicSet: unknown,
  trustedPackFileHash: string,
  publicBlobPaths: readonly string[],
  publicCorpusAuthority: unknown,
  repositoryPath: string,
) {
  const { pack } = parsePrivatePack(
    path,
    expectedPublicSet,
    trustedPackFileHash,
  );
  const publicCorpus = requirePublicCorpusState(
    publicCorpusAuthority,
    repositoryPath,
  );
  const privateValues = collectPrivateValues(pack, publicCorpus.publicValues);
  const findings: Array<{ path: string; category: "private-value" }> = [];
  for (const publicPath of [...publicBlobPaths].sort()) {
    const searchableDocuments = collectCanonicalDocumentSearches([
      readPublicCandidate(publicPath),
    ]);
    const textualMatch = [...privateValues.textual].some((value) =>
      [...searchableDocuments.searches].some((searchable) =>
        searchable.includes(value),
      ),
    );
    const compositeMatch = privateValues.composites.some((signature) =>
      searchableDocuments.composites.has(signature.canonical),
    );
    const unresolvedMatch = privateValues.composites.some((privateSignature) =>
      searchableDocuments.unresolved.some((candidateSignature) => {
        const hasAllKeys =
          privateSignature.keys.size > 0 &&
          [...privateSignature.keys].every((key) =>
            candidateSignature.keys.has(key),
          );
        const hasPrivateScalar =
          privateSignature.scalars.size === 0 ||
          [...privateSignature.scalars].some((scalar) =>
            candidateSignature.scalars.has(scalar),
          );
        if (privateSignature.keys.size > 0) {
          return hasAllKeys && hasPrivateScalar;
        }
        return (
          privateSignature.scalars.size > 0 &&
          [...privateSignature.scalars].some((scalar) =>
            candidateSignature.scalars.has(scalar),
          )
        );
      }),
    );
    if (textualMatch || compositeMatch || unresolvedMatch) {
      findings.push({ path: publicPath, category: "private-value" });
    }
  }
  return findings;
}
