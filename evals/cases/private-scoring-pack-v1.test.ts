import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/contracts";
import * as privatePackModule from "./private-scoring-pack-v1";
import {
  assertPrivateScoringPackActive,
  loadFrozenPublicCorpusAuthority,
  loadPrivateScoringPack,
  revokePrivateScoringPack,
  scanPublicBlobsForPrivateValues as scanWithFrozenPublicCorpus,
} from "./private-scoring-pack-v1";
import {
  HELD_OUT_CASE_SET_MANIFEST,
  materializeHeldOutCaseSmoke,
} from "./held-out-v1";

const roots: string[] = [];
const TRUSTED_PUBLICATION_BASE_SHA =
  "5e9a639e0f40f417163ad613cf191f9228ddd7cf";
let frozenPublicCorpusAuthority: object | undefined;

function publicCorpusAuthority() {
  frozenPublicCorpusAuthority ??= loadFrozenPublicCorpusAuthority(
    process.cwd(),
    TRUSTED_PUBLICATION_BASE_SHA,
  );
  return frozenPublicCorpusAuthority;
}

function scanPublicBlobsForPrivateValues(
  path: string,
  expectedPublicSet: unknown,
  trustedPackFileHash: string,
  publicBlobPaths: readonly string[],
) {
  return scanWithFrozenPublicCorpus(
    path,
    expectedPublicSet,
    trustedPackFileHash,
    publicBlobPaths,
    publicCorpusAuthority(),
    process.cwd(),
  );
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "evidenceforge-private-pack-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function neutralPublicSet(suffix = "a") {
  const cases = Array.from({ length: 6 }, (_, index) => ({
    id: `neutral-public-${suffix}-${index + 1}`,
    version: "1.0.0",
  }));
  return {
    setHash: canonicalSha256({ suffix, cases }),
    cases,
  };
}

function neutralPack(publicSet = neutralPublicSet(), marker = "alpha") {
  const withoutHash = {
    formatVersion: "1.0.0",
    evidenceMode: "fixture",
    publicSetHash: publicSet.setHash,
    entries: publicSet.cases.map(({ id, version }, index) => {
      const privatePayload = {
        assessment: `neutral-assessment-${marker}-${index + 1}`,
        reviewNote: `neutral-review-note-${marker}-${index + 1}`,
        graderCanaries: [`neutral-grader-canaries-${marker}-${index + 1}`],
        relationshipVocabulary: [
          "neutral-matches",
          "neutral-differs",
          "neutral-unknown",
        ],
      };
      return {
        publicCaseId: id,
        publicCaseVersion: version,
        privatePayload,
        privatePayloadHash: canonicalSha256(privatePayload),
      };
    }),
    privateSetPayload: {
      excludedFixture: `neutral-excluded-${marker}`,
    },
    privateSetPayloadHash: canonicalSha256({
      excludedFixture: `neutral-excluded-${marker}`,
    }),
  };
  return { ...withoutHash, packHash: canonicalSha256(withoutHash) };
}

function refreshPack(pack: ReturnType<typeof neutralPack>) {
  for (const entry of pack.entries) {
    entry.privatePayloadHash = canonicalSha256(entry.privatePayload);
  }
  pack.privateSetPayloadHash = canonicalSha256(pack.privateSetPayload);
  const withoutHash = structuredClone(pack);
  Reflect.deleteProperty(withoutHash, "packHash");
  pack.packHash = canonicalSha256(withoutHash);
  return pack;
}

async function fileSha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writePack(root: string, name: string, pack: unknown) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(pack, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return path;
}

function expectPublicationScanIndeterminate(action: () => unknown) {
  let observed: unknown;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({
    name: "PublicationScanIndeterminateError",
    code: "PUBLICATION_SCAN_INDETERMINATE",
  });
  expect(String(observed)).toMatch(/publication scan.*(?:budget|indeterminate)/i);
}

describe("private scoring pack loader v1", () => {
  it("exports only opaque lifecycle and private-value scan operations", () => {
    expect(Object.keys(privatePackModule).sort()).toEqual([
      "assertPrivateScoringPackActive",
      "loadFrozenPublicCorpusAuthority",
      "loadPrivateScoringPack",
      "revokePrivateScoringPack",
      "scanPublicBlobsForPrivateValues",
    ]);
  });

  it(
    "pins an opaque public-corpus authority and rejects tamper, fakes, clones, proxies, accessors, and cross-repo use",
    async () => {
      const root = await temporaryRoot();
      const publicSet = neutralPublicSet();
      const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
      const candidatePath = join(root, "candidate.ts");
      await writeFile(candidatePath, "export const safe = true;\n", "utf8");
      const authority = loadFrozenPublicCorpusAuthority(
        process.cwd(),
        TRUSTED_PUBLICATION_BASE_SHA,
      );
      const trustedPackHash = await fileSha256(packPath);
      const scan = (candidateAuthority: unknown, repository = process.cwd()) =>
        scanWithFrozenPublicCorpus(
          packPath,
          publicSet,
          trustedPackHash,
          [candidatePath],
          candidateAuthority,
          repository,
        );

      expect(Object.isFrozen(authority)).toBe(true);
      expect(Reflect.ownKeys(authority)).toEqual([]);
      expect(scan(authority)).toEqual([]);
      expect(() => scan(structuredClone(authority))).toThrow(/authority/i);

      let proxyTraps = 0;
      const proxy = new Proxy(authority, {
        get() {
          proxyTraps += 1;
          throw new Error("proxy trap must not run");
        },
      });
      expect(() => scan(proxy)).toThrow(/authority/i);
      const accessor = Object.create(null, {
        publicValues: {
          get() {
            proxyTraps += 1;
            throw new Error("accessor trap must not run");
          },
        },
      });
      expect(() => scan(accessor)).toThrow(/authority/i);
      expect(proxyTraps).toBe(0);

      execFileSync("git", ["init", root], { stdio: "ignore" });
      expect(() =>
        loadFrozenPublicCorpusAuthority(root, TRUSTED_PUBLICATION_BASE_SHA),
      ).toThrow(/frozen public corpus identity/i);
      expect(() => scan(authority, root)).toThrow(/another repository/i);

      const repositoryRootCommit = execFileSync(
        "git",
        ["rev-list", "--max-parents=0", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      expect(() =>
        loadFrozenPublicCorpusAuthority(process.cwd(), repositoryRootCommit),
      ).toThrow(/publication base identity/i);
      expect(() =>
        loadFrozenPublicCorpusAuthority(
          process.cwd(),
          "eb3c8ac0b029d8e185dd3c46746388bada33be47",
        ),
      ).toThrow(/publication base identity/i);
    },
    15_000,
  );

  it("fails closed for missing, malformed, wrong-set, and tampered packs", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    expect(() =>
      loadPrivateScoringPack(
        join(root, "missing.json"),
        publicSet,
        "0".repeat(64),
      ),
    ).toThrow(/private scoring pack/i);

    const malformed = await writePack(root, "malformed.json", { nope: true });
    const malformedHash = await fileSha256(malformed);
    expect(() =>
      loadPrivateScoringPack(malformed, publicSet, malformedHash),
    ).toThrow(
      /private scoring pack/i,
    );

    const wrongSetPack = neutralPack(neutralPublicSet("other"));
    const wrongSet = await writePack(root, "wrong-set.json", wrongSetPack);
    const wrongSetHash = await fileSha256(wrongSet);
    expect(() =>
      loadPrivateScoringPack(wrongSet, publicSet, wrongSetHash),
    ).toThrow(
      /public case set/i,
    );

    const tamperedPack = neutralPack(publicSet);
    tamperedPack.entries[0]!.privatePayload.assessment = "tampered-value";
    const tampered = await writePack(root, "tampered.json", tamperedPack);
    const tamperedHash = await fileSha256(tampered);
    expect(() =>
      loadPrivateScoringPack(tampered, publicSet, tamperedHash),
    ).toThrow(
      /hash/i,
    );
  });

  it("rejects coherently re-hashed tampering without the trusted file identity", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const originalPath = await writePack(
      root,
      "original.json",
      neutralPack(publicSet),
    );
    const trustedPackHash = await fileSha256(originalPath);
    const modified = neutralPack(publicSet);
    modified.entries[0]!.privatePayload.assessment = "coherently-modified";
    modified.entries[0]!.privatePayloadHash = canonicalSha256(
      modified.entries[0]!.privatePayload,
    );
    const modifiedWithoutHash = structuredClone(modified);
    Reflect.deleteProperty(modifiedWithoutHash, "packHash");
    modified.packHash = canonicalSha256(modifiedWithoutHash);
    const modifiedPath = await writePack(root, "modified.json", modified);

    expect(() =>
      loadPrivateScoringPack(modifiedPath, publicSet, trustedPackHash),
    ).toThrow(/trusted private scoring pack identity/i);
  });

  it("keeps state opaque and rejects clones, proxies, cross-bundle use, and revoked handles", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const otherSet = neutralPublicSet("other");
    const path = await writePack(root, "valid.json", neutralPack(publicSet));
    const trustedHash = await fileSha256(path);
    const handle = loadPrivateScoringPack(path, publicSet, trustedHash);

    expect(Object.isFrozen(handle)).toBe(true);
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(JSON.stringify(handle)).toBe("{}");
    expect(() =>
      assertPrivateScoringPackActive(handle, publicSet, trustedHash),
    ).not.toThrow();
    expect(() =>
      assertPrivateScoringPackActive(
        structuredClone(handle),
        publicSet,
        trustedHash,
      ),
    ).toThrow(/authority/i);
    expect(() =>
      assertPrivateScoringPackActive(
        new Proxy(handle, {}),
        publicSet,
        trustedHash,
      ),
    ).toThrow(/authority/i);
    expect(() =>
      assertPrivateScoringPackActive(handle, otherSet, trustedHash),
    ).toThrow(/public case set/i);
    expect(() =>
      assertPrivateScoringPackActive(handle, publicSet, "f".repeat(64)),
    ).toThrow(/another trusted pack/i);

    revokePrivateScoringPack(handle);
    expect(() =>
      assertPrivateScoringPackActive(handle, publicSet, trustedHash),
    ).toThrow(/revoked/i);
    expect(() => revokePrivateScoringPack(handle)).toThrow(/revoked/i);
  });

  it("is read-only and leaves public identity independent of private bundle changes", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const leftPath = await writePack(root, "left.json", neutralPack(publicSet));
    const rightPath = await writePack(
      root,
      "right.json",
      neutralPack(publicSet, "beta"),
    );
    const before = await Promise.all([
      readFile(leftPath, "utf8"),
      readFile(rightPath, "utf8"),
    ]);
    const publicIdentityBefore = canonicalSha256(publicSet);

    const leftHash = await fileSha256(leftPath);
    const rightHash = await fileSha256(rightPath);
    const left = loadPrivateScoringPack(leftPath, publicSet, leftHash);
    const right = loadPrivateScoringPack(rightPath, publicSet, rightHash);
    expect(() =>
      assertPrivateScoringPackActive(left, publicSet, leftHash),
    ).not.toThrow();
    expect(() =>
      assertPrivateScoringPackActive(right, publicSet, rightHash),
    ).not.toThrow();
    expect(canonicalSha256(publicSet)).toBe(publicIdentityBefore);
    expect(await Promise.all([readFile(leftPath, "utf8"), readFile(rightPath, "utf8")])).toEqual(before);
  });

  it("rejects same-public-set cross-bundle substitution", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const leftPath = await writePack(root, "left.json", neutralPack(publicSet));
    const rightPath = await writePack(
      root,
      "right.json",
      neutralPack(publicSet, "beta"),
    );
    const trustedLeftHash = await fileSha256(leftPath);
    const trustedRightHash = await fileSha256(rightPath);

    expect(() =>
      loadPrivateScoringPack(rightPath, publicSet, trustedLeftHash),
    ).toThrow(/trusted private scoring pack identity/i);
    const right = loadPrivateScoringPack(
      rightPath,
      publicSet,
      trustedRightHash,
    );
    expect(() =>
      assertPrivateScoringPackActive(right, publicSet, trustedLeftHash),
    ).toThrow(/another trusted pack/i);
  });

  it("leaves public case, model, runner, and config hashes unchanged across private pack changes", async () => {
    const root = await temporaryRoot();
    const publicSet = {
      setHash: HELD_OUT_CASE_SET_MANIFEST.setHash,
      cases: HELD_OUT_CASE_SET_MANIFEST.cases.map(
        ({ caseId: id, caseVersion: version }) => ({ id, version }),
      ),
    };
    const publicHashesBefore = HELD_OUT_CASE_SET_MANIFEST.cases.map(
      ({ caseHash, modelInputHash }) => ({ caseHash, modelInputHash }),
    );
    const leftPack = await writePack(root, "heldout-left.json", neutralPack(publicSet));
    const rightPack = await writePack(
      root,
      "heldout-right.json",
      neutralPack(publicSet, "beta"),
    );
    const caseId = HELD_OUT_CASE_SET_MANIFEST.cases[0]!.caseId;
    const leftArtifacts = await materializeHeldOutCaseSmoke(
      join(root, "left-artifacts"),
      caseId,
    );
    loadPrivateScoringPack(leftPack, publicSet, await fileSha256(leftPack));
    const rightArtifacts = await materializeHeldOutCaseSmoke(
      join(root, "right-artifacts"),
      caseId,
    );
    loadPrivateScoringPack(rightPack, publicSet, await fileSha256(rightPack));

    const [leftManifest, rightManifest, leftCase, rightCase] = await Promise.all([
      readFile(leftArtifacts.manifestPath, "utf8"),
      readFile(rightArtifacts.manifestPath, "utf8"),
      readFile(leftArtifacts.casePath, "utf8"),
      readFile(rightArtifacts.casePath, "utf8"),
    ]);
    expect(rightManifest).toBe(leftManifest);
    expect(rightCase).toBe(leftCase);
    expect(
      HELD_OUT_CASE_SET_MANIFEST.cases.map(
        ({ caseHash, modelInputHash }) => ({ caseHash, modelInputHash }),
      ),
    ).toEqual(publicHashesBefore);
  });

  it(
    "recursively reports private values without returning the values themselves",
    async () => {
      const root = await temporaryRoot();
      const publicSet = neutralPublicSet();
      const packPath = await writePack(
        root,
        "pack.json",
        neutralPack(publicSet),
      );
      const cleanPath = join(root, "clean.ts");
      const canaryLeakPath = join(root, "canary-leak.ts");
      const leakPath = join(root, "leak.ts");
      await writeFile(cleanPath, "export const publicValue = 'safe';\n", "utf8");
      await writeFile(
        canaryLeakPath,
        "export const leakedCanary = 'neutral-grader-canaries-alpha-1';\n",
        "utf8",
      );
      await writeFile(
        leakPath,
        "export const leaked = 'neutral-review-note-alpha-1';\n",
        "utf8",
      );

      const findings = scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [cleanPath, canaryLeakPath, leakPath],
      );
      expect(findings).toEqual([
        { path: canaryLeakPath, category: "private-value" },
        { path: leakPath, category: "private-value" },
      ]);
      expect(JSON.stringify(findings)).not.toContain("neutral-review-note");
    },
    15_000,
  );

  it("subtracts exact vocabulary independently present in the frozen public corpus", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)[
      "privateFrozenValue"
    ] = "relationship";
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(candidatePath, "relationship\n", "utf8");

    const findings = scanPublicBlobsForPrivateValues(
      packPath,
      publicSet,
      await fileSha256(packPath),
      [candidatePath],
    );

    expect(findings).toEqual([]);
  });

  it("does not let a caller-supplied corpus bless a private scalar", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    const privateScalar = "neutral-review-note-alpha-1";
    await writeFile(
      candidatePath,
      `export const leaked = '${privateScalar}';\n`,
      "utf8",
    );
    const trustedPackHash = await fileSha256(packPath);

    expect(() =>
      scanWithFrozenPublicCorpus(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePath],
        [privateScalar],
        process.cwd(),
      ),
    ).toThrow(/frozen public corpus authority/i);
    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a private scoring property name even when its value is absent", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)[
      "privateScoringSwitch"
    ] = "ordinary-neutral-value";
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      "export const privateScoringSwitch = true;\n",
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a private development Id value instead of exempting it by suffix", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    const privateDevelopmentId = "neutral-development-private-case-1";
    (pack.entries[0]!.privatePayload as Record<string, unknown>)[
      "developmentCaseId"
    ] = privateDevelopmentId;
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      `export const leakedDevelopmentId = '${privateDevelopmentId}';\n`,
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports an equivalent private composite after its properties are reordered", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const sourceCandidatePath = join(root, "candidate.ts");
    const percentCandidatePath = join(root, "candidate-percent.txt");
    const escapedCandidatePath = join(root, "candidate-escaped.json");
    await writeFile(
      sourceCandidatePath,
      "export const reordered = { relationship: { version: 'relationship', id: 'fixture' } };\n",
      "utf8",
    );
    await writeFile(
      percentCandidatePath,
      encodeURIComponent(
        JSON.stringify({
          relationship: { version: "relationship", id: "fixture" },
        }),
      ),
      "utf8",
    );
    await writeFile(
      escapedCandidatePath,
      '{"relationship":{"version":"rel\\u0061tionship","id":"fixture"}}\n',
      "utf8",
    );
    const candidatePaths = [
      sourceCandidatePath,
      percentCandidatePath,
      escapedCandidatePath,
    ].sort();

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        candidatePaths,
      ),
    ).toEqual(
      candidatePaths.map((path) => ({ path, category: "private-value" })),
    );
  });

  it("reports an identical private composite under a renamed outer field", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      "export const renamed = { wrapper: { version: 'relationship', id: 'fixture' } };\n",
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a private composite assembled from const bindings and shorthand", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      [
        "const id = 'fixture';",
        "const version = 'relationship';",
        "const assembled = { version, id };",
        "export const renamed = { wrapper: assembled };",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("materializes bounded aliases, property access, computed keys, spreads, arrays, and concatenation", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const sources = [
      [
        "const id = 'fix' + 'ture';",
        "const suffix = 'ship';",
        "const version = `relation${suffix}`;",
        "const idPart = { id };",
        "const versionKey = 'version';",
        "const merged = { ...idPart, [versionKey]: version };",
        "const alias = merged;",
        "export const wrapper = { renamed: alias };",
      ],
      [
        "const source = { version: 'relationship', id: 'fixture' };",
        "const assembled = { id: source.id, version: source['version'] };",
        "export const wrapper = { nested: { renamed: assembled } };",
      ],
      [
        "const id = 'fixture';",
        "const version = 'relationship';",
        "const assembled = { version, id };",
        "const items = [...[assembled]];",
        "export const wrapper = { items };",
      ],
    ];
    const candidatePaths = await Promise.all(
      sources.map(async (lines, index) => {
        const path = join(root, `candidate-graph-${index + 1}.ts`);
        await writeFile(path, `${lines.join("\n")}\n`, "utf8");
        return path;
      }),
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        candidatePaths,
      ),
    ).toEqual(
      candidatePaths
        .sort()
        .map((path) => ({ path, category: "private-value" })),
    );
  });

  it("fails closed when the AST traversal budget is exhausted before a private composite", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate-node-budget.ts");
    const harmless = Array.from(
      { length: 5_000 },
      (_, index) => `const harmless${index} = ${index};`,
    );
    await writeFile(
      candidatePath,
      [
        ...harmless,
        "export const leaked = { version: 'relationship', id: 'fixture' };",
        "",
      ].join("\n"),
      "utf8",
    );
    const trustedPackHash = await fileSha256(packPath);

    expect(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePath],
      ),
    ).toThrow(/publication scan.*(?:budget|indeterminate)/i);
  });

  it("fails closed when a private composite exceeds the static alias depth budget", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePath = join(root, "candidate-alias-budget.ts");
    const aliases = Array.from(
      { length: 40 },
      (_, index) => `const part${index + 1} = { ...part${index} };`,
    );
    await writeFile(
      candidatePath,
      [
        "const part0 = { id: 'fixture' };",
        ...aliases,
        "export const leaked = { ...part40, version: 'relationship' };",
        "",
      ].join("\n"),
      "utf8",
    );
    const trustedPackHash = await fileSha256(packPath);

    expect(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePath],
      ),
    ).toThrow(/publication scan.*(?:budget|indeterminate)/i);
  });

  it("enforces the AST node boundary at boundary minus one, boundary, and boundary plus one", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const trustedPackHash = await fileSha256(packPath);
    const candidatePaths = await Promise.all(
      [16_381, 16_382, 16_383].map(async (emptyStatements, index) => {
        const path = join(root, `candidate-ast-${index + 1}.ts`);
        await writeFile(path, ";".repeat(emptyStatements), "utf8");
        return path;
      }),
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[0]!],
      ),
    ).toEqual([]);
    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[1]!],
      ),
    ).toEqual([]);
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[2]!],
      ),
    );

    const largeLegitimatePath = join(root, "candidate-large-legitimate.ts");
    await writeFile(
      largeLegitimatePath,
      [
        ...Array.from(
          { length: 3_000 },
          (_, index) => `const publicValue${index} = ${index};`,
        ),
        "export const publicResult = { state: 'safe' };",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [largeLegitimatePath],
      ),
    ).toEqual([]);
  });

  it("enforces the static alias boundary at boundary minus one, boundary, and boundary plus one", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const trustedPackHash = await fileSha256(packPath);
    const candidatePaths = await Promise.all(
      [31, 32, 33].map(async (aliasCount) => {
        const path = join(root, `candidate-alias-${aliasCount}.ts`);
        const aliases = Array.from(
          { length: aliasCount },
          (_, index) => `const part${index + 1} = { ...part${index} };`,
        );
        await writeFile(
          path,
          [
            "const part0 = { id: 'fixture' };",
            ...aliases,
            `export const leaked = { ...part${aliasCount}, version: 'relationship' };`,
            "",
          ].join("\n"),
          "utf8",
        );
        return path;
      }),
    );

    for (const path of candidatePaths.slice(0, 2)) {
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([{ path, category: "private-value" }]);
    }
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[2]!],
      ),
    );
  });

  it("enforces the static materialization-node boundary without discarding work", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const trustedPackHash = await fileSha256(packPath);
    const candidatePaths = await Promise.all(
      [4_094, 4_095, 4_096].map(async (elementCount) => {
        const path = join(root, `candidate-materialize-${elementCount}.ts`);
        await writeFile(
          path,
          `export const safe = [${"null,".repeat(elementCount)}];\n`,
          "utf8",
        );
        return path;
      }),
    );

    for (const path of candidatePaths.slice(0, 2)) {
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([]);
    }
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[2]!],
      ),
    );
  });

  it("enforces the static materialization-depth boundary exactly", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const trustedPackHash = await fileSha256(packPath);
    const candidatePaths = await Promise.all(
      [127, 128, 129].map(async (depth) => {
        const path = join(root, `candidate-depth-${depth}.ts`);
        await writeFile(
          path,
          `export const safe = ${"[".repeat(depth)}null${"]".repeat(depth)};\n`,
          "utf8",
        );
        return path;
      }),
    );

    for (const path of candidatePaths.slice(0, 2)) {
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([]);
    }
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [candidatePaths[2]!],
      ),
    );
  });

  it("enforces the unresolved-structure boundary while fully scanning opaque branches", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const trustedPackHash = await fileSha256(packPath);
    const repeatedCalls = "unknownCall(),".repeat(2_047);
    const boundaryPaths = await Promise.all(
      ["", "unbound", "unbound,secondUnbound"].map(async (tail, index) => {
        const path = join(root, `candidate-unresolved-${index + 1}.ts`);
        await writeFile(
          path,
          `export const safe = [${repeatedCalls}${tail}];\n`,
          "utf8",
        );
        return path;
      }),
    );

    for (const path of boundaryPaths.slice(0, 2)) {
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([]);
    }
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [boundaryPaths[2]!],
      ),
    );

    for (const [name, source] of [
      ["object-spread", "export const opaque = { ...unknownRecord };\n"],
      ["array-spread", "export const opaque = [...unknownItems];\n"],
      ["computed", "export const opaque = { [unknownKey()]: 'safe' };\n"],
    ] as const) {
      const path = join(root, `candidate-${name}.ts`);
      await writeFile(path, source, "utf8");
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([]);
    }
  });

  it("fails closed for source and decoded-expansion limits that callers cannot raise", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const trustedPackHash = await fileSha256(packPath);
    const belowLimitPath = join(root, "candidate-source-below-limit.ts");
    const atLimitPath = join(root, "candidate-source-at-limit.ts");
    const aboveLimitPath = join(root, "candidate-source-above-limit.ts");
    const expandedPath = join(root, "candidate-decoded-expansion.ts");
    await writeFile(belowLimitPath, `/*${"a".repeat(262_139)}*/`, "utf8");
    await writeFile(atLimitPath, `/*${"a".repeat(262_140)}*/`, "utf8");
    await writeFile(aboveLimitPath, `/*${"a".repeat(262_141)}*/`, "utf8");
    await writeFile(
      expandedPath,
      `/*${"%41\\u0041&#65;".repeat(15_000)}*/`,
      "utf8",
    );

    for (const path of [belowLimitPath, atLimitPath]) {
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [path],
        ),
      ).toEqual([]);
    }
    const scannerWithIgnoredConfiguration = scanWithFrozenPublicCorpus as unknown as (
      ...args: unknown[]
    ) => unknown;
    expectPublicationScanIndeterminate(() =>
      scannerWithIgnoredConfiguration(
        packPath,
        publicSet,
        trustedPackHash,
        [aboveLimitPath],
        publicCorpusAuthority(),
        process.cwd(),
        { maxSourceBytes: Number.MAX_SAFE_INTEGER },
      ),
    );
    expectPublicationScanIndeterminate(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        trustedPackHash,
        [expandedPath],
      ),
    );
  });

  it("flags unresolved cyclic and dynamic composites without executing candidate code", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const sources = [
      [
        "const left = right;",
        "const right = left;",
        "export const wrapper = { id: 'fixture', version: left };",
      ],
      [
        "const dynamic = neverExecute();",
        "export const wrapper = { version: dynamic, id: 'fixture' };",
      ],
      [
        "export const wrapper = {",
        "  id: 'fixture',",
        "  get version() { throw new Error('must not execute'); },",
        "};",
      ],
      [
        "import { version } from './must-not-load';",
        "export const wrapper = { id: 'fixture', version };",
      ],
    ];
    const candidatePaths = await Promise.all(
      sources.map(async (lines, index) => {
        const path = join(root, `candidate-dynamic-${index + 1}.ts`);
        await writeFile(path, `${lines.join("\n")}\n`, "utf8");
        return path;
      }),
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        candidatePaths,
      ),
    ).toEqual(
      candidatePaths
        .sort()
        .map((path) => ({ path, category: "private-value" })),
    );
  });

  it("preserves shadowing and public near-collision composites as clean", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    (pack.entries[0]!.privatePayload as Record<string, unknown>)["relationship"] = {
      id: "fixture",
      version: "relationship",
    };
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const candidatePaths = [
      join(root, "shadow.ts"),
      join(root, "near.ts"),
      join(root, "unrelated-cycle.ts"),
    ];
    await writeFile(
      candidatePaths[0]!,
      [
        "const id = 'fixture';",
        "{",
        "  const id = 'fixture-near';",
        "  const version = 'relationship';",
        "  const safe = { version, id };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      candidatePaths[1]!,
      "export const safe = { id: 'fixture-extra', version: 'relationship' };\n",
      "utf8",
    );
    await writeFile(
      candidatePaths[2]!,
      [
        "const left = right;",
        "const right = left;",
        "export const safe = { wrapper: left };",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        candidatePaths,
      ),
    ).toEqual([]);
  });

  it("still reports private-only values after subtracting public vocabulary", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    const publicCorpus =
      "export const publicRelationships = ['neutral-matches', 'neutral-differs', 'neutral-unknown'];\n";
    await writeFile(
      candidatePath,
      `${publicCorpus}export const leaked = 'neutral-grader-canaries-alpha-1';\n`,
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a private scoring structure", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      "export const leakedScoring = { relationshipVocabulary: ['neutral-matches', 'neutral-differs', 'neutral-unknown'] };\n",
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a longer public near-collision that embeds a private-only value", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    const publicNearCollision = "neutral-review-note-alpha-1-extra";
    await writeFile(
      candidatePath,
      `export const publicValue = '${publicNearCollision}';\n`,
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("reports a private structure across formatting", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      [
        "export const leakedScoring = {",
        "  relationshipVocabulary: [",
        "    'neutral-matches',",
        "    'neutral-differs',",
        "    'neutral-unknown',",
        "  ],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("detects Unicode private values through normalized and encoded forms", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    pack.entries[0]!.privatePayload.reviewNote = "neutral-réview-omega";
    const packPath = await writePack(root, "pack.json", refreshPack(pack));
    const encodings = [
      "neutral-r%C3%A9view-omega",
      "neutral-r\\u00e9view-omega",
      "neutral-r&#xE9;view-omega",
      "neutral-re\u0301view-omega",
    ];
    const candidatePaths = await Promise.all(
      encodings.map(async (encoded, index) => {
        const candidatePath = join(root, `candidate-${index + 1}.ts`);
        await writeFile(
          candidatePath,
          `export const encoded = '${encoded}';\n`,
          "utf8",
        );
        return candidatePath;
      }),
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        candidatePaths,
      ),
    ).toEqual(
      candidatePaths
        .sort()
        .map((path) => ({ path, category: "private-value" })),
    );
  });

  it(
    "decodes valid percent-encoded private material despite unrelated malformed percent noise",
    async () => {
      const root = await temporaryRoot();
      const publicSet = neutralPublicSet();
      const pack = neutralPack(publicSet);
      (pack.entries[0]!.privatePayload as Record<string, unknown>)[
        "relationship"
      ] = {
        id: "fixture",
        version: "relationship",
      };
      const packPath = await writePack(root, "pack.json", refreshPack(pack));
      const scalarPath = join(root, "candidate-mixed-percent-scalar.ts");
      const compositePath = join(
        root,
        "candidate-mixed-percent-composite.txt",
      );
      const percentEncodeAll = (value: string) =>
        [...Buffer.from(value, "utf8")]
          .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
          .join("");
      await writeFile(
        scalarPath,
        `export const noise = '%ZZ'; export const leak = '${percentEncodeAll("neutral-review-note-alpha-1")}';\n`,
        "utf8",
      );
      await writeFile(
        compositePath,
        `/*%GG*/\nexport const leak = ${percentEncodeAll(
          JSON.stringify({
            wrapper: { version: "relationship", id: "fixture" },
          }),
        )};\n`,
        "utf8",
      );

      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          await fileSha256(packPath),
          [scalarPath, compositePath],
        ),
      ).toEqual(
        [compositePath, scalarPath]
          .sort()
          .map((path) => ({ path, category: "private-value" })),
      );
    },
    15_000,
  );

  it(
    "handles UTF-8 and mixed runs at percent-round boundary minus one, boundary, and plus one",
    async () => {
      const root = await temporaryRoot();
      const publicSet = neutralPublicSet();
      const pack = neutralPack(publicSet);
      pack.entries[0]!.privatePayload.reviewNote = "neutral-réview-omega";
      const packPath = await writePack(root, "pack.json", refreshPack(pack));
      const trustedPackHash = await fileSha256(packPath);
      const percentEncodeAll = (value: string, uppercase: boolean) =>
        [...Buffer.from(value, "utf8")]
          .map((byte) => {
            const encoded = byte.toString(16).padStart(2, "0");
            return `%${uppercase ? encoded.toUpperCase() : encoded}`;
          })
          .join("");
      const lower = percentEncodeAll("neutral-réview-omega", false);
      const nested = lower.replaceAll("%", "%25");
      const beyondRoundBudget = nested.replaceAll("%", "%25");
      const privatePaths = await Promise.all(
        [
          `/* 50% complete and %ZZ */ export const leak = '${lower}';\n`,
          `export const leak = '${percentEncodeAll("neutral", true)}-${percentEncodeAll("réview", true)}-${percentEncodeAll("omega", true)}';\n`,
          `export const nested = '${nested}';\n`,
        ].map(async (source, index) => {
          const path = join(root, `candidate-percent-run-${index + 1}.ts`);
          await writeFile(path, source, "utf8");
          return path;
        }),
      );

      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          privatePaths,
        ),
      ).toEqual(
        privatePaths
          .sort()
          .map((path) => ({ path, category: "private-value" })),
      );

      const harmlessPath = join(root, "candidate-percent-harmless.ts");
      await writeFile(
        harmlessPath,
        "export const percentage = '50% complete'; export const remainder = 5 % 2;\n",
        "utf8",
      );
      expect(
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [harmlessPath],
        ),
      ).toEqual([]);

      const iterationBudgetPath = join(
        root,
        "candidate-percent-iteration-budget.ts",
      );
      await writeFile(
        iterationBudgetPath,
        `export const nested = '${beyondRoundBudget}';\n`,
        "utf8",
      );
      expectPublicationScanIndeterminate(() =>
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [iterationBudgetPath],
        ),
      );

      const invalidUtf8Path = join(root, "candidate-percent-invalid.ts");
      const invalidPercentRun = ["%", "ff"].join("");
      await writeFile(
        invalidUtf8Path,
        `export const invalid = '${invalidPercentRun}';\n`,
        "utf8",
      );
      expectPublicationScanIndeterminate(() =>
        scanPublicBlobsForPrivateValues(
          packPath,
          publicSet,
          trustedPackHash,
          [invalidUtf8Path],
        ),
      );
    },
    15_000,
  );

  it("detects a private value split across adjacent source literals", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(
      candidatePath,
      "export const encoded = 'neutral-review-note-' + 'alpha-1';\n",
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("detects private-only values and commitments across publication artifact kinds", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    const packPath = await writePack(root, "pack.json", pack);
    const sourcePath = join(root, "candidate.ts");
    const testPath = join(root, "candidate.test.ts");
    const docsPath = join(root, "candidate.md");
    const artifactPath = join(root, "candidate.json");
    await writeFile(
      sourcePath,
      "export const leaked = 'neutral-review-note-alpha-1';\n",
      "utf8",
    );
    await writeFile(
      testPath,
      "export const leaked = 'neutral-grader-canaries-alpha-1';\n",
      "utf8",
    );
    await writeFile(
      docsPath,
      "Leaked assessment: `neutral-assessment-alpha-1`.\n",
      "utf8",
    );
    await writeFile(
      artifactPath,
      `${JSON.stringify({ digest: pack.entries[0]!.privatePayloadHash })}\n`,
      "utf8",
    );

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [sourcePath, testPath, docsPath, artifactPath],
      ),
    ).toEqual(
      [artifactPath, docsPath, sourcePath, testPath]
        .sort()
        .map((path) => ({ path, category: "private-value" })),
    );
  });

  it("always reports a private commitment", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const pack = neutralPack(publicSet);
    const packPath = await writePack(root, "pack.json", pack);
    const candidatePath = join(root, "candidate.json");
    const commitment = pack.entries[0]!.privatePayloadHash;
    await writeFile(candidatePath, `${JSON.stringify({ digest: commitment })}\n`, "utf8");

    expect(
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        await fileSha256(packPath),
        [candidatePath],
      ),
    ).toEqual([{ path: candidatePath, category: "private-value" }]);
  });

  it("fails closed when publication scanning lacks the pack or trusted identity", async () => {
    const root = await temporaryRoot();
    const publicSet = neutralPublicSet();
    const packPath = await writePack(root, "pack.json", neutralPack(publicSet));
    const candidatePath = join(root, "candidate.ts");
    await writeFile(candidatePath, "export const publicValue = 'safe';\n", "utf8");

    expect(() =>
      scanPublicBlobsForPrivateValues(
        join(root, "missing.json"),
        publicSet,
        "0".repeat(64),
        [candidatePath],
      ),
    ).toThrow(/private scoring pack/i);
    expect(() =>
      scanPublicBlobsForPrivateValues(
        packPath,
        publicSet,
        "f".repeat(64),
        [candidatePath],
      ),
    ).toThrow(/trusted private scoring pack identity/i);
  });
});
