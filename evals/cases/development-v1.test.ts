import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/contracts";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
} from "../protocol/v1";
import {
  RunManifestSchema,
  SmokeMetricsSchema,
} from "../runner/v1";
import {
  DEVELOPMENT_CASES,
  DevelopmentCaseSchema,
  DevelopmentCaseSetSchema,
  createDevelopmentCase,
  materializeDevelopmentCaseSmoke,
  toDevelopmentCaseModelInput,
  type DevelopmentCase,
} from "./development-v1";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "evidenceforge-development-cases-"),
  );
  temporaryRoots.push(root);
  return root;
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat().sort();
}

async function byteSnapshot(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await filesBelow(root)).map(async (path) => [
        relative(root, path).replaceAll("\\", "/"),
        await readFile(path, "utf8"),
      ]),
    ),
  );
}

function unhashed(developmentCase: DevelopmentCase): Record<string, unknown> {
  const input = structuredClone(
    developmentCase,
  ) as unknown as Record<string, unknown> & {
    sources: Array<Record<string, unknown>>;
    chunks: Array<Record<string, unknown>>;
  };
  delete input.bundleHash;
  for (const source of input.sources) delete source.sourceHash;
  for (const chunk of input.chunks) delete chunk.chunkHash;
  return input;
}

describe("development case set v1", () => {
  it("contains exactly two distinct-domain non-headline development cases bound to protocol v1", () => {
    const cases = DevelopmentCaseSetSchema.parse(
      structuredClone(DEVELOPMENT_CASES),
    );

    expect(cases).toHaveLength(2);
    expect(new Set(cases.map(({ benchmarkCase }) => benchmarkCase.domain)))
      .toHaveLength(2);
    for (const developmentCase of cases) {
      expect(developmentCase.benchmarkCase.role).toBe("development");
      expect(developmentCase.classification).toEqual({
        evidenceMode: "fixture",
        reportingUse: "development",
        resultClass: "development_case",
        headlineEligible: false,
      });
      expect(developmentCase.protocolBinding).toEqual({
        protocolVersion: BENCHMARK_PROTOCOL_VERSION,
        protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
        conditionMatrixHash: CONDITION_MATRIX_HASH,
        promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
      });
      expect(developmentCase.benchmarkCase.packet).toEqual({
        fingerprint: developmentCase.packetFingerprint,
        sourceHashes: developmentCase.sources.map(
          ({ sourceHash }) => sourceHash,
        ),
        chunkHashes: developmentCase.chunks.map(
          ({ chunkHash }) => chunkHash,
        ),
      });
    }
    expect(
      cases.map((developmentCase) => ({
        id: developmentCase.benchmarkCase.id,
        caseHash: developmentCase.benchmarkCase.caseHash,
        packetFingerprint: developmentCase.packetFingerprint,
        bundleHash: developmentCase.bundleHash,
      })),
    ).toEqual([
      {
        id: "library-lighting-schedule",
        caseHash:
          "6bf705daa37f5dae86818e4e4d8977d8d25f5d30b8319e7370128fd8e1f63d5b",
        packetFingerprint:
          "c860e70e96e0047ac49337a39efac457c9e1a1d5d0cdaef25caa304dc4d2c4f6",
        bundleHash:
          "d396b4482b1b31f0d11a7ecedc784e04a271005f6a20893bfacd85554210bece",
      },
      {
        id: "bounded-retry-reliability",
        caseHash:
          "7b2f9b1e2b7ac24297471d252743dfc042935f020325702e6f675299ebe03cdf",
        packetFingerprint:
          "eaa7ae4635230b920a085a994ed6c82adb871963909f993175390a39b64012b1",
        bundleHash:
          "9d0976a1a527501baf29d0dcafeb7210b3b40c6ba0b61f410986ebabee717436",
      },
    ]);
  });

  it("collectively covers every required evidence pattern with explicit abstentions and experiment limitations", () => {
    const cases = DevelopmentCaseSetSchema.parse(DEVELOPMENT_CASES);
    const coverage = new Set(
      cases.flatMap(({ scoringKey }) =>
        scoringKey.chunkExpectations.flatMap(
          ({ coverageLabels }) => coverageLabels,
        ),
      ),
    );

    expect([...coverage].sort()).toEqual([
      "adversarial_or_misleading_source_text",
      "conflicting_evidence",
      "experiment_confound_or_inferential_limitation",
      "insufficient_evidence_or_abstention",
      "straightforward_support",
    ]);
    expect(
      cases.every(
        ({ scoringKey }) =>
          scoringKey.expectedAbstentions.length > 0 &&
          scoringKey.experimentLimitations.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps scoring keys and grader instructions out of model-visible inputs", () => {
    for (const developmentCase of DEVELOPMENT_CASES) {
      const modelInput = toDevelopmentCaseModelInput(developmentCase);
      const serialized = canonicalizeJson(modelInput);

      expect(modelInput).not.toHaveProperty("scoringKey");
      expect(serialized).not.toContain("chunkExpectations");
      expect(serialized).not.toContain("knownContradictions");
      expect(serialized).not.toContain("expectedAbstentions");
      expect(serialized).not.toContain("graderInstructions");
      for (const instruction of developmentCase.scoringKey
        .graderInstructions) {
        expect(serialized).not.toContain(instruction);
      }
      for (const abstention of developmentCase.scoringKey
        .expectedAbstentions) {
        expect(serialized).not.toContain(abstention.rationale);
      }
    }
  });

  it("records explicit authored-fixture rights, permission, safety, and non-authority boundaries", () => {
    for (const developmentCase of DEVELOPMENT_CASES) {
      expect(developmentCase.permissionNotes.length).toBeGreaterThan(0);
      expect(developmentCase.benchmarkCase.safety).toMatchObject({
        nonMedical: true,
        nonHazardous: true,
      });
      for (const source of developmentCase.sources) {
        expect(source).toMatchObject({
          origin: "project_authored_fixture",
          creator: "EvidenceForge fixture authors",
          externalCitation: null,
          externalAuthorityClaimed: false,
          rights: {
            licenseId: "CC0-1.0",
            mayStore: true,
            mayDisplay: true,
            maySendToModel: true,
          },
        });
        expect(source.rights.basis).toContain("project-authored");
        expect(source.safetyNotes.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects tampered source bytes, chunk hashes, bundle hashes, and protocol bindings", () => {
    const sourceTamper = structuredClone(DEVELOPMENT_CASES[0]);
    sourceTamper.chunks[0]!.text += " Tampered.";
    expect(() => DevelopmentCaseSchema.parse(sourceTamper)).toThrow();

    const hashTamper = structuredClone(DEVELOPMENT_CASES[0]);
    hashTamper.chunks[0]!.chunkHash = "0".repeat(64);
    expect(() => DevelopmentCaseSchema.parse(hashTamper)).toThrow();

    const bundleTamper = structuredClone(DEVELOPMENT_CASES[0]);
    bundleTamper.bundleHash = "f".repeat(64);
    expect(() => DevelopmentCaseSchema.parse(bundleTamper)).toThrow();

    const protocolTamper = structuredClone(DEVELOPMENT_CASES[0]);
    protocolTamper.protocolBinding.protocolSchemaHash = "1".repeat(64);
    expect(() => DevelopmentCaseSchema.parse(protocolTamper)).toThrow();
  });

  it("canonicalizes unordered definitions to one deterministic case and packet hash", () => {
    const input = unhashed(DEVELOPMENT_CASES[0]);
    const reordered = structuredClone(input) as typeof input & {
      sources: unknown[];
      chunks: unknown[];
      claims: unknown[];
      scoringKey: {
        chunkExpectations: unknown[];
        knownContradictions: unknown[];
        expectedAbstentions: unknown[];
        experimentLimitations: unknown[];
        adversarialTreatments: unknown[];
        graderInstructions: unknown[];
      };
    };
    reordered.sources.reverse();
    reordered.chunks.reverse();
    reordered.claims.reverse();
    reordered.scoringKey.chunkExpectations.reverse();
    reordered.scoringKey.knownContradictions.reverse();
    reordered.scoringKey.expectedAbstentions.reverse();
    reordered.scoringKey.experimentLimitations.reverse();
    reordered.scoringKey.adversarialTreatments.reverse();
    reordered.scoringKey.graderInstructions.reverse();

    expect(createDevelopmentCase(reordered)).toEqual(
      DEVELOPMENT_CASES[0],
    );
  });

  it("rejects missing coverage, inconsistent contradiction keys, rights omissions, and misleading authority metadata", () => {
    const missingCoverageInput = unhashed(DEVELOPMENT_CASES[1]) as {
      scoringKey: DevelopmentCase["scoringKey"];
    };
    missingCoverageInput.scoringKey.chunkExpectations =
      missingCoverageInput.scoringKey.chunkExpectations.map(
        (expectation) => ({
          ...expectation,
          coverageLabels: expectation.coverageLabels.includes(
            "adversarial_or_misleading_source_text",
          )
            ? ["insufficient_evidence_or_abstention" as const]
            : expectation.coverageLabels,
        }),
      );
    missingCoverageInput.scoringKey.adversarialTreatments = [];
    const missingCoverage = [
      DEVELOPMENT_CASES[0],
      createDevelopmentCase(missingCoverageInput),
    ];
    expect(() => DevelopmentCaseSetSchema.parse(missingCoverage)).toThrow(
      "development set must cover every required evidence pattern",
    );

    const contradictionMismatch = unhashed(DEVELOPMENT_CASES[0]) as {
      scoringKey: DevelopmentCase["scoringKey"];
    };
    const contradiction =
      contradictionMismatch.scoringKey.knownContradictions[0]!;
    const contradictingExpectation =
      contradictionMismatch.scoringKey.chunkExpectations.find(
        ({ chunkId }) =>
          chunkId === contradiction.contradictingChunkId,
      )!;
    contradictingExpectation.relationship = "supports";
    expect(() => createDevelopmentCase(contradictionMismatch)).toThrow(
      "contradiction key must pair support and contradiction for one claim",
    );

    const missingRights = structuredClone(
      DEVELOPMENT_CASES[0],
    ) as unknown as {
      sources: Array<{ rights?: unknown }>;
    };
    delete missingRights.sources[0]!.rights;
    expect(() => DevelopmentCaseSchema.parse(missingRights)).toThrow();

    const missingSafety = structuredClone(
      DEVELOPMENT_CASES[0],
    ) as unknown as {
      benchmarkCase: { safety?: unknown };
    };
    delete missingSafety.benchmarkCase.safety;
    expect(() => DevelopmentCaseSchema.parse(missingSafety)).toThrow();

    const falseAuthority = unhashed(DEVELOPMENT_CASES[1]) as {
      sources: DevelopmentCase["sources"];
      scoringKey: DevelopmentCase["scoringKey"];
    };
    const adversarial =
      falseAuthority.scoringKey.adversarialTreatments[0]!;
    falseAuthority.sources.find(
      ({ id }) => id === adversarial.sourceId,
    )!.authority = "authored_fixture_observation";
    expect(() => createDevelopmentCase(falseAuthority)).toThrow(
      "adversarial text must remain an untrusted source with a private expectation",
    );
  });

  it("rejects live, headline, heldout, and path-traversal relabeling before filesystem creation", async () => {
    const live = structuredClone(DEVELOPMENT_CASES[0]);
    (live.classification as { evidenceMode: string }).evidenceMode =
      "live";
    expect(() => DevelopmentCaseSchema.parse(live)).toThrow();

    const headline = structuredClone(DEVELOPMENT_CASES[0]);
    (
      headline.classification as { headlineEligible: boolean }
    ).headlineEligible = true;
    expect(() => DevelopmentCaseSchema.parse(headline)).toThrow();

    const heldout = structuredClone(DEVELOPMENT_CASES[0]);
    (heldout.benchmarkCase as { role: string }).role = "heldout";
    expect(() => DevelopmentCaseSchema.parse(heldout)).toThrow();

    const traversalInput = unhashed(DEVELOPMENT_CASES[0]);
    (
      traversalInput.benchmarkCase as { id: string }
    ).id = "../outside";
    expect(() => createDevelopmentCase(traversalInput)).toThrow();

    const sandbox = await temporaryRoot();
    const artifactRoot = join(sandbox, "artifacts");
    const invalid = structuredClone(DEVELOPMENT_CASES[0]);
    (invalid.benchmarkCase as { id: string }).id = "../outside";
    await expect(
      materializeDevelopmentCaseSmoke({
        artifactRoot,
        developmentCase: invalid,
      }),
    ).rejects.toThrow();
    await expect(lstat(artifactRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(sandbox)).toEqual([]);
  });

  it("materializes both cases deterministically through the accepted runner without results or headline claims", async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();

    for (const developmentCase of DEVELOPMENT_CASES) {
      const first = await materializeDevelopmentCaseSmoke({
        artifactRoot: firstRoot,
        developmentCase,
      });
      const second = await materializeDevelopmentCaseSmoke({
        artifactRoot: secondRoot,
        developmentCase,
      });
      const manifest = RunManifestSchema.parse(
        JSON.parse(await readFile(first.manifestPath, "utf8")),
      );
      expect(manifest).toMatchObject({
        evidenceMode: "fixture",
        reportingUse: "development",
        resultClass: "smoke_only",
        headlineEligible: false,
        complete: true,
      });
      expect(manifest.caseReference).toMatchObject({
        id: developmentCase.benchmarkCase.id,
        version: developmentCase.benchmarkCase.version,
        caseHash: developmentCase.benchmarkCase.caseHash,
      });

      const metricsPath = join(
        first.runPath,
        "metrics",
        "smoke.json",
      );
      const metrics = SmokeMetricsSchema.parse(
        JSON.parse(await readFile(metricsPath, "utf8")),
      );
      expect(metrics).toMatchObject({
        evidenceMode: "fixture",
        reportingUse: "development",
        resultClass: "smoke_only",
        headlineEligible: false,
        counts: {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          parsedValid: 0,
          parsedInvalid: 0,
          notParsed: 1,
        },
        totalLatencyMs: 0,
      });

      const rawPath = join(
        first.runPath,
        "raw",
        `attempt-001-${developmentCase.benchmarkCase.id}-smoke-attempt.json`,
      );
      const raw = JSON.parse(await readFile(rawPath, "utf8")) as {
        rawOutput: unknown;
        failure: { kind: string; message: string };
      };
      expect(raw.rawOutput).toBeNull();
      expect(raw.failure).toEqual({
        kind: "fixture_failure",
        message:
          "No model or provider executed; this is deterministic case-materialization smoke only.",
        retryable: false,
        providerCode: null,
      });

      const firstCaseBytes = await readFile(first.casePath, "utf8");
      const secondCaseBytes = await readFile(second.casePath, "utf8");
      expect(secondCaseBytes).toBe(firstCaseBytes);
    }

    expect(await byteSnapshot(secondRoot)).toEqual(
      await byteSnapshot(firstRoot),
    );
  });

  it("refuses deterministic run overwrites and preserves every existing byte", async () => {
    const artifactRoot = await temporaryRoot();
    const developmentCase = DEVELOPMENT_CASES[0];
    await materializeDevelopmentCaseSmoke({
      artifactRoot,
      developmentCase,
    });
    const before = await byteSnapshot(artifactRoot);

    await expect(
      materializeDevelopmentCaseSmoke({
        artifactRoot,
        developmentCase,
      }),
    ).rejects.toThrow(
      `run already exists at ${join(
        artifactRoot,
        "runs",
        "1.0.0",
        `${developmentCase.benchmarkCase.id}-smoke`,
      )}`,
    );
    expect(await byteSnapshot(artifactRoot)).toEqual(before);
  });
});
