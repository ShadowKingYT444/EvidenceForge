import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalSha256, canonicalizeJson } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  StrongBaselineOutputSchema,
  parsePromptInput,
  promptRegistry,
} from "../../src/server/prompts/registry";
import {
  DEVELOPMENT_CASES,
  createDevelopmentCase,
  type DevelopmentCase,
} from "../cases/development-v1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  assessComparisonPair,
  createBenchmarkConfig,
} from "../protocol/v1";
import {
  STRONG_BASELINE_PARITY_VERSION,
  StrongBaselineParityBundleSchema,
  createStrongBaselineParityBundle,
  exportStrongBaselineParityManifest,
  materializeStrongBaselineSmoke,
  parseBaselineAttemptEvidence,
  parseBaselineAttemptSequence,
  safeParseBaselineAttemptEvidence,
  safeParseBaselineAttemptSequence,
  validateStrongBaselineOutput,
  type StrongBaselineRunAuthority,
  type StrongBaselineParityBundle,
} from "./v1";

const temporaryRoots: string[] = [];

const EXPECTED_MANIFEST_HASHES: Record<
  string,
  {
    contextHash: string;
    pairingHash: string;
    comparisonInvalidatingHash: string;
    baselineConfigHash: string;
    workflowConfigHash: string;
    bundleHash: string;
  }
> = {
  "library-lighting-schedule": {
    contextHash: "4e86b1d2289e83c25797095ad9114f066319560df6b102dce0ef3481ad11f0a4",
    pairingHash: "a3244f30bba0d59c29dd73d2d4a75f746c4aaf20c2ae77432fc9fc7176b27a30",
    comparisonInvalidatingHash: "87222862d682e55a669545e783e88152963c74d12ca30c51153c732536e9dd4e",
    baselineConfigHash: "d07a74595d2dc8509f75a4e96803b4ee5a87c9a2cf23e08ec8d3bc7ee99bf9a3",
    workflowConfigHash: "d808332f8505a3cd3532f1b10795358891f00fb536110f1433023d865e5183be",
    bundleHash: "6acb6b999edb3940bf3d8c55f77db57aec9cf4b3b469bfb7af4637d0b981b499",
  },
  "bounded-retry-reliability": {
    contextHash: "eb7441610e6fd10877112a387be5d03ba5796eab77c298c95090a6d6b790998a",
    pairingHash: "f136f9de049519a8bc3a27519f6db263c1abd002f96f29623eb51a683721a23b",
    comparisonInvalidatingHash: "667b204eb0833317b008ce36ddb22502b63481cb75fbe3d24c2d11e49619255c",
    baselineConfigHash: "d8ac7984a293525b2bcd069c4c03add08b49fbcb2fbe1ed19301b48c976b9c9a",
    workflowConfigHash: "a6b8b7dcfd48fa53be9f60ecc04b0a55a0d307c403e22dcb1d9a9e4c1744ee6d",
    bundleHash: "b934e8a53e41a6f39f6214acc7331f8e961ff0e1ea36b5adea9f55191da5f911",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function temporaryRoot(label: string) {
  const path = await mkdtemp(join(tmpdir(), `${label}-`));
  temporaryRoots.push(path);
  return path;
}

async function byteSnapshot(root: string) {
  const values = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else values.set(relative(root, child).replaceAll("\\", "/"), await readFile(child, "utf8"));
    }
  }
  await walk(root);
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

type MutableBundle = {
  context: {
    kind: string;
    nodeId: string;
    inputRefs: string[];
    payload: {
      normalizedMetadata?: unknown;
      unapprovedExtraContext?: boolean;
      chunks: Array<{ text: string }>;
      generationLimits: { timeoutMs: number };
      primaryModel: { modelId: string };
      safetyConstraints: string[];
      outputSchema: { hash: string };
    };
  };
  baseline: {
    contextBytes: string;
    contextHash: string;
    request: { prompt: { hash: string } };
  };
  protocolBinding: { promptManifestHash: string };
  comparisonInvalidatingHash: string;
  bundleHash: string;
  classification: { evidenceMode: string; headlineEligible: boolean };
};

type MutableDevelopmentCase = { benchmarkCase: { id: string } };

type MutableAttemptEvidence = {
  runId: string;
  attemptId: string;
  outcome: string;
  parityBinding: {
    caseId: string;
    benchmarkCodeVersion: string;
    contextHash: string;
    pairingHash: string;
    comparisonInvalidatingHash: string;
    bundleHash: string;
    baselineConfigHash: string;
    prompt: { id: string; version: string; hash: string };
  };
  requestedModel: {
    provider: string;
    modelId: string;
    developerFamily: string;
    baseFamily: string;
  };
  returnedModel: {
    status: string;
    value: unknown;
    reason: string | null;
  };
  rawProviderOutput: unknown;
  canonicalOutput: unknown;
  canonicalOutputHash: string | null;
  validation: {
    status: string;
    schemaId: string;
    schemaVersion: string;
    schemaHash: string;
    issues: string[];
  };
  usage: {
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reason: string | null;
  };
  cost: {
    status: string;
    amount: number | null;
    currency: string | null;
    reason: string | null;
  };
  latency: {
    milliseconds: number;
    measured: boolean;
    evidence: string;
  };
  retry: {
    attemptNumber: number;
    maximumAttempts: number;
    retryOfAttemptId: string | null;
    willRetry: boolean;
    reason: string;
  };
};

function replaceDataPropertyWithGetter(
  target: Record<string, unknown>,
  key: string,
) {
  const original = target[key];
  const calls = { value: 0 };
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls.value += 1;
      return original;
    },
  });
  return calls;
}

function privateScoringValues(developmentCase: (typeof DEVELOPMENT_CASES)[number]) {
  return [
    ...developmentCase.scoringKey.graderInstructions,
    ...developmentCase.scoringKey.expectedAbstentions.flatMap(({ requiredAbstention, rationale }) => [
      requiredAbstention,
      rationale,
    ]),
    ...developmentCase.scoringKey.experimentLimitations.flatMap(({ limitation, requiredMitigation }) => [
      limitation,
      requiredMitigation,
    ]),
    ...developmentCase.scoringKey.knownContradictions.flatMap(({ id, label }) => [id, label]),
  ];
}

function unhashedDevelopmentCase(
  developmentCase: DevelopmentCase,
): Record<string, unknown> {
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

function callerAuthoredThirdCase(): DevelopmentCase {
  const input = unhashedDevelopmentCase(DEVELOPMENT_CASES[0]!) as {
    benchmarkCase: {
      id: string;
      originalQuestion: string;
      metadataSnapshot: { id: string };
    };
  };
  input.benchmarkCase.id = "caller-authored-third-case";
  input.benchmarkCase.originalQuestion =
    "Can a caller-selected third case mint benchmark eligibility?";
  input.benchmarkCase.metadataSnapshot.id = "caller-third-snapshot";
  return createDevelopmentCase(input);
}

function callerRecomputedThirdCaseBundle(): StrongBaselineParityBundle {
  const thirdCase = callerAuthoredThirdCase();
  const bundle = structuredClone(
    createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!),
  );
  bundle.caseId = thirdCase.benchmarkCase.id;
  bundle.baseline.config = createBenchmarkConfig({
    ...bundle.baseline.config,
    id: `${thirdCase.benchmarkCase.id}-strong-baseline-v1`,
    case: thirdCase.benchmarkCase,
  });
  bundle.workflow.config = createBenchmarkConfig({
    ...bundle.workflow.config,
    id: `${thirdCase.benchmarkCase.id}-complete-workflow-v1`,
    case: thirdCase.benchmarkCase,
  });
  const comparison = assessComparisonPair({
    left: bundle.baseline.config,
    right: bundle.workflow.config,
    reportingUse: "development",
  });
  if (!comparison.valid || comparison.pairingHash === null) {
    throw new TypeError("third-case comparison fixture must remain internally valid");
  }
  bundle.comparison = {
    valid: true,
    invalidationReasons: [],
    leftConfigHash: comparison.leftConfigHash,
    rightConfigHash: comparison.rightConfigHash,
    pairingHash: comparison.pairingHash,
  };

  const accepted = parsePromptInput("strong-baseline", bundle.context) as {
    payload: {
      resolvedScope: unknown;
      packet: unknown;
      chunks: unknown;
      normalizedMetadata: unknown;
      primaryModel: unknown;
      generationLimits: unknown;
      generationSettings: unknown;
      outputSchema: unknown;
      requiredOutputFields: unknown;
      safetyConstraints: unknown;
      constraintSetHash: string;
    };
  };
  const parityPayloads = {
    resolved_scope: {
      evaluationScopeHash: bundle.baseline.config.case.resolvedScopeHash,
      acceptedResolvedScope: accepted.payload.resolvedScope,
    },
    source_packet: {
      evaluationPacket: bundle.baseline.config.case.packet,
      acceptedPacket: accepted.payload.packet,
    },
    source_chunks: accepted.payload.chunks,
    metadata_facts: {
      evaluationSnapshot: bundle.baseline.config.case.metadataSnapshot,
      acceptedNormalizedMetadata: accepted.payload.normalizedMetadata,
    },
    primary_model: accepted.payload.primaryModel,
    limits_and_budgets: {
      generationLimits: accepted.payload.generationLimits,
      generationSettings: accepted.payload.generationSettings,
    },
    output_schema_and_required_fields: {
      outputSchema: accepted.payload.outputSchema,
      requiredOutputFields: accepted.payload.requiredOutputFields,
    },
    safety_constraints: {
      safetyConstraints: accepted.payload.safetyConstraints,
      constraintSetHash: accepted.payload.constraintSetHash,
    },
    prompt_manifest: bundle.baseline.config.promptManifest,
  };
  bundle.parityFields = bundle.parityFields.map(({ field }) => {
    const hash = canonicalSha256(parityPayloads[field]);
    return { field, baselineHash: hash, workflowHash: hash, equal: true };
  });
  bundle.comparisonInvalidatingHash = canonicalSha256({
    version: STRONG_BASELINE_PARITY_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    pairingHash: comparison.pairingHash,
    contextHash: bundle.baseline.contextHash,
    parityFields: bundle.parityFields,
    prompt: bundle.baseline.request.prompt,
    inputSchema: bundle.baseline.request.inputSchema,
    allowedDifferences: bundle.allowedDifferences,
  });
  const { bundleHash: priorBundleHash, ...withoutBundleHash } = bundle;
  if (priorBundleHash.length !== 64) {
    throw new TypeError("starting bundle fixture must have a canonical hash");
  }
  bundle.bundleHash = canonicalSha256({
    version: STRONG_BASELINE_PARITY_VERSION,
    ...withoutBundleHash,
  });
  return bundle;
}

function strongBaselineFixtureOutput() {
  return {
    claims: goldenRunV01.claims,
    evidenceCards: goldenRunV01.evidenceCards,
    conclusions: goldenRunV01.conclusions,
    researchGaps: goldenRunV01.researchGaps,
    selectedGapId: goldenRunV01.selectedGapId,
    experimentPlanning: goldenRunV01.experiment === null
      ? {
          disposition: "abstained" as const,
          experiment: null,
          abstention: goldenRunV01.experimentAbstention,
        }
      : {
          disposition: "proposed" as const,
          experiment: goldenRunV01.experiment,
          abstention: null,
        },
    review: goldenRunV01.review,
  };
}

describe("strong single-prompt baseline parity v1", () => {
  it.each(DEVELOPMENT_CASES.map((developmentCase) => [developmentCase.benchmarkCase.id, developmentCase] as const))(
    "binds %s to the exact accepted prompt, frozen context, and equal protocol pairing",
    (_caseId, developmentCase) => {
      const bundle = createStrongBaselineParityBundle(developmentCase);
      const resource = promptRegistry.baseline();

      expect(StrongBaselineParityBundleSchema.parse(bundle)).toEqual(bundle);
      expect(bundle.baseline.config.conditionId).toBe("strong_baseline");
      expect(bundle.workflow.config.conditionId).toBe("complete_workflow");
      expect(bundle.baseline.config.pairingHash).toBe(bundle.workflow.config.pairingHash);
      expect(bundle.comparison.valid).toBe(true);
      expect(bundle.comparison.invalidationReasons).toEqual([]);
      expect(bundle.baseline.callCount).toBe(1);
      expect(bundle.baseline.contextBytes).toBe(bundle.workflow.contextBytes);
      expect(bundle.baseline.contextHash).toBe(bundle.workflow.contextHash);
      expect(bundle.baseline.contextHash).toBe(canonicalSha256(bundle.context));
      expect(bundle.baseline.request.prompt).toEqual({
        id: resource.id,
        version: resource.version,
        hash: resource.hash,
      });
      expect(bundle.baseline.request.messages[0]).toEqual(resource.messages[0]);
      expect(bundle.baseline.request.messages[1]?.content).toBe(bundle.baseline.contextBytes);
      const accepted = parsePromptInput("strong-baseline", bundle.context) as {
        payload: {
          outputSchema: { hash: string };
          requiredOutputFields: string[];
          constraintSetHash: string;
          safetyConstraints: string[];
          generationLimits: {
            maximumAttempts: number;
            timeoutMs: number;
            maxOutputTokens: number;
          };
        };
      };
      expect(accepted.payload.outputSchema.hash).toBe(resource.outputSchema.hash);
      expect(accepted.payload.requiredOutputFields).toEqual(
        resource.outputSchema.jsonSchema.required,
      );
      expect(accepted.payload.constraintSetHash).toBe(resource.constraintSet.hash);
      expect(accepted.payload.safetyConstraints).toEqual(resource.safetyRules);
      expect(accepted.payload.generationLimits.maximumAttempts).toBe(resource.maximumAttempts);
      expect(accepted.payload.generationLimits.timeoutMs).toBe(resource.timeoutMs);
      expect(accepted.payload.generationLimits.maxOutputTokens).toBe(resource.generationSettings.maxOutputTokens);
      expect(bundle.parityFields.every(({ equal }) => equal)).toBe(true);
      expect(bundle.protocolBinding.promptManifestHash).toBe(FROZEN_CONSUMER_EDGE.promptManifestHash);
      expect({
        contextHash: bundle.baseline.contextHash,
        pairingHash: bundle.comparison.pairingHash,
        comparisonInvalidatingHash: bundle.comparisonInvalidatingHash,
        baselineConfigHash: bundle.baseline.config.configHash,
        workflowConfigHash: bundle.workflow.config.configHash,
        bundleHash: bundle.bundleHash,
      }).toEqual(EXPECTED_MANIFEST_HASHES[bundle.caseId]);
    },
  );

  it("keeps all grader and scoring keys out of model-visible context and messages", () => {
    for (const developmentCase of DEVELOPMENT_CASES) {
      const bundle = createStrongBaselineParityBundle(developmentCase);
      const visible = canonicalizeJson({
        context: bundle.context,
        messages: bundle.baseline.request.messages,
      });
      for (const forbiddenKey of [
        "scoringKey",
        "graderInstructions",
        "chunkExpectations",
        "knownContradictions",
        "expectedAbstentions",
        "experimentLimitations",
        "coverageLabels",
      ]) {
        expect(visible).not.toContain(`\"${forbiddenKey}\"`);
      }
      for (const privateValue of privateScoringValues(developmentCase)) {
        expect(visible).not.toContain(privateValue);
      }
    }
  });

  it("is deterministic and canonical despite caller object insertion order", () => {
    for (const developmentCase of DEVELOPMENT_CASES) {
      const first = createStrongBaselineParityBundle(developmentCase);
      const reordered = Object.fromEntries(
        Object.entries(clone(developmentCase)).reverse(),
      );
      const second = createStrongBaselineParityBundle(reordered);
      expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
      expect(exportStrongBaselineParityManifest(reordered)).toBe(
        `${canonicalizeJson(first)}\n`,
      );
      expect(second.bundleHash).toBe(first.bundleHash);
      expect(second.comparisonInvalidatingHash).toBe(first.comparisonInvalidatingHash);
    }
  });

  it("rejects missing/extra context and altered limits, model, safety, schema, prompt, or hash", () => {
    const original = createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!);
    const mutations: Array<(value: MutableBundle) => void> = [
      (value) => delete value.context.payload.normalizedMetadata,
      (value) => { value.context.payload.unapprovedExtraContext = true; },
      (value) => { value.context.payload.generationLimits.timeoutMs += 1; },
      (value) => { value.context.payload.primaryModel.modelId = "fixture-weaker-model"; },
      (value) => { value.context.payload.safetyConstraints = []; },
      (value) => { value.context.payload.outputSchema.hash = "0".repeat(64); },
      (value) => { value.baseline.request.prompt.hash = "0".repeat(64); },
      (value) => { value.protocolBinding.promptManifestHash = "0".repeat(64); },
      (value) => { value.comparisonInvalidatingHash = "0".repeat(64); },
      (value) => { value.bundleHash = "0".repeat(64); },
    ];

    for (const mutate of mutations) {
      const candidate = clone(original) as unknown as MutableBundle;
      mutate(candidate);
      expect(StrongBaselineParityBundleSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("invalidates context-byte tampering even when the JSON remains parseable", () => {
    const bundle = clone(
      createStrongBaselineParityBundle(DEVELOPMENT_CASES[1]!),
    ) as unknown as MutableBundle;
    const parsed = JSON.parse(bundle.baseline.contextBytes) as {
      payload: { chunks: Array<{ text: string }> };
    };
    parsed.payload.chunks[0]!.text += " altered";
    bundle.baseline.contextBytes = canonicalizeJson(parsed);
    bundle.baseline.contextHash = canonicalSha256(parsed);
    expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("validates canonical strong-baseline output without treating invalid or refused content as success", () => {
    const invalid = validateStrongBaselineOutput({ unexpected: true });
    expect(invalid.status).toBe("invalid");
    expect(invalid.canonicalOutput).toBeNull();
    expect(invalid.validationIssues.length).toBeGreaterThan(0);

    const fixtureOutput = strongBaselineFixtureOutput();
    expect(StrongBaselineOutputSchema.parse(fixtureOutput)).toEqual(fixtureOutput);
    const valid = validateStrongBaselineOutput(fixtureOutput);
    expect(valid.status).toBe("valid");
    expect(valid.canonicalOutputHash).toBe(canonicalSha256(fixtureOutput));
    expect(valid.canonicalOutput).toEqual(fixtureOutput);
  });

  it("preserves timeout, refusal, invalid-output, and transport failures through immutable addressable reruns", async () => {
    for (const developmentCase of DEVELOPMENT_CASES) {
      const firstRoot = await temporaryRoot("baseline-parity-first");
      const secondRoot = await temporaryRoot("baseline-parity-second");
      const first = await materializeStrongBaselineSmoke({
        artifactRoot: firstRoot,
        developmentCase,
      });
      const second = await materializeStrongBaselineSmoke({
        artifactRoot: secondRoot,
        developmentCase,
      });

      expect(await byteSnapshot(secondRoot)).toEqual(await byteSnapshot(firstRoot));
      expect(first.parentManifest.rerunOfRunId).toBeNull();
      expect(first.rerunManifest.rerunOfRunId).toBe(first.parentManifest.runId);
      expect(second.parentManifest.configHash).toBe(first.parentManifest.configHash);
      expect(first.parentManifest.headlineEligible).toBe(false);
      expect(first.rerunManifest.evidenceMode).toBe("fixture");

      const envelopes = [
        ...first.parentAttempts.map(({ raw }) =>
          parseBaselineAttemptEvidence(first.parentAuthority, raw.rawOutput),
        ),
        ...first.rerunAttempts.map(({ raw }) =>
          parseBaselineAttemptEvidence(first.rerunAuthority, raw.rawOutput),
        ),
      ];
      expect(envelopes.map(({ outcome }) => outcome)).toEqual([
        "timeout",
        "refusal",
        "invalid_output",
        "provider_failure",
      ]);
      expect(envelopes.every(({ evidenceMode }) => evidenceMode === "fixture")).toBe(true);
      expect(envelopes.every(({ usage, cost }) => usage.status === "unavailable" && cost.status === "unavailable")).toBe(true);
      expect(envelopes.every(({ latency }) => latency.measured === false)).toBe(true);
      expect(envelopes[0]?.rawProviderOutput).toBeNull();
      expect(envelopes[1]?.validation.status).toBe("refused");
      expect(envelopes[2]?.validation.status).toBe("invalid");
      expect(envelopes.every(({ canonicalOutput }) => canonicalOutput === null)).toBe(true);
      expect(
        envelopes.every(
          ({ parityBinding }) =>
            parityBinding.bundleHash === first.bundle.bundleHash &&
            parityBinding.contextHash === first.bundle.baseline.contextHash &&
            parityBinding.pairingHash === first.bundle.comparison.pairingHash &&
            parityBinding.comparisonInvalidatingHash ===
              first.bundle.comparisonInvalidatingHash,
        ),
      ).toBe(true);

      for (const field of [
        "parityBinding",
        "requestedModel",
        "returnedModel",
        "rawProviderOutput",
        "canonicalOutput",
        "validation",
        "usage",
        "cost",
        "latency",
        "retry",
      ]) {
        const missing = clone(envelopes[0]!) as unknown as Record<string, unknown>;
        delete missing[field];
        expect(
          safeParseBaselineAttemptEvidence(first.parentAuthority, missing).success,
        ).toBe(false);
      }

      const before = await byteSnapshot(firstRoot);
      await expect(
        materializeStrongBaselineSmoke({ artifactRoot: firstRoot, developmentCase }),
      ).rejects.toThrow(/already exists/);
      expect(await byteSnapshot(firstRoot)).toEqual(before);
    }
  });

  it("rejects live/headline relabeling and traversal before creating an artifact root", async () => {
    const bundle = clone(
      createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!),
    ) as unknown as MutableBundle;
    bundle.classification.evidenceMode = "live";
    bundle.classification.headlineEligible = true;
    expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(false);

    const root = join(await temporaryRoot("baseline-traversal-parent"), "not-created");
    const developmentCase = clone(
      DEVELOPMENT_CASES[0]!,
    ) as unknown as MutableDevelopmentCase;
    developmentCase.benchmarkCase.id = "../outside";
    await expect(
      materializeStrongBaselineSmoke({ artifactRoot: root, developmentCase }),
    ).rejects.toThrow();
    await expect(readdir(root)).rejects.toThrow();
  });
});

describe("independent rejection regressions", () => {
  it("emits user bytes accepted by the versioned strong-baseline input schema", () => {
    const bundle = createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!);
    const userPayload = JSON.parse(bundle.baseline.request.messages[1].content);

    expect(() => parsePromptInput("strong-baseline", userPayload)).not.toThrow();
  });

  it("rejects arbitrary JSON relabeled succeeded and valid with a recomputed hash", async () => {
    const root = await temporaryRoot("baseline-hostile-success");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const candidate = clone(
      parseBaselineAttemptEvidence(
        materialized.rerunAuthority,
        materialized.rerunAttempts[0]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    candidate.outcome = "succeeded";
    candidate.returnedModel = {
      status: "available",
      value: candidate.requestedModel,
      reason: null,
    };
    candidate.canonicalOutput = { unexpected: true };
    candidate.canonicalOutputHash = canonicalSha256(candidate.canonicalOutput);
    candidate.validation.status = "valid";
    candidate.validation.issues = [];

    expect(
      safeParseBaselineAttemptEvidence(materialized.rerunAuthority, candidate)
        .success,
    ).toBe(false);
  });

  it("derives success only from the exact schema-valid raw fixture body", async () => {
    const root = await temporaryRoot("baseline-derived-success");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const candidate = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[1]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence & { rawProviderOutput: unknown };
    const validOutput = strongBaselineFixtureOutput();
    candidate.outcome = "succeeded";
    candidate.returnedModel = {
      status: "available",
      value: candidate.requestedModel,
      reason: null,
    };
    candidate.canonicalOutput = validOutput;
    candidate.canonicalOutputHash = canonicalSha256(validOutput);
    candidate.validation.status = "valid";
    candidate.validation.issues = [];
    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, candidate)
        .success,
    ).toBe(false);

    candidate.rawProviderOutput = validOutput;
    expect(
      parseBaselineAttemptEvidence(materialized.parentAuthority, candidate),
    ).toEqual(candidate);
  });

  it("rejects contradictory returned-model and retry evidence", async () => {
    const root = await temporaryRoot("baseline-hostile-retry");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[1]!,
    });
    const candidate = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[1]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    candidate.returnedModel = {
      status: "unavailable",
      value: null,
      reason: "fixture_cost_not_computed",
    };
    candidate.retry.willRetry = true;
    candidate.retry.reason = "initial_attempt";
    candidate.retry.retryOfAttemptId = "unrelated-attempt";

    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, candidate)
        .success,
    ).toBe(false);
  });

  it("enforces returned-model identity and the complete retry sequence state machine", async () => {
    const root = await temporaryRoot("baseline-retry-state-machine");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const original = materialized.parentAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(materialized.parentAuthority, raw.rawOutput),
    );
    expect(
      parseBaselineAttemptSequence(materialized.parentAuthority, original),
    ).toEqual(original);

    const mismatchedModel = clone(original[1]!) as unknown as MutableAttemptEvidence;
    mismatchedModel.returnedModel = {
      status: "available",
      value: { ...mismatchedModel.requestedModel, modelId: "fixture-unrequested-model" },
      reason: null,
    };
    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        mismatchedModel,
      ).success,
    ).toBe(false);

    const malformedAttempts: Array<(value: MutableAttemptEvidence) => void> = [
      (value) => { value.retry.attemptNumber = 1; },
      (value) => { value.retry.retryOfAttemptId = "unrelated-attempt"; },
      (value) => { value.retry.reason = "initial_attempt"; },
      (value) => { value.retry.willRetry = true; },
    ];
    for (const mutate of malformedAttempts) {
      const candidate = clone(original[1]!) as unknown as MutableAttemptEvidence;
      mutate(candidate);
      expect(
        safeParseBaselineAttemptEvidence(
          materialized.parentAuthority,
          candidate,
        ).success,
      ).toBe(false);
    }

    const wrongReason = clone(original) as unknown as MutableAttemptEvidence[];
    wrongReason[1]!.retry.reason = "provider_transport";
    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        wrongReason[1],
      ).success,
    ).toBe(true);
    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        wrongReason,
      ).success,
    ).toBe(false);

    const stoppedButContinued = clone(original) as unknown as MutableAttemptEvidence[];
    stoppedButContinued[0]!.retry.willRetry = false;
    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        stoppedButContinued,
      ).success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        [...original].reverse(),
      ).success,
    ).toBe(false);
  });
});

describe("expanded attempt-state rejection regressions", () => {
  it("accepts the complete fixture outcome truth table and valid terminal boundaries", async () => {
    const root = await temporaryRoot("baseline-outcome-truth-table");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const parent = materialized.parentAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(materialized.parentAuthority, raw.rawOutput),
    );
    const rerun = materialized.rerunAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(materialized.rerunAuthority, raw.rawOutput),
    );
    expect(
      parseBaselineAttemptSequence(materialized.parentAuthority, parent),
    ).toEqual(parent);
    expect(
      parseBaselineAttemptSequence(materialized.rerunAuthority, rerun),
    ).toEqual(rerun);
    expect([...parent, ...rerun].map(({ outcome, rawProviderOutput }) => ({
      outcome,
      hasRawBody: rawProviderOutput !== null,
    }))).toEqual([
      { outcome: "timeout", hasRawBody: false },
      { outcome: "refusal", hasRawBody: true },
      { outcome: "invalid_output", hasRawBody: true },
      { outcome: "provider_failure", hasRawBody: false },
    ]);
    expect([...parent, ...rerun].every(({ usage, cost, latency }) =>
      usage.status === "unavailable" &&
      cost.status === "unavailable" &&
      latency.milliseconds === 0 &&
      latency.measured === false,
    )).toBe(true);

    const terminalRefusal = clone(parent[0]!) as unknown as MutableAttemptEvidence;
    terminalRefusal.outcome = "refusal";
    terminalRefusal.rawProviderOutput = {
      fixtureKind: "authored-refusal",
      message: "Fixture refusal: no model or provider executed.",
    };
    terminalRefusal.validation.status = "refused";
    terminalRefusal.validation.issues = ["authored fixture refusal"];
    terminalRefusal.retry.willRetry = false;
    expect(
      parseBaselineAttemptSequence(materialized.parentAuthority, [terminalRefusal]),
    ).toEqual([terminalRefusal]);

    const terminalSuccess = clone(parent[0]!) as unknown as MutableAttemptEvidence;
    const validOutput = strongBaselineFixtureOutput();
    terminalSuccess.outcome = "succeeded";
    terminalSuccess.returnedModel = {
      status: "available",
      value: terminalSuccess.requestedModel,
      reason: null,
    };
    terminalSuccess.rawProviderOutput = validOutput;
    terminalSuccess.canonicalOutput = validOutput;
    terminalSuccess.canonicalOutputHash = canonicalSha256(validOutput);
    terminalSuccess.validation.status = "valid";
    terminalSuccess.validation.issues = [];
    terminalSuccess.retry.willRetry = false;
    const parsedSuccess = parseBaselineAttemptSequence(
      materialized.parentAuthority,
      [terminalSuccess],
    );
    expect(parsedSuccess).toEqual([terminalSuccess]);
    terminalSuccess.requestedModel.modelId = "caller-mutated-after-parse";
    expect(parsedSuccess[0]!.requestedModel.modelId).toBe("fixture-primary-v1");
    expect(parsedSuccess[0]!.returnedModel).toEqual({
      status: "available",
      value: {
        provider: "fixture",
        modelId: "fixture-primary-v1",
        developerFamily: "fixture-primary-family",
        baseFamily: "fixture-primary-base",
      },
      reason: null,
    });
  });

  it("rejects retry-chain splicing across independently addressable runs", async () => {
    const root = await temporaryRoot("baseline-cross-run-splice");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const first = parseBaselineAttemptEvidence(
      materialized.parentAuthority,
      materialized.parentAttempts[0]!.raw.rawOutput,
    );
    const second = clone(
      parseBaselineAttemptEvidence(
        materialized.rerunAuthority,
        materialized.rerunAttempts[1]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    second.retry.reason = "provider_timeout";

    expect(
      safeParseBaselineAttemptSequence(materialized.parentAuthority, [
        first,
        second,
      ]).success,
    ).toBe(false);
  });

  it("rejects premature terminal stop after retryable attempt one", async () => {
    const root = await temporaryRoot("baseline-premature-stop");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const first = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[0]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    first.retry.willRetry = false;

    expect(
      safeParseBaselineAttemptSequence(materialized.parentAuthority, [first])
        .success,
    ).toBe(false);
  });

  it("rejects invalid-output evidence without an actually schema-invalid raw body", async () => {
    const root = await temporaryRoot("baseline-null-invalid-output");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const invalid = clone(
      parseBaselineAttemptEvidence(
        materialized.rerunAuthority,
        materialized.rerunAttempts[0]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    invalid.rawProviderOutput = null;

    expect(
      safeParseBaselineAttemptEvidence(materialized.rerunAuthority, invalid)
        .success,
    ).toBe(false);
    invalid.rawProviderOutput = strongBaselineFixtureOutput();
    expect(
      safeParseBaselineAttemptEvidence(materialized.rerunAuthority, invalid)
        .success,
    ).toBe(false);
  });

  it("rejects refusal evidence without the authored raw refusal body", async () => {
    const root = await temporaryRoot("baseline-null-refusal");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const refusal = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[1]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    refusal.rawProviderOutput = null;

    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, refusal)
        .success,
    ).toBe(false);
    refusal.rawProviderOutput = { fixtureKind: "authored-invalid-output", unexpected: true };
    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, refusal)
        .success,
    ).toBe(false);
  });

  it("rejects fabricated usage, cost, and nonzero fixture latency on no-response timeout", async () => {
    const root = await temporaryRoot("baseline-fabricated-telemetry");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const timeout = parseBaselineAttemptEvidence(
      materialized.parentAuthority,
      materialized.parentAttempts[0]!.raw.rawOutput,
    );
    const fabricatedUsage = clone(timeout) as unknown as MutableAttemptEvidence;
    fabricatedUsage.usage = {
      status: "available",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 999,
      reason: null,
    };
    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        fabricatedUsage,
      ).success,
    ).toBe(false);

    const fabricatedCost = clone(timeout) as unknown as MutableAttemptEvidence;
    fabricatedCost.cost = {
      status: "available",
      amount: 12,
      currency: "dollars",
      reason: null,
    };
    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        fabricatedCost,
      ).success,
    ).toBe(false);

    const fabricatedLatency = clone(timeout) as unknown as MutableAttemptEvidence;
    fabricatedLatency.latency.milliseconds = 999;
    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        fabricatedLatency,
      ).success,
    ).toBe(false);
  });

  it("rejects a valid successful body under a forged output-schema hash", async () => {
    const root = await temporaryRoot("baseline-forged-output-schema");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const success = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[1]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    const validOutput = strongBaselineFixtureOutput();
    success.outcome = "succeeded";
    success.returnedModel = {
      status: "available",
      value: success.requestedModel,
      reason: null,
    };
    success.rawProviderOutput = validOutput;
    success.canonicalOutput = validOutput;
    success.canonicalOutputHash = canonicalSha256(validOutput);
    success.validation.status = "valid";
    success.validation.schemaHash = "0".repeat(64);
    success.validation.issues = [];

    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, success)
        .success,
    ).toBe(false);
  });
});

describe("passive-data and trusted-identity rejection regressions", () => {
  it("accepts frozen and null-prototype passive data while detaching caller mutation", () => {
    const developmentCase = clone(DEVELOPMENT_CASES[0]!) as unknown as {
      benchmarkCase: {
        originalQuestion: string;
        resolvedScope: object;
      };
    };
    Object.freeze(developmentCase.benchmarkCase.resolvedScope);
    const bundle = createStrongBaselineParityBundle(developmentCase);
    const originalBundleBytes = canonicalizeJson(bundle);
    developmentCase.benchmarkCase.originalQuestion = "caller mutation after creation";
    expect(canonicalizeJson(bundle)).toBe(originalBundleBytes);
    expect(StrongBaselineParityBundleSchema.parse(Object.freeze(bundle))).toEqual(bundle);

    const output = Object.assign(
      Object.create(null) as Record<string, unknown>,
      strongBaselineFixtureOutput(),
    );
    const validation = validateStrongBaselineOutput(Object.freeze(output));
    expect(validation.status).toBe("valid");
    const mutableOutput = Object.assign(
      Object.create(null) as Record<string, unknown>,
      strongBaselineFixtureOutput(),
    );
    const detachedValidation = validateStrongBaselineOutput(mutableOutput);
    mutableOutput.claims = [];
    expect(
      detachedValidation.status === "valid" &&
      detachedValidation.canonicalOutput.claims.length,
    ).toBeGreaterThan(0);
  });

  it("rejects custom prototypes before schema traversal", () => {
    const bundle = clone(
      createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!),
    ) as unknown as MutableBundle;
    Object.setPrototypeOf(bundle.context.payload.primaryModel, { callerPrototype: true });

    expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("does not execute or accept a nested development-case getter", () => {
    const developmentCase = clone(DEVELOPMENT_CASES[0]!) as unknown as {
      benchmarkCase: Record<string, unknown>;
    };
    const calls = replaceDataPropertyWithGetter(
      developmentCase.benchmarkCase,
      "originalQuestion",
    );

    expect(() => createStrongBaselineParityBundle(developmentCase)).toThrow();
    expect(calls.value).toBe(0);
  });

  it("rejects creator options and materializer envelopes with accessors passively", async () => {
    const options = { benchmarkCodeVersion: "a".repeat(40) };
    const optionCalls = replaceDataPropertyWithGetter(
      options as unknown as Record<string, unknown>,
      "benchmarkCodeVersion",
    );
    expect(() => createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!, options)).toThrow();
    expect(optionCalls.value).toBe(0);

    const root = join(await temporaryRoot("baseline-passive-materializer"), "not-created");
    const materializerInput = {
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    };
    const materializerCalls = replaceDataPropertyWithGetter(
      materializerInput as unknown as Record<string, unknown>,
      "developmentCase",
    );
    await expect(materializeStrongBaselineSmoke(materializerInput)).rejects.toThrow();
    expect(materializerCalls.value).toBe(0);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("does not execute or accept an output getter during validation", () => {
    const output = clone(strongBaselineFixtureOutput()) as unknown as Record<string, unknown>;
    const calls = replaceDataPropertyWithGetter(output, "claims");

    expect(validateStrongBaselineOutput(output).status).toBe("invalid");
    expect(calls.value).toBe(0);
  });

  it("does not execute or accept a nested parity-bundle getter", () => {
    const bundle = clone(
      createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!),
    ) as unknown as MutableBundle;
    const calls = replaceDataPropertyWithGetter(
      bundle.context.payload as unknown as Record<string, unknown>,
      "primaryModel",
    );

    expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(false);
    expect(calls.value).toBe(0);
  });

  it("does not execute or accept a requested-model getter", async () => {
    const root = await temporaryRoot("baseline-attempt-accessor");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const attempt = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[0]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    const calls = replaceDataPropertyWithGetter(
      attempt as unknown as Record<string, unknown>,
      "requestedModel",
    );

    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, attempt)
        .success,
    ).toBe(false);
    expect(calls.value).toBe(0);
  });

  it("rejects a consistently replaced parity, config, and prompt identity", async () => {
    const root = await temporaryRoot("baseline-substitute-parity");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const attempts = materialized.parentAttempts.map(({ raw }) =>
      clone(
        parseBaselineAttemptEvidence(
          materialized.parentAuthority,
          raw.rawOutput,
        ),
      ),
    ) as unknown as MutableAttemptEvidence[];
    for (const attempt of attempts) {
      attempt.parityBinding.contextHash = "1".repeat(64);
      attempt.parityBinding.pairingHash = "2".repeat(64);
      attempt.parityBinding.comparisonInvalidatingHash = "3".repeat(64);
      attempt.parityBinding.bundleHash = "4".repeat(64);
      attempt.parityBinding.baselineConfigHash = "5".repeat(64);
      attempt.parityBinding.prompt.hash = "6".repeat(64);
    }

    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        attempts,
      ).success,
    ).toBe(false);
  });

  it("rejects a consistently replaced requested-model identity", async () => {
    const root = await temporaryRoot("baseline-substitute-model");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const attempts = materialized.parentAttempts.map(({ raw }) =>
      clone(
        parseBaselineAttemptEvidence(
          materialized.parentAuthority,
          raw.rawOutput,
        ),
      ),
    ) as unknown as MutableAttemptEvidence[];
    for (const attempt of attempts) {
      attempt.requestedModel = {
        provider: "fixture-substitute",
        modelId: "fixture-substitute-v1",
        developerFamily: "fixture-substitute-family",
        baseFamily: "fixture-substitute-base",
      };
    }

    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        attempts,
      ).success,
    ).toBe(false);
  });

  it("rejects a self-consistently relabeled run and attempt chain", async () => {
    const root = await temporaryRoot("baseline-substitute-run");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const attempts = materialized.parentAttempts.map(({ raw }) =>
      clone(
        parseBaselineAttemptEvidence(
          materialized.parentAuthority,
          raw.rawOutput,
        ),
      ),
    ) as unknown as MutableAttemptEvidence[];
    const runId = "caller-selected-run";
    attempts.forEach((attempt, index) => {
      attempt.runId = runId;
      attempt.attemptId = `${runId}-attempt-${index + 1}`;
      attempt.retry.retryOfAttemptId = index === 0
        ? null
        : `${runId}-attempt-${index}`;
    });

    expect(
      safeParseBaselineAttemptSequence(
        materialized.parentAuthority,
        attempts,
      ).success,
    ).toBe(false);
  });
});

describe("accepted case and protocol source authority regressions", () => {
  it("rejects a self-consistent third case at bundle creation", () => {
    const thirdCase = callerAuthoredThirdCase();

    expect(() => createStrongBaselineParityBundle(thirdCase)).toThrow(
      /accepted development case/i,
    );
  });

  it("rejects a self-consistent third case at manifest export", () => {
    const thirdCase = callerAuthoredThirdCase();

    expect(() => exportStrongBaselineParityManifest(thirdCase)).toThrow(
      /accepted development case/i,
    );
  });

  it.each(DEVELOPMENT_CASES.map((developmentCase) => [
    developmentCase.benchmarkCase.id,
    developmentCase,
  ] as const))(
    "accepts detached canonical bytes for approved case %s",
    (_caseId, developmentCase) => {
      const detached = structuredClone(developmentCase);

      expect(createStrongBaselineParityBundle(detached).caseId).toBe(
        developmentCase.benchmarkCase.id,
      );
      expect(JSON.parse(exportStrongBaselineParityManifest(detached))).toEqual(
        createStrongBaselineParityBundle(developmentCase),
      );
    },
  );

  it("keeps the first-use config hash anchored after a nested public-condition alias mutation", async () => {
    vi.resetModules();
    const protocol = await import("../protocol/v1");
    const condition = protocol.REQUIRED_BENCHMARK_CONDITIONS.find(
      ({ id }) => id === "strong_baseline",
    )!;
    Reflect.set(condition, "label", "Caller-selected baseline label");
    const cases = await import("../cases/development-v1");
    const baseline = await import("./v1");

    expect(
      baseline.createStrongBaselineParityBundle(cases.DEVELOPMENT_CASES[0]!)
        .baseline.config.configHash,
    ).toBe(EXPECTED_MANIFEST_HASHES["library-lighting-schedule"]!.baselineConfigHash);
  });

  it("keeps config and matrix identities stable after post-use deep mutation attempts", async () => {
    vi.resetModules();
    const cases = await import("../cases/development-v1");
    const baseline = await import("./v1");
    const protocol = await import("../protocol/v1");
    const before = baseline.createStrongBaselineParityBundle(
      cases.DEVELOPMENT_CASES[0]!,
    );
    const condition = protocol.REQUIRED_BENCHMARK_CONDITIONS.find(
      ({ id }) => id === "strong_baseline",
    )!;
    const matrixHash = protocol.CONDITION_MATRIX_HASH;

    const mutationApplied = Reflect.set(
      condition,
      "label",
      "Post-use caller-selected label",
    );
    const after = baseline.createStrongBaselineParityBundle(
      cases.DEVELOPMENT_CASES[0]!,
    );

    expect(mutationApplied).toBe(false);
    expect(Object.isFrozen(condition)).toBe(true);
    expect(after.baseline.config.configHash).toBe(
      before.baseline.config.configHash,
    );
    expect(protocol.CONDITION_MATRIX_HASH).toBe(matrixHash);
  });

  it("deep-freezes detached public case and condition views across module reset order", async () => {
    vi.resetModules();
    const cases = await import("../cases/development-v1");
    const protocol = await import("../protocol/v1");
    const caseAlias = cases.DEVELOPMENT_CASES[0]!.benchmarkCase.metadataSnapshot;
    const conditionAlias = protocol.REQUIRED_BENCHMARK_CONDITIONS[0]!;
    const conditionProxy = new Proxy(conditionAlias, {
      set(target, property, value) {
        return Reflect.set(target, property, value);
      },
    });

    expect(Reflect.set(caseAlias, "id", "caller-replaced-snapshot")).toBe(false);
    expect(Reflect.set(conditionAlias, "label", "caller-replaced-label")).toBe(false);
    expect(Reflect.set(conditionProxy, "label", "proxy-replaced-label")).toBe(false);
    expect(() => cases.DEVELOPMENT_CASES.reverse()).toThrow();
    expect(
      Reflect.set(
        protocol.REQUIRED_BENCHMARK_CONDITIONS,
        "0",
        protocol.REQUIRED_BENCHMARK_CONDITIONS[1],
      ),
    ).toBe(false);

    const baseline = await import("./v1");
    expect(
      baseline.createStrongBaselineParityBundle(cases.DEVELOPMENT_CASES[0]!)
        .caseId,
    ).toBe("library-lighting-schedule");
  });
});

describe("direct exported bundle-validator authority regressions", () => {
  it("rejects a fully rehashed third-case bundle through safeParse", () => {
    const forged = callerRecomputedThirdCaseBundle();

    expect(StrongBaselineParityBundleSchema.safeParse(forged).success).toBe(
      false,
    );
  });

  it("rejects cloned and JSON-roundtripped third-case bundles through parse and safeParse", () => {
    const forged = callerRecomputedThirdCaseBundle();
    const representations = [
      structuredClone(forged),
      JSON.parse(JSON.stringify(forged)) as unknown,
    ];

    for (const representation of representations) {
      expect(
        StrongBaselineParityBundleSchema.safeParse(representation).success,
      ).toBe(false);
      expect(() => StrongBaselineParityBundleSchema.parse(representation)).toThrow(
        /accepted development case/i,
      );
    }
  });

  it.each(DEVELOPMENT_CASES.map((developmentCase) => [
    developmentCase.benchmarkCase.id,
    developmentCase,
  ] as const))(
    "accepts cloned and JSON-roundtripped approved bundle %s",
    (_caseId, developmentCase) => {
      const bundle = createStrongBaselineParityBundle(developmentCase, {
        benchmarkCodeVersion:
          _caseId === "library-lighting-schedule"
            ? "a".repeat(40)
            : "b".repeat(40),
      });
      const representations = [
        structuredClone(bundle),
        JSON.parse(JSON.stringify(bundle)) as unknown,
      ];

      for (const representation of representations) {
        expect(
          StrongBaselineParityBundleSchema.safeParse(representation).success,
        ).toBe(true);
        expect(StrongBaselineParityBundleSchema.parse(representation)).toEqual(
          bundle,
        );
      }
    },
  );

  it("keeps unapproved case authority out of every sibling exported parse entry", async () => {
    const forged = callerRecomputedThirdCaseBundle();
    const root = await temporaryRoot("baseline-exported-boundary-audit");
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: root,
      developmentCase: DEVELOPMENT_CASES[0]!,
    });
    const attempt = clone(
      parseBaselineAttemptEvidence(
        materialized.parentAuthority,
        materialized.parentAttempts[0]!.raw.rawOutput,
      ),
    ) as unknown as MutableAttemptEvidence;
    attempt.parityBinding = {
      caseId: forged.caseId,
      benchmarkCodeVersion: forged.baseline.config.benchmarkCodeVersion,
      contextHash: forged.baseline.contextHash,
      pairingHash: forged.comparison.pairingHash,
      comparisonInvalidatingHash: forged.comparisonInvalidatingHash,
      bundleHash: forged.bundleHash,
      baselineConfigHash: forged.baseline.config.configHash,
      prompt: forged.baseline.request.prompt,
    };

    expect(
      safeParseBaselineAttemptEvidence(materialized.parentAuthority, attempt)
        .success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptSequence(materialized.parentAuthority, [attempt])
        .success,
    ).toBe(false);
    expect(validateStrongBaselineOutput(forged).status).toBe("invalid");

    const notCreated = join(root, "unapproved-third-case");
    await expect(
      materializeStrongBaselineSmoke({
        artifactRoot: notCreated,
        developmentCase: callerAuthoredThirdCase(),
      }),
    ).rejects.toThrow(/accepted development case/i);
    await expect(readdir(notCreated)).rejects.toThrow();
  });
});

describe("alternate benchmark-code attempt identity regressions", () => {
  it("rejects wholesale cross-code parity-binding replacement", async () => {
    const first = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-wholesale-binding-first"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "a".repeat(40),
    });
    const second = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-wholesale-binding-second"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "b".repeat(40),
    });
    const spliced = first.parentAttempts.map(({ raw }, index) => {
      const attempt = clone(
        parseBaselineAttemptEvidence(first.parentAuthority, raw.rawOutput),
      ) as unknown as MutableAttemptEvidence;
      const replacement = parseBaselineAttemptEvidence(
        second.parentAuthority,
        second.parentAttempts[index]!.raw.rawOutput,
      );
      attempt.parityBinding = clone(replacement.parityBinding);
      return attempt;
    });

    expect(
      safeParseBaselineAttemptEvidence(first.parentAuthority, spliced[0])
        .success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptSequence(first.parentAuthority, spliced).success,
    ).toBe(false);
  });

  it.each([
    ["library-lighting-schedule", DEVELOPMENT_CASES[0]!, "a".repeat(40)],
    ["bounded-retry-reliability", DEVELOPMENT_CASES[1]!, "b".repeat(40)],
  ] as const)(
    "materializes accepted case %s end to end under an alternate code SHA",
    async (_caseId, developmentCase, benchmarkCodeVersion) => {
      const bundle = createStrongBaselineParityBundle(developmentCase, {
        benchmarkCodeVersion,
      });
      expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(
        true,
      );

      const materialized = await materializeStrongBaselineSmoke({
        artifactRoot: await temporaryRoot("baseline-alternate-code"),
        developmentCase,
        benchmarkCodeVersion,
      });
      const parentEvidence = materialized.parentAttempts.map(({ raw }) =>
        parseBaselineAttemptEvidence(
          materialized.parentAuthority,
          raw.rawOutput,
        ),
      );
      const rerunEvidence = materialized.rerunAttempts.map(({ raw }) =>
        parseBaselineAttemptEvidence(
          materialized.rerunAuthority,
          raw.rawOutput,
        ),
      );

      expect(
        parseBaselineAttemptSequence(
          materialized.parentAuthority,
          parentEvidence,
        ),
      ).toEqual(parentEvidence);
      expect(
        parseBaselineAttemptSequence(
          materialized.rerunAuthority,
          rerunEvidence,
        ),
      ).toEqual(rerunEvidence);
      expect(materialized.bundle.baseline.config.benchmarkCodeVersion).toBe(
        benchmarkCodeVersion,
      );
      expect(parentEvidence[0]!.parityBinding.benchmarkCodeVersion).toBe(
        benchmarkCodeVersion,
      );
      expect(rerunEvidence[0]!.parityBinding.benchmarkCodeVersion).toBe(
        benchmarkCodeVersion,
      );
      expect(materialized.parentManifest.configHash).toBe(
        materialized.bundle.baseline.config.configHash,
      );
      expect(materialized.rerunManifest.configHash).toBe(
        materialized.bundle.baseline.config.configHash,
      );
    },
  );

  it.each([
    ["library-lighting-schedule", DEVELOPMENT_CASES[0]!, "c".repeat(40)],
    ["bounded-retry-reliability", DEVELOPMENT_CASES[1]!, "d".repeat(40)],
  ] as const)(
    "supports a second alternate code SHA for accepted case %s",
    async (_caseId, developmentCase, benchmarkCodeVersion) => {
      const materialized = await materializeStrongBaselineSmoke({
        artifactRoot: await temporaryRoot("baseline-second-alternate-code"),
        developmentCase,
        benchmarkCodeVersion,
      });
      const parentEvidence = materialized.parentAttempts.map(({ raw }) =>
        parseBaselineAttemptEvidence(
          materialized.parentAuthority,
          raw.rawOutput,
        ),
      );
      const rerunEvidence = materialized.rerunAttempts.map(({ raw }) =>
        parseBaselineAttemptEvidence(
          materialized.rerunAuthority,
          raw.rawOutput,
        ),
      );

      expect(StrongBaselineParityBundleSchema.parse(materialized.bundle)).toEqual(
        materialized.bundle,
      );
      expect(
        parseBaselineAttemptSequence(
          materialized.parentAuthority,
          parentEvidence,
        ),
      ).toEqual(parentEvidence);
      expect(
        parseBaselineAttemptSequence(
          materialized.rerunAuthority,
          rerunEvidence,
        ),
      ).toEqual(rerunEvidence);
      expect(parentEvidence[0]!.parityBinding.benchmarkCodeVersion).toBe(
        benchmarkCodeVersion,
      );
      expect(rerunEvidence[0]!.parityBinding.benchmarkCodeVersion).toBe(
        benchmarkCodeVersion,
      );
    },
  );

  it("rejects attempt, retry, and rerun splices across benchmark-code versions", async () => {
    const first = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-code-splice-first"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "a".repeat(40),
    });
    const second = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-code-splice-second"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "c".repeat(40),
    });
    const firstParent = first.parentAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(first.parentAuthority, raw.rawOutput),
    );
    const secondParent = second.parentAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(second.parentAuthority, raw.rawOutput),
    );
    const firstRerun = first.rerunAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(first.rerunAuthority, raw.rawOutput),
    );
    const secondRerun = second.rerunAttempts.map(({ raw }) =>
      parseBaselineAttemptEvidence(second.rerunAuthority, raw.rawOutput),
    );

    expect(
      safeParseBaselineAttemptSequence(first.parentAuthority, [
        firstParent[0]!,
        secondParent[1]!,
      ]).success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptSequence(first.rerunAuthority, [
        firstRerun[0]!,
        secondRerun[1]!,
      ]).success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptSequence(first.parentAuthority, [
        firstParent[0]!,
        secondRerun[1]!,
      ]).success,
    ).toBe(false);

    const relabeled = clone(firstParent[0]!) as unknown as MutableAttemptEvidence;
    relabeled.parityBinding.benchmarkCodeVersion = "c".repeat(40);
    expect(
      safeParseBaselineAttemptEvidence(first.parentAuthority, relabeled).success,
    ).toBe(false);
  });

  it("rejects malformed versions, bundle/version mismatch, and alternate-code unapproved cases", async () => {
    for (const malformed of ["short", "g".repeat(40)]) {
      expect(() =>
        createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!, {
          benchmarkCodeVersion: malformed,
        }),
      ).toThrow();
    }

    const notCreated = join(
      await temporaryRoot("baseline-malformed-code-parent"),
      "not-created",
    );
    await expect(
      materializeStrongBaselineSmoke({
        artifactRoot: notCreated,
        developmentCase: DEVELOPMENT_CASES[0]!,
        benchmarkCodeVersion: "short",
      }),
    ).rejects.toThrow();
    await expect(readdir(notCreated)).rejects.toThrow();

    const bundle = createStrongBaselineParityBundle(DEVELOPMENT_CASES[0]!, {
      benchmarkCodeVersion: "a".repeat(40),
    });
    const mismatched = clone(bundle) as unknown as {
      baseline: { config: { benchmarkCodeVersion: string } };
    };
    mismatched.baseline.config.benchmarkCodeVersion = "c".repeat(40);
    expect(StrongBaselineParityBundleSchema.safeParse(mismatched).success).toBe(
      false,
    );
    expect(() =>
      createStrongBaselineParityBundle(callerAuthoredThirdCase(), {
        benchmarkCodeVersion: "e".repeat(40),
      }),
    ).toThrow(/accepted development case/i);
  });

  it("owns version inputs before caller mutation and keeps materialized evidence detached", async () => {
    const options = { benchmarkCodeVersion: "a".repeat(40) };
    const bundle = createStrongBaselineParityBundle(
      DEVELOPMENT_CASES[0]!,
      options,
    );
    options.benchmarkCodeVersion = "c".repeat(40);
    expect(bundle.baseline.config.benchmarkCodeVersion).toBe("a".repeat(40));
    expect(StrongBaselineParityBundleSchema.safeParse(bundle).success).toBe(true);

    const input = {
      artifactRoot: await temporaryRoot("baseline-code-input-alias"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "b".repeat(40),
    };
    const pending = materializeStrongBaselineSmoke(input);
    input.developmentCase = DEVELOPMENT_CASES[1]!;
    input.benchmarkCodeVersion = "d".repeat(40);
    const materialized = await pending;
    const evidence = parseBaselineAttemptEvidence(
      materialized.parentAuthority,
      materialized.parentAttempts[0]!.raw.rawOutput,
    );
    expect(materialized.bundle.caseId).toBe("library-lighting-schedule");
    expect(materialized.bundle.baseline.config.benchmarkCodeVersion).toBe(
      "b".repeat(40),
    );
    expect(evidence.parityBinding.benchmarkCodeVersion).toBe("b".repeat(40));

    const rawBefore = canonicalizeJson(
      materialized.parentAttempts[0]!.raw.rawOutput,
    );
    const mutableReturnedBundle = materialized.bundle as unknown as {
      baseline: { config: { benchmarkCodeVersion: string } };
    };
    mutableReturnedBundle.baseline.config.benchmarkCodeVersion = "d".repeat(40);
    expect(canonicalizeJson(materialized.parentAttempts[0]!.raw.rawOutput)).toBe(
      rawBefore,
    );
  });
});

describe("process-local attempt authority regressions", () => {
  it("validates persisted JSON only with the separately retained matching authority", async () => {
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-persisted-authority"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "a".repeat(40),
    });
    const persisted = JSON.stringify(
      materialized.parentAttempts.map(({ raw }) => raw.rawOutput),
    );
    const reloaded = JSON.parse(persisted) as unknown;

    expect(
      parseBaselineAttemptSequence(materialized.parentAuthority, reloaded),
    ).toEqual(JSON.parse(persisted));
    expect(
      safeParseBaselineAttemptSequence(materialized.rerunAuthority, reloaded)
        .success,
    ).toBe(false);

    const authorityAlias = materialized.parentAuthority;
    expect(Object.isFrozen(authorityAlias)).toBe(true);
    expect(
      Reflect.set(
        authorityAlias as unknown as object,
        "callerSelectedCode",
        "b".repeat(40),
      ),
    ).toBe(false);
    expect(parseBaselineAttemptSequence(authorityAlias, reloaded)).toEqual(
      JSON.parse(persisted),
    );

    const forgedAuthorities = [
      {} as StrongBaselineRunAuthority,
      structuredClone(
        materialized.parentAuthority,
      ) as StrongBaselineRunAuthority,
      {
        ...(materialized.parentAuthority as unknown as object),
      } as StrongBaselineRunAuthority,
      JSON.parse(
        JSON.stringify(materialized.parentAuthority),
      ) as StrongBaselineRunAuthority,
    ];
    for (const authority of forgedAuthorities) {
      expect(safeParseBaselineAttemptSequence(authority, reloaded).success).toBe(
        false,
      );
    }
  });

  it("rejects cross-code, cross-case, and cross-run authorities", async () => {
    const first = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-authority-first"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "a".repeat(40),
    });
    const secondCode = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-authority-second-code"),
      developmentCase: DEVELOPMENT_CASES[0]!,
      benchmarkCodeVersion: "b".repeat(40),
    });
    const secondCase = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-authority-second-case"),
      developmentCase: DEVELOPMENT_CASES[1]!,
      benchmarkCodeVersion: "a".repeat(40),
    });
    const firstParent = first.parentAttempts[0]!.raw.rawOutput;
    const firstRerun = first.rerunAttempts[0]!.raw.rawOutput;
    const otherCode = secondCode.parentAttempts[0]!.raw.rawOutput;
    const otherCase = secondCase.parentAttempts[0]!.raw.rawOutput;

    expect(
      safeParseBaselineAttemptEvidence(
        secondCode.parentAuthority,
        firstParent,
      ).success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptEvidence(first.parentAuthority, otherCode)
        .success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptEvidence(first.parentAuthority, otherCase)
        .success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptEvidence(first.parentAuthority, firstRerun)
        .success,
    ).toBe(false);
    expect(
      safeParseBaselineAttemptEvidence(first.rerunAuthority, firstParent)
        .success,
    ).toBe(false);
  });

  it("rejects fake and proxied authorities before traversing evidence", async () => {
    const materialized = await materializeStrongBaselineSmoke({
      artifactRoot: await temporaryRoot("baseline-authority-passive-boundary"),
      developmentCase: DEVELOPMENT_CASES[1]!,
      benchmarkCodeVersion: "d".repeat(40),
    });
    const evidence = clone(
      materialized.parentAttempts[0]!.raw.rawOutput,
    ) as unknown as Record<string, unknown>;
    const evidenceCalls = replaceDataPropertyWithGetter(evidence, "requestedModel");
    let authorityTraps = 0;
    const proxyAuthority = new Proxy(materialized.parentAuthority, {
      get() {
        authorityTraps += 1;
        throw new Error("authority proxy trap must not execute");
      },
      getOwnPropertyDescriptor() {
        authorityTraps += 1;
        throw new Error("authority proxy trap must not execute");
      },
      ownKeys() {
        authorityTraps += 1;
        throw new Error("authority proxy trap must not execute");
      },
    });

    expect(
      safeParseBaselineAttemptEvidence(proxyAuthority, evidence).success,
    ).toBe(false);
    expect(authorityTraps).toBe(0);
    expect(evidenceCalls.value).toBe(0);

    const revoked = Proxy.revocable(materialized.parentAuthority, {});
    revoked.revoke();
    expect(
      safeParseBaselineAttemptEvidence(revoked.proxy, evidence).success,
    ).toBe(false);
    expect(evidenceCalls.value).toBe(0);

    expect(
      safeParseBaselineAttemptEvidence(
        {} as StrongBaselineRunAuthority,
        evidence,
      ).success,
    ).toBe(false);
    expect(evidenceCalls.value).toBe(0);

    expect(
      safeParseBaselineAttemptEvidence(
        materialized.parentAuthority,
        evidence,
      ).success,
    ).toBe(false);
    expect(evidenceCalls.value).toBe(0);
  });

  it("exports only authority-bound attempt acceptance APIs", async () => {
    const baselineModule = await import("./v1");

    expect(baselineModule).not.toHaveProperty("BaselineAttemptEvidenceSchema");
    expect(baselineModule).not.toHaveProperty("BaselineAttemptSequenceSchema");
    expect(baselineModule).toHaveProperty("parseBaselineAttemptEvidence");
    expect(baselineModule).toHaveProperty("safeParseBaselineAttemptEvidence");
    expect(baselineModule).toHaveProperty("parseBaselineAttemptSequence");
    expect(baselineModule).toHaveProperty("safeParseBaselineAttemptSequence");
  });
});
