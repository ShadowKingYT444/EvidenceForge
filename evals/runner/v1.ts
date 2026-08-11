import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import {
  ResearchRunSchema,
  canonicalSha256,
  canonicalizeJson,
} from "../../src/contracts";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  BenchmarkConfigSchema,
} from "../protocol/v1";

export const EVAL_RUNNER_VERSION = "1.0.0" as const;

export const ARTIFACT_THREAT_MODEL = Object.freeze({
  mode: "trusted_local_single_writer" as const,
  artifactRootIsSecurityBoundary: false as const,
  excludedThreats: Object.freeze({
    sameAccountHardLinking: true as const,
    concurrentAncestorSwap: true as const,
    postWriteCopying: true as const,
  }),
});

type ArtifactFilesystemOperation =
  | "inspect"
  | "initialize_root"
  | "create_directory"
  | "create_temporary_file"
  | "publish_file"
  | "read_artifact";

type ArtifactPathValidationReason =
  | "lexical_escape"
  | "reparse_point"
  | "realpath_escape"
  | "observed_path_change";

export class ArtifactPathValidationError extends Error {
  readonly code = "ARTIFACT_PATH_VALIDATION_FAILED" as const;
  readonly artifactRoot: string;
  readonly operation: ArtifactFilesystemOperation;
  readonly path: string;
  readonly reason: ArtifactPathValidationReason;
  readonly resolvedPath: string | null;

  constructor(input: {
    artifactRoot: string;
    operation: ArtifactFilesystemOperation;
    path: string;
    reason: ArtifactPathValidationReason;
    resolvedPath?: string | null;
  }) {
    super(
      `artifact path validation failed (${input.reason}) during ${input.operation}: ${input.path}`,
    );
    this.name = "ArtifactPathValidationError";
    this.artifactRoot = input.artifactRoot;
    this.operation = input.operation;
    this.path = input.path;
    this.reason = input.reason;
    this.resolvedPath = input.resolvedPath ?? null;
  }
}

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const NonLiveEvidenceModeSchema = z.enum([
  "fixture",
  "mocked",
  "simulated",
]);
const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== ".." && segment !== ""),
    "artifact paths must be normalized relative paths",
  );

export const EvalRunConfigSchema = z
  .object({
    runnerVersion: z.literal(EVAL_RUNNER_VERSION),
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    protocolSchemaHash: z.literal(BENCHMARK_PROTOCOL_SCHEMA_HASH),
    conditionMatrixHash: z.literal(CONDITION_MATRIX_HASH),
    promptManifestHash: z.literal(
      FROZEN_CONSUMER_EDGE.promptManifestHash,
    ),
    runId: IdSchema,
    rerunOfRunId: IdSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    trialId: z.string().min(1),
    benchmarkConfig: BenchmarkConfigSchema,
    evidenceMode: NonLiveEvidenceModeSchema,
    reportingUse: z.literal("development"),
    resultClass: z.literal("smoke_only"),
    headlineEligible: z.literal(false),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.runId === config.rerunOfRunId) {
      context.addIssue({
        code: "custom",
        path: ["rerunOfRunId"],
        message: "a run cannot be its own rerun parent",
      });
    }
    if (config.benchmarkConfig.evidenceMode !== config.evidenceMode) {
      context.addIssue({
        code: "custom",
        path: ["evidenceMode"],
        message:
          "runner evidence mode must match the frozen benchmark configuration",
      });
    }
    if (
      config.benchmarkConfig.protocolSchemaHash !==
        config.protocolSchemaHash ||
      config.benchmarkConfig.conditionMatrixHash !==
        config.conditionMatrixHash ||
      config.benchmarkConfig.promptManifestHash !==
        config.promptManifestHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["benchmarkConfig"],
        message:
          "benchmark configuration does not match the runner protocol packet",
      });
    }
    if (!config.benchmarkConfig.trialPlan.trialIds.includes(config.trialId)) {
      context.addIssue({
        code: "custom",
        path: ["trialId"],
        message: "trialId is not present in the frozen trial plan",
      });
    }
  });

export type EvalRunConfig = z.infer<typeof EvalRunConfigSchema>;

const RequestMetadataInputSchema = z
  .object({
    runId: IdSchema,
    attemptId: IdSchema,
    trialId: z.string().min(1),
    evidenceMode: NonLiveEvidenceModeSchema,
    requestedAt: z.iso.datetime({ offset: true }),
    requestedProvider: z.string().min(1),
    requestedModelId: z.string().min(1),
    providerRequestId: z.string().min(1).nullable(),
    seed: z.number().int().nullable(),
    generation: z
      .object({
        maxOutputTokens: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
        temperature: z.number().min(0).max(2),
        topP: z.number().positive().max(1),
        responseFormat: z.literal("json_schema"),
        seedPolicy: z.enum(["supported", "unsupported"]),
      })
      .strict(),
    promptManifestHash: HashSchema,
  })
  .strict();

function requestHashPayload(
  request: z.infer<typeof RequestMetadataInputSchema>,
) {
  return {
    runnerVersion: EVAL_RUNNER_VERSION,
    ...request,
  };
}

export const RequestMetadataSchema = RequestMetadataInputSchema.extend({
  requestHash: HashSchema,
})
  .strict()
  .superRefine((request, context) => {
    const { requestHash, ...withoutHash } = request;
    if (requestHash !== canonicalSha256(requestHashPayload(withoutHash))) {
      context.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "requestHash does not match immutable request metadata",
      });
    }
  });

export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;

export function createRequestMetadata(input: unknown): RequestMetadata {
  const candidate = structuredClone(
    (input ?? {}) as Record<string, unknown>,
  );
  delete candidate.requestHash;
  const parsed = RequestMetadataInputSchema.parse(candidate);
  return RequestMetadataSchema.parse({
    ...parsed,
    requestHash: canonicalSha256(requestHashPayload(parsed)),
  });
}

const FailureSchema = z
  .object({
    kind: z.enum([
      "provider_transport",
      "provider_timeout",
      "invalid_structured_output",
      "fixture_failure",
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
    providerCode: z.string().min(1).nullable(),
  })
  .strict();

const RawAttemptBaseSchema = z.object({
  schemaVersion: z.literal(EVAL_RUNNER_VERSION),
  runId: IdSchema,
  attemptId: IdSchema,
  attemptNumber: z.number().int().positive(),
  trialId: z.string().min(1),
  evidenceMode: NonLiveEvidenceModeSchema,
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  latencyMs: z.number().int().nonnegative(),
  request: RequestMetadataSchema,
});

export const RawAttemptSchema = z
  .discriminatedUnion("status", [
    RawAttemptBaseSchema.extend({
      status: z.literal("succeeded"),
      rawOutput: z.json(),
      failure: z.null(),
    }).strict(),
    RawAttemptBaseSchema.extend({
      status: z.literal("failed"),
      rawOutput: z.json().nullable(),
      failure: FailureSchema,
    }).strict(),
  ])
  .superRefine((attempt, context) => {
    if (
      attempt.request.runId !== attempt.runId ||
      attempt.request.attemptId !== attempt.attemptId ||
      attempt.request.trialId !== attempt.trialId ||
      attempt.request.evidenceMode !== attempt.evidenceMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "request metadata does not identify its enclosing attempt",
      });
    }
    if (
      new Date(attempt.completedAt).getTime() <
      new Date(attempt.startedAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "attempt completion cannot precede its start",
      });
    }
  });

export type RawAttempt = z.infer<typeof RawAttemptSchema>;

const ParsedAttemptBaseSchema = z.object({
  schemaVersion: z.literal(EVAL_RUNNER_VERSION),
  runId: IdSchema,
  attemptId: IdSchema,
  attemptNumber: z.number().int().positive(),
  trialId: z.string().min(1),
  evidenceMode: NonLiveEvidenceModeSchema,
});

export const ParsedAttemptSchema = z
  .discriminatedUnion("parseStatus", [
    ParsedAttemptBaseSchema.extend({
      parseStatus: z.literal("valid"),
      canonicalRun: ResearchRunSchema,
      canonicalRunHash: HashSchema,
      validationIssues: z.array(z.string()).length(0),
    }).strict(),
    ParsedAttemptBaseSchema.extend({
      parseStatus: z.literal("invalid"),
      canonicalRun: z.null(),
      canonicalRunHash: z.null(),
      validationIssues: z.array(z.string().min(1)).min(1),
    }).strict(),
    ParsedAttemptBaseSchema.extend({
      parseStatus: z.literal("not_parsed"),
      canonicalRun: z.null(),
      canonicalRunHash: z.null(),
      validationIssues: z.array(z.string()).length(0),
    }).strict(),
  ])
  .superRefine((attempt, context) => {
    if (
      attempt.parseStatus === "valid" &&
      attempt.canonicalRunHash !== canonicalSha256(attempt.canonicalRun)
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonicalRunHash"],
        message: "canonicalRunHash does not match the parsed canonical run",
      });
    }
  });

export type ParsedAttempt = z.infer<typeof ParsedAttemptSchema>;

export function createValidParsedAttempt(
  input: Omit<
    Extract<ParsedAttempt, { parseStatus: "valid" }>,
    "parseStatus" | "canonicalRunHash"
  > & {
    parseStatus?: "valid";
  },
): Extract<ParsedAttempt, { parseStatus: "valid" }> {
  return ParsedAttemptSchema.parse({
    ...structuredClone(input),
    parseStatus: "valid",
    canonicalRunHash: canonicalSha256(input.canonicalRun),
  }) as Extract<ParsedAttempt, { parseStatus: "valid" }>;
}

export const RecordedAttemptSchema = z
  .object({
    raw: RawAttemptSchema,
    parsed: ParsedAttemptSchema,
  })
  .strict()
  .superRefine(({ raw, parsed }, context) => {
    if (
      raw.runId !== parsed.runId ||
      raw.attemptId !== parsed.attemptId ||
      raw.attemptNumber !== parsed.attemptNumber ||
      raw.trialId !== parsed.trialId ||
      raw.evidenceMode !== parsed.evidenceMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["parsed"],
        message: "raw and parsed artifacts must identify the same attempt",
      });
    }
    if (raw.status === "succeeded" && parsed.parseStatus !== "valid") {
      context.addIssue({
        code: "custom",
        path: ["parsed", "parseStatus"],
        message: "a succeeded attempt requires a valid canonical parse",
      });
    }
    if (raw.status === "failed" && parsed.parseStatus === "valid") {
      context.addIssue({
        code: "custom",
        path: ["parsed", "parseStatus"],
        message: "a failed attempt cannot contain a valid canonical parse",
      });
    }
  });

export type RecordedAttempt = z.infer<typeof RecordedAttemptSchema>;

export const SmokeMetricsSchema = z
  .object({
    schemaVersion: z.literal(EVAL_RUNNER_VERSION),
    runnerVersion: z.literal(EVAL_RUNNER_VERSION),
    runId: IdSchema,
    evidenceMode: NonLiveEvidenceModeSchema,
    reportingUse: z.literal("development"),
    resultClass: z.literal("smoke_only"),
    headlineEligible: z.literal(false),
    counts: z
      .object({
        attempted: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        parsedValid: z.number().int().nonnegative(),
        parsedInvalid: z.number().int().nonnegative(),
        notParsed: z.number().int().nonnegative(),
      })
      .strict(),
    totalLatencyMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((metrics, context) => {
    if (
      metrics.counts.attempted !==
        metrics.counts.succeeded + metrics.counts.failed ||
      metrics.counts.attempted !==
        metrics.counts.parsedValid +
          metrics.counts.parsedInvalid +
          metrics.counts.notParsed
    ) {
      context.addIssue({
        code: "custom",
        path: ["counts"],
        message: "smoke metric counts must reconcile to attempted artifacts",
      });
    }
  });

export type SmokeMetrics = z.infer<typeof SmokeMetricsSchema>;

export const AnnotationPlaceholderSchema = z
  .object({
    schemaVersion: z.literal(EVAL_RUNNER_VERSION),
    runId: IdSchema,
    evidenceMode: NonLiveEvidenceModeSchema,
    status: z.literal("awaiting_human_annotation"),
    randomizedConditionLabel: z.null(),
    graderId: z.null(),
    annotations: z.tuple([]),
  })
  .strict();

const ArtifactIndexEntrySchema = z
  .object({
    path: RelativeArtifactPathSchema,
    sha256: HashSchema,
    kind: z.enum([
      "raw_attempt",
      "parsed_attempt",
      "smoke_metrics_json",
      "smoke_metrics_csv",
      "annotation_placeholder",
    ]),
  })
  .strict();

export const RunManifestSchema = z
  .object({
    schemaVersion: z.literal(EVAL_RUNNER_VERSION),
    runnerVersion: z.literal(EVAL_RUNNER_VERSION),
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    protocolSchemaHash: z.literal(BENCHMARK_PROTOCOL_SCHEMA_HASH),
    conditionMatrixHash: z.literal(CONDITION_MATRIX_HASH),
    promptManifestHash: z.literal(
      FROZEN_CONSUMER_EDGE.promptManifestHash,
    ),
    runId: IdSchema,
    rerunOfRunId: IdSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    caseReference: z
      .object({
        id: IdSchema,
        version: z.string().min(1),
        caseHash: HashSchema,
        path: RelativeArtifactPathSchema,
      })
      .strict(),
    benchmarkConfigId: IdSchema,
    configHash: HashSchema,
    conditionId: z.enum([
      "strong_baseline",
      "complete_workflow",
      "no_verification",
      "no_adversarial_review",
    ]),
    trialId: z.string().min(1),
    attemptIds: z.array(IdSchema).min(1),
    evidenceMode: NonLiveEvidenceModeSchema,
    reportingUse: z.literal("development"),
    resultClass: z.literal("smoke_only"),
    headlineEligible: z.literal(false),
    complete: z.literal(true),
    artifacts: z
      .array(ArtifactIndexEntrySchema)
      .min(1)
      .refine(
        (artifacts) =>
          artifacts.every(
            ({ path }, index) =>
              index === 0 || artifacts[index - 1]!.path < path,
          ),
        "artifact index must be sorted by path",
      ),
  })
  .strict();

export type RunManifest = z.infer<typeof RunManifestSchema>;

type ArtifactKind = z.infer<typeof ArtifactIndexEntrySchema>["kind"];

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown): string {
  return `${canonicalizeJson(value)}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function isPathContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(
    comparablePath(root),
    comparablePath(candidate),
  );
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

function containmentError(input: {
  artifactRoot: string;
  operation: ArtifactFilesystemOperation;
  path: string;
  reason: ArtifactPathValidationReason;
  resolvedPath?: string | null;
}): ArtifactPathValidationError {
  return new ArtifactPathValidationError(input);
}

async function inspectContainedPath(input: {
  artifactRoot: string;
  path: string;
  operation: ArtifactFilesystemOperation;
}): Promise<void> {
  const artifactRoot = resolve(input.artifactRoot);
  const candidate = resolve(input.path);
  if (!isPathContained(artifactRoot, candidate)) {
    throw containmentError({
      ...input,
      artifactRoot,
      path: candidate,
      reason: "lexical_escape",
    });
  }

  const pathFromRoot = relative(artifactRoot, candidate);
  const segments =
    pathFromRoot === "" ? [] : pathFromRoot.split(sep);
  let current = artifactRoot;

  for (const segment of segments) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (metadata.isSymbolicLink()) {
      throw containmentError({
        ...input,
        artifactRoot,
        path: current,
        reason: "reparse_point",
      });
    }

    const resolvedCurrent = await realpath(current);
    if (!isPathContained(artifactRoot, resolvedCurrent)) {
      throw containmentError({
        ...input,
        artifactRoot,
        path: current,
        reason: "realpath_escape",
        resolvedPath: resolvedCurrent,
      });
    }
    if (comparablePath(resolvedCurrent) !== comparablePath(current)) {
      throw containmentError({
        ...input,
        artifactRoot,
        path: current,
        reason: "observed_path_change",
        resolvedPath: resolvedCurrent,
      });
    }
  }
}

async function canonicalArtifactRoot(requestedRoot: string): Promise<{
  artifactRoot: string;
  requestedRoot: string;
}> {
  const requested = resolve(requestedRoot);
  const root = parse(requested).root;
  const segments = relative(root, requested)
    .split(sep)
    .filter((segment) => segment !== "");
  let current = root;

  const validateExistingDirectory = async (
    path: string,
  ): Promise<string> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw containmentError({
        artifactRoot: requested,
        operation: "initialize_root",
        path,
        reason: "reparse_point",
      });
    }
    if (!metadata.isDirectory()) {
      throw new Error(`artifact root ancestor is not a directory: ${path}`);
    }
    const resolvedPath = await realpath(path);
    if (comparablePath(resolvedPath) !== comparablePath(path)) {
      throw containmentError({
        artifactRoot: requested,
        operation: "initialize_root",
        path,
        reason: "observed_path_change",
        resolvedPath,
      });
    }
    return resolvedPath;
  };

  current = await validateExistingDirectory(root);
  let creatingMissingSegments = false;
  for (const segment of segments) {
    const candidate = join(current, segment);

    if (!creatingMissingSegments) {
      try {
        current = await validateExistingDirectory(candidate);
        continue;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
        creatingMissingSegments = true;
      }
    }

    try {
      await mkdir(candidate, { recursive: false });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    current = await validateExistingDirectory(candidate);
  }

  return { artifactRoot: current, requestedRoot: requested };
}

export async function assertArtifactPathContained(input: {
  artifactRoot: string;
  path: string;
  operation?: ArtifactFilesystemOperation;
}): Promise<void> {
  const roots = await canonicalArtifactRoot(input.artifactRoot);
  const requestedPath = resolve(input.path);
  if (!isPathContained(roots.requestedRoot, requestedPath)) {
    throw containmentError({
      artifactRoot: roots.artifactRoot,
      operation: input.operation ?? "inspect",
      path: requestedPath,
      reason: "lexical_escape",
    });
  }
  const canonicalPath = resolve(
    roots.artifactRoot,
    relative(roots.requestedRoot, requestedPath),
  );
  await inspectContainedPath({
    artifactRoot: roots.artifactRoot,
    path: canonicalPath,
    operation: input.operation ?? "inspect",
  });
}

export class ArtifactBoundary {
  private constructor(readonly artifactRoot: string) {}

  static async initialize(requestedRoot: string): Promise<ArtifactBoundary> {
    const { artifactRoot } = await canonicalArtifactRoot(requestedRoot);
    return new ArtifactBoundary(artifactRoot);
  }

  path(relativePath: string): string {
    const target = resolve(
      this.artifactRoot,
      ...relativePath.split("/"),
    );
    if (!isPathContained(this.artifactRoot, target)) {
      throw containmentError({
        artifactRoot: this.artifactRoot,
        operation: "inspect",
        path: target,
        reason: "lexical_escape",
      });
    }
    return target;
  }

  async inspect(
    path: string,
    operation: ArtifactFilesystemOperation,
  ): Promise<void> {
    await inspectContainedPath({
      artifactRoot: this.artifactRoot,
      path,
      operation,
    });
  }

  async ensureDirectory(
    path: string,
    options: { exclusive?: boolean } = {},
  ): Promise<void> {
    if (!isPathContained(this.artifactRoot, path)) {
      throw containmentError({
        artifactRoot: this.artifactRoot,
        operation: "create_directory",
        path,
        reason: "lexical_escape",
      });
    }
    const segments = relative(this.artifactRoot, path).split(sep);
    let current = this.artifactRoot;

    for (const [index, segment] of segments.entries()) {
      if (segment === "") continue;
      const parent = current;
      current = join(current, segment);
      const isFinal = index === segments.length - 1;

      await this.inspect(current, "create_directory");
      try {
        const metadata = await lstat(current);
        if (!metadata.isDirectory()) {
          throw new Error(`artifact path is not a directory: ${current}`);
        }
        if (options.exclusive && isFinal) {
          throw new Error(`run already exists at ${current}`);
        }
        continue;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }

      await this.inspect(parent, "create_directory");
      try {
        await mkdir(current, { recursive: false });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        await this.inspect(current, "create_directory");
        if (options.exclusive && isFinal) {
          throw new Error(`run already exists at ${current}`);
        }
      }
      await this.inspect(current, "create_directory");
    }
  }
}

async function writeBytesAtomicNoReplace(
  boundary: ArtifactBoundary,
  target: string,
  bytes: string,
): Promise<string> {
  await boundary.ensureDirectory(dirname(target));
  await boundary.inspect(target, "create_temporary_file");
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  await boundary.inspect(temporary, "create_temporary_file");
  let canonicalTemporary = temporary;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx");
    canonicalTemporary = await realpath(temporary);
    if (!isPathContained(boundary.artifactRoot, canonicalTemporary)) {
      throw containmentError({
        artifactRoot: boundary.artifactRoot,
        operation: "create_temporary_file",
        path: temporary,
        reason: "observed_path_change",
        resolvedPath: canonicalTemporary,
      });
    }
    await boundary.inspect(canonicalTemporary, "create_temporary_file");
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await boundary.inspect(dirname(target), "publish_file");
    await boundary.inspect(target, "publish_file");
    const canonicalParent = await realpath(dirname(target));
    if (!isPathContained(boundary.artifactRoot, canonicalParent)) {
      throw containmentError({
        artifactRoot: boundary.artifactRoot,
        operation: "publish_file",
        path: dirname(target),
        reason: "observed_path_change",
        resolvedPath: canonicalParent,
      });
    }
    const canonicalTarget = join(canonicalParent, basename(target));
    await boundary.inspect(canonicalTarget, "publish_file");
    await link(canonicalTemporary, canonicalTarget);
    try {
      await boundary.inspect(canonicalTarget, "publish_file");
    } catch (error) {
      await unlink(canonicalTarget).catch(() => undefined);
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(canonicalTemporary).catch(() => undefined);
    if (canonicalTemporary !== temporary) {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return sha256Bytes(bytes);
}

export async function writeJsonAtomicNoReplace(
  boundary: ArtifactBoundary,
  target: string,
  value: unknown,
): Promise<string> {
  return writeBytesAtomicNoReplace(
    boundary,
    target,
    jsonBytes(value),
  );
}

export async function readTextContained(
  boundary: ArtifactBoundary,
  path: string,
): Promise<string> {
  await boundary.inspect(path, "read_artifact");
  const handle = await open(path, "r");
  try {
    const canonicalPath = await realpath(path);
    if (!isPathContained(boundary.artifactRoot, canonicalPath)) {
      throw containmentError({
        artifactRoot: boundary.artifactRoot,
        operation: "read_artifact",
        path,
        reason: "realpath_escape",
        resolvedPath: canonicalPath,
      });
    }
    await boundary.inspect(canonicalPath, "read_artifact");
    const content = await handle.readFile("utf8");
    await boundary.inspect(path, "read_artifact");
    return content;
  } finally {
    await handle.close();
  }
}

export async function readJsonContained(
  boundary: ArtifactBoundary,
  path: string,
): Promise<unknown> {
  return JSON.parse(await readTextContained(boundary, path)) as unknown;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function ensureFrozenCase(
  boundary: ArtifactBoundary,
  benchmarkCase: EvalRunConfig["benchmarkConfig"]["case"],
): Promise<{ path: string; relativePath: string }> {
  const relativePath = [
    "cases",
    benchmarkCase.id,
    benchmarkCase.version,
    "case.json",
  ].join("/");
  const path = boundary.path(relativePath);
  await boundary.inspect(path, "read_artifact");
  const expected = jsonBytes(benchmarkCase);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== expected) {
      throw new Error(
        `frozen case conflict at ${benchmarkCase.id}/${benchmarkCase.version}`,
      );
    }
    return {
      path,
      relativePath,
    };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await writeBytesAtomicNoReplace(boundary, path, expected);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
    await boundary.inspect(path, "read_artifact");
    const existing = await readFile(path, "utf8");
    if (existing !== expected) {
      throw new Error(
        `frozen case conflict at ${benchmarkCase.id}/${benchmarkCase.version}`,
      );
    }
  }
  return {
    path,
    relativePath,
  };
}

function validateAttemptSet(
  config: EvalRunConfig,
  input: readonly RecordedAttempt[],
): RecordedAttempt[] {
  const attempts = z
    .array(RecordedAttemptSchema)
    .min(1)
    .parse(structuredClone(input));
  const attemptIds = new Set<string>();

  if (attempts.length > config.benchmarkConfig.retryPolicy.maximumAttempts) {
    throw new Error("attempt count exceeds the frozen retry policy");
  }

  for (const [index, attempt] of attempts.entries()) {
    if (attempt.raw.attemptNumber !== index + 1) {
      throw new Error("attempt numbers must be contiguous and ordered");
    }
    if (attemptIds.has(attempt.raw.attemptId)) {
      throw new Error("attempt IDs must be unique");
    }
    attemptIds.add(attempt.raw.attemptId);

    if (
      attempt.raw.runId !== config.runId ||
      attempt.raw.trialId !== config.trialId ||
      attempt.raw.evidenceMode !== config.evidenceMode
    ) {
      throw new Error("attempt does not match the validated runner config");
    }
    if (
      attempt.raw.request.requestedProvider !==
        config.benchmarkConfig.primaryModel.provider ||
      attempt.raw.request.requestedModelId !==
        config.benchmarkConfig.primaryModel.modelId ||
      attempt.raw.request.promptManifestHash !== config.promptManifestHash ||
      canonicalizeJson(attempt.raw.request.generation) !==
        canonicalizeJson(config.benchmarkConfig.generation)
    ) {
      throw new Error("request metadata drifted from benchmark configuration");
    }

    const trialIndex =
      config.benchmarkConfig.trialPlan.trialIds.indexOf(config.trialId);
    if (
      attempt.raw.request.seed !==
      config.benchmarkConfig.trialPlan.trialSeeds[trialIndex]
    ) {
      throw new Error("request seed drifted from the frozen trial plan");
    }

    if (attempt.parsed.parseStatus === "valid") {
      const canonicalRun = attempt.parsed.canonicalRun;
      if (
        canonicalRun.evidenceMode === "live" ||
        canonicalRun.evidenceMode !== attempt.parsed.evidenceMode
      ) {
        throw new Error(
          "canonical run evidence mode must match its non-live evaluation envelope",
        );
      }
      for (const execution of canonicalRun.executions) {
        if (
          execution.evidenceMode === "live" ||
          execution.evidenceMode !== canonicalRun.evidenceMode
        ) {
          throw new Error(
            "execution evidence mode must match its non-live canonical run",
          );
        }
      }
    }
  }
  return attempts;
}

function smokeMetrics(
  config: EvalRunConfig,
  attempts: readonly RecordedAttempt[],
): SmokeMetrics {
  return SmokeMetricsSchema.parse({
    schemaVersion: EVAL_RUNNER_VERSION,
    runnerVersion: EVAL_RUNNER_VERSION,
    runId: config.runId,
    evidenceMode: config.evidenceMode,
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
    counts: {
      attempted: attempts.length,
      succeeded: attempts.filter(({ raw }) => raw.status === "succeeded")
        .length,
      failed: attempts.filter(({ raw }) => raw.status === "failed").length,
      parsedValid: attempts.filter(
        ({ parsed }) => parsed.parseStatus === "valid",
      ).length,
      parsedInvalid: attempts.filter(
        ({ parsed }) => parsed.parseStatus === "invalid",
      ).length,
      notParsed: attempts.filter(
        ({ parsed }) => parsed.parseStatus === "not_parsed",
      ).length,
    },
    totalLatencyMs: attempts.reduce(
      (total, { raw }) => total + raw.latencyMs,
      0,
    ),
  });
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function smokeMetricsCsv(metrics: SmokeMetrics): string {
  const header = [
    "runner_version",
    "run_id",
    "evidence_mode",
    "reporting_use",
    "result_class",
    "headline_eligible",
    "attempted",
    "succeeded",
    "failed",
    "parsed_valid",
    "parsed_invalid",
    "not_parsed",
    "total_latency_ms",
  ];
  const row = [
    metrics.runnerVersion,
    metrics.runId,
    metrics.evidenceMode,
    metrics.reportingUse,
    metrics.resultClass,
    metrics.headlineEligible,
    metrics.counts.attempted,
    metrics.counts.succeeded,
    metrics.counts.failed,
    metrics.counts.parsedValid,
    metrics.counts.parsedInvalid,
    metrics.counts.notParsed,
    metrics.totalLatencyMs,
  ];
  return `${header.join(",")}\n${row.map(csvCell).join(",")}\n`;
}

async function readCompleteParent(
  boundary: ArtifactBoundary,
  config: EvalRunConfig,
): Promise<RunManifest | null> {
  if (config.rerunOfRunId === null) {
    return null;
  }
  const parentManifestPath = boundary.path(
    [
      "runs",
      EVAL_RUNNER_VERSION,
      config.rerunOfRunId,
      "manifest.json",
    ].join("/"),
  );
  try {
    await boundary.inspect(parentManifestPath, "read_artifact");
    const parent = RunManifestSchema.parse(
      await readJson(parentManifestPath),
    );
    if (
      parent.configHash !== config.benchmarkConfig.configHash ||
      parent.trialId !== config.trialId
    ) {
      throw new Error(
        "rerun parent uses a different benchmark configuration or trial",
      );
    }
    return parent;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("rerun parent is not a complete run");
    }
    if (error instanceof z.ZodError) {
      throw new Error("rerun parent is not a complete run");
    }
    throw error;
  }
}

async function createRunDirectory(
  boundary: ArtifactBoundary,
  path: string,
): Promise<void> {
  await boundary.ensureDirectory(path, { exclusive: true });
}

export async function materializeFixtureRun(input: {
  artifactRoot: string;
  config: EvalRunConfig;
  attempts: readonly RecordedAttempt[];
}): Promise<{
  artifactRoot: string;
  casePath: string;
  runPath: string;
  manifestPath: string;
}> {
  const config = EvalRunConfigSchema.parse(structuredClone(input.config));
  const attempts = validateAttemptSet(config, input.attempts);
  const boundary = await ArtifactBoundary.initialize(input.artifactRoot);
  const artifactRoot = boundary.artifactRoot;
  await readCompleteParent(boundary, config);
  const frozenCase = await ensureFrozenCase(
    boundary,
    config.benchmarkConfig.case,
  );

  const runPath = boundary.path(
    ["runs", EVAL_RUNNER_VERSION, config.runId].join("/"),
  );
  await createRunDirectory(boundary, runPath);

  const artifactIndex: Array<{
    path: string;
    sha256: string;
    kind: ArtifactKind;
  }> = [];
  const addArtifact = async (
    relativePath: string,
    bytes: string,
    kind: ArtifactKind,
  ) => {
    const sha256 = await writeBytesAtomicNoReplace(
      boundary,
      join(runPath, ...relativePath.split("/")),
      bytes,
    );
    artifactIndex.push({ path: relativePath, sha256, kind });
  };

  for (const attempt of attempts) {
    const sequence = String(attempt.raw.attemptNumber).padStart(3, "0");
    const filename = `attempt-${sequence}-${attempt.raw.attemptId}.json`;
    await addArtifact(
      `raw/${filename}`,
      jsonBytes(attempt.raw),
      "raw_attempt",
    );
    await addArtifact(
      `parsed/${filename}`,
      jsonBytes(attempt.parsed),
      "parsed_attempt",
    );
  }

  const metrics = smokeMetrics(config, attempts);
  await addArtifact(
    "metrics/smoke.json",
    jsonBytes(metrics),
    "smoke_metrics_json",
  );
  await addArtifact(
    "metrics/smoke.csv",
    smokeMetricsCsv(metrics),
    "smoke_metrics_csv",
  );

  const annotationPlaceholder = AnnotationPlaceholderSchema.parse({
    schemaVersion: EVAL_RUNNER_VERSION,
    runId: config.runId,
    evidenceMode: config.evidenceMode,
    status: "awaiting_human_annotation",
    randomizedConditionLabel: null,
    graderId: null,
    annotations: [],
  });
  await addArtifact(
    "annotations/placeholder.json",
    jsonBytes(annotationPlaceholder),
    "annotation_placeholder",
  );

  const manifest = RunManifestSchema.parse({
    schemaVersion: EVAL_RUNNER_VERSION,
    runnerVersion: EVAL_RUNNER_VERSION,
    protocolVersion: config.protocolVersion,
    protocolSchemaHash: config.protocolSchemaHash,
    conditionMatrixHash: config.conditionMatrixHash,
    promptManifestHash: config.promptManifestHash,
    runId: config.runId,
    rerunOfRunId: config.rerunOfRunId,
    createdAt: config.createdAt,
    caseReference: {
      id: config.benchmarkConfig.case.id,
      version: config.benchmarkConfig.case.version,
      caseHash: config.benchmarkConfig.case.caseHash,
      path: frozenCase.relativePath,
    },
    benchmarkConfigId: config.benchmarkConfig.id,
    configHash: config.benchmarkConfig.configHash,
    conditionId: config.benchmarkConfig.conditionId,
    trialId: config.trialId,
    attemptIds: attempts.map(({ raw }) => raw.attemptId),
    evidenceMode: config.evidenceMode,
    reportingUse: config.reportingUse,
    resultClass: config.resultClass,
    headlineEligible: config.headlineEligible,
    complete: true,
    artifacts: artifactIndex.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
  const manifestPath = join(runPath, "manifest.json");
  await writeJsonAtomicNoReplace(boundary, manifestPath, manifest);

  return {
    artifactRoot,
    casePath: frozenCase.path,
    runPath,
    manifestPath,
  };
}
