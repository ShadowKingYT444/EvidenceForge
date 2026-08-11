import { describe, expect, it } from "vitest";

import {
  BENCHMARK_PROTOCOL_VERSION,
  FROZEN_CONSUMER_EDGE,
  REQUIRED_BENCHMARK_CONDITIONS,
  BenchmarkCaseSchema,
  BenchmarkConfigSchema,
  TrialRecordSchema,
  assessComparisonPair,
  assessTrialPair,
  createBenchmarkCase,
  createBenchmarkConfig,
  type BenchmarkCase,
} from "./v1";

const hash = (digit: string) => digit.repeat(64);

function developmentCase() {
  return createBenchmarkCase({
    id: "development-materials-01",
    version: "1.0.0",
    role: "development",
    domain: "materials_engineering",
    originalQuestion:
      "Does the bounded packet support a biodegradable sensor-power pilot?",
    resolvedScope: {
      question:
        "Does the approved packet justify a non-hazardous 72-hour sensor-power pilot?",
      constraints: [
        "bounded approved packet only",
        "educational proposal requiring qualified review",
      ],
    },
    packet: {
      fingerprint: hash("1"),
      sourceHashes: [hash("2"), hash("3")],
      chunkHashes: [hash("4"), hash("5")],
    },
    metadataSnapshot: {
      id: "metadata-development-materials-01",
      hash: hash("6"),
      capturedAt: "2026-08-06T20:00:00.000Z",
    },
    expectedFailureLabels: [
      "conflicting_evidence",
      "insufficient_or_unresolved_evidence",
      "experiment_confound_or_inferential_limitation",
    ],
    safety: {
      nonMedical: true,
      nonHazardous: true,
      notes: ["No wet-lab execution instructions or autonomous actions."],
    },
    graderInstructions:
      "Score only against literal approved chunks and preserve uncertainty.",
  });
}

function promptManifest() {
  return [
    { id: "strong-baseline", version: "1.0.0", hash: hash("7") },
    { id: "clarify-and-decompose", version: "1.0.0", hash: hash("8") },
    { id: "extract-evidence", version: "1.0.0", hash: hash("9") },
    { id: "assess-entailment", version: "1.0.0", hash: hash("a") },
    { id: "synthesize-conclusions", version: "1.0.0", hash: hash("b") },
    { id: "plan-experiment", version: "1.0.0", hash: hash("c") },
    { id: "review-experiment", version: "1.0.0", hash: hash("d") },
    { id: "revise-experiment", version: "1.0.0", hash: hash("e") },
  ];
}

function config(
  conditionId:
    | "strong_baseline"
    | "complete_workflow"
    | "no_verification"
    | "no_adversarial_review",
  overrides: Record<string, unknown> = {},
) {
  const benchmarkCase = developmentCase();
  const base = {
    id: `development-materials-01-${conditionId.replaceAll("_", "-")}`,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    case: benchmarkCase,
    conditionId,
    primaryModel: {
      provider: "groq",
      modelId: "openai/gpt-oss-120b",
      developerFamily: "openai",
      baseFamily: "gpt-oss",
    },
    adversarialReviewerModel: {
      provider: "nvidia",
      modelId: "meta/llama-3.3-70b-instruct",
      developerFamily: "meta",
      baseFamily: "llama",
    },
    generation: {
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      temperature: 0,
      topP: 1,
      responseFormat: "json_schema",
      seedPolicy: "unsupported",
    },
    outputContract: {
      schemaId: "workflow-benchmark-output",
      schemaVersion: "1.0.0",
      schemaHash: hash("f"),
      requiredFieldsHash: hash("0"),
      safetyConstraintsHash: hash("1"),
    },
    promptManifest: promptManifest(),
    benchmarkCodeVersion: "0261bb6dcec07a68dccfe04d50f021640afd7d73",
    retryPolicy: {
      maximumAttempts: 2,
      repairInvalidOutput: true,
      retryableFailureKinds: [
        "provider_transport",
        "provider_timeout",
        "invalid_structured_output",
      ],
    },
    fallbackPolicy: {
      mode: "forbidden",
      configuredModel: null,
    },
    trialPlan: {
      count: 3,
      trialIds: ["trial-1", "trial-2", "trial-3"],
      trialSeeds: [null, null, null],
      selectionPolicy: "report_all_no_best_of",
    },
    exclusionPolicy: {
      allowedReasons: [
        "safety_gate_blocked",
        "rights_gate_blocked",
        "provider_unavailable_before_attempt",
        "configuration_invalid_before_attempt",
      ],
      denominatorPolicy: "retain_failures_report_pre_run_exclusions",
    },
    evidenceMode: "simulated",
  } as const;

  return createBenchmarkConfig({ ...base, ...overrides });
}

describe("benchmark protocol v1", () => {
  it("freezes the exact four required conditions and their semantics", () => {
    expect(REQUIRED_BENCHMARK_CONDITIONS.map(({ id }) => id)).toEqual([
      "strong_baseline",
      "complete_workflow",
      "no_verification",
      "no_adversarial_review",
    ]);
    expect(
      REQUIRED_BENCHMARK_CONDITIONS.find(
        ({ id }) => id === "strong_baseline",
      ),
    ).toMatchObject({ comprehensiveCallCount: 1 });
    expect(
      REQUIRED_BENCHMARK_CONDITIONS.find(
        ({ id }) => id === "no_verification",
      ),
    ).toMatchObject({
      deterministicVerificationContributions: false,
      entailmentStrengthVerificationContributions: false,
    });
    expect(
      REQUIRED_BENCHMARK_CONDITIONS.find(
        ({ id }) => id === "no_adversarial_review",
      ),
    ).toMatchObject({ adversarialReview: false, revisionAfterReview: false });
  });

  it("reuses the independently frozen contract, packet, fixture, and prompt edge", () => {
    expect(FROZEN_CONSUMER_EDGE).toMatchObject({
      contractVersion: "0.1",
      packetFingerprint:
        "944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e",
      goldenFixtureHash:
        "f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7",
    });
    expect(FROZEN_CONSUMER_EDGE.promptManifest).toHaveLength(9);
    expect(FROZEN_CONSUMER_EDGE.promptManifestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("hashes a strict, safe, bounded case and rejects a stale case hash", () => {
    const benchmarkCase = developmentCase();
    expect(BenchmarkCaseSchema.parse(benchmarkCase)).toEqual(benchmarkCase);

    expect(() =>
      BenchmarkCaseSchema.parse({
        ...benchmarkCase,
        graderInstructions: "Changed after freeze.",
      }),
    ).toThrow(/caseHash/);
    expect(() =>
      createBenchmarkCase({
        ...benchmarkCase,
        caseHash: undefined,
        domain: "clinical_medicine",
      } as never),
    ).toThrow();
  });

  it("hashes the whole prompt manifest and every pairing-critical field", () => {
    const complete = config("complete_workflow");
    expect(BenchmarkConfigSchema.parse(complete)).toEqual(complete);
    expect(complete.promptManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(complete.pairingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(complete.configHash).toMatch(/^[a-f0-9]{64}$/);

    expect(() =>
      BenchmarkConfigSchema.parse({
        ...complete,
        benchmarkCodeVersion: "1".repeat(40),
      }),
    ).toThrow(/pairingHash|configHash/);
  });

  const invalidatingMutations: ReadonlyArray<
    readonly [string, Record<string, unknown>]
  > = [
    ["primary_model_changed", { primaryModel: { provider: "groq", modelId: "other", developerFamily: "other", baseFamily: "other" } }],
    ["reviewer_model_changed", { adversarialReviewerModel: { provider: "nvidia", modelId: "other", developerFamily: "other", baseFamily: "other" } }],
    ["generation_config_changed", { generation: { maxOutputTokens: 2048, timeoutMs: 60000, temperature: 0, topP: 1, responseFormat: "json_schema", seedPolicy: "unsupported" } }],
    ["source_packet_changed", { case: { packet: { fingerprint: hash("0") } } }],
    ["metadata_snapshot_changed", { case: { metadataSnapshot: { hash: hash("0") } } }],
    ["prompt_manifest_changed", { promptManifest: [...promptManifest().slice(0, -1), { id: "revise-experiment", version: "1.0.1", hash: hash("0") }] }],
    ["benchmark_code_changed", { benchmarkCodeVersion: "1".repeat(40) }],
    ["retry_policy_changed", { retryPolicy: { maximumAttempts: 1, repairInvalidOutput: false, retryableFailureKinds: [] } }],
    ["fallback_policy_changed", { fallbackPolicy: { mode: "explicit_invalidating", configuredModel: { provider: "groq", modelId: "fallback", developerFamily: "other", baseFamily: "other" } } }],
    ["trial_plan_changed", { trialPlan: { count: 3, trialIds: ["trial-a", "trial-b", "trial-c"], trialSeeds: [null, null, null], selectionPolicy: "report_all_no_best_of" } }],
    ["exclusion_policy_changed", { exclusionPolicy: { allowedReasons: ["rights_gate_blocked"], denominatorPolicy: "retain_failures_report_pre_run_exclusions" } }],
  ];

  it.each(invalidatingMutations)(
    "visibly invalidates a pair when %s",
    (expectedReason, mutation) => {
      const left = config("strong_baseline");
      const rightInput = structuredClone(
        config("complete_workflow"),
      ) as unknown as Record<string, unknown>;
      if ("case" in mutation) {
        const currentCase = rightInput.case as BenchmarkCase;
        const caseMutation = mutation.case as {
          packet?: { fingerprint?: string };
          metadataSnapshot?: { hash?: string };
        };
        rightInput.case = createBenchmarkCase({
          ...currentCase,
          ...caseMutation,
          packet: {
            ...currentCase.packet,
            ...caseMutation.packet,
          },
          metadataSnapshot: {
            ...currentCase.metadataSnapshot,
            ...caseMutation.metadataSnapshot,
          },
        });
      } else {
        Object.assign(rightInput, mutation);
      }
      delete rightInput.promptManifestHash;
      delete rightInput.pairingHash;
      delete rightInput.configHash;
      const right = createBenchmarkConfig(rightInput);

      const assessment = assessComparisonPair({
        left,
        right,
        reportingUse: "development",
      });
      expect(assessment.valid).toBe(false);
      expect(assessment.invalidationReasons).toContain(expectedReason);
    },
  );

  it("permits only deliberate condition differences for a development comparison", () => {
    const assessment = assessComparisonPair({
      left: config("strong_baseline"),
      right: config("complete_workflow"),
      reportingUse: "development",
    });
    expect(assessment).toMatchObject({
      valid: true,
      invalidationReasons: [],
    });
  });

  it("makes development and non-live evidence visibly ineligible for headline results", () => {
    const assessment = assessComparisonPair({
      left: config("strong_baseline"),
      right: config("complete_workflow"),
      reportingUse: "headline",
    });
    expect(assessment.valid).toBe(false);
    expect(assessment.invalidationReasons).toEqual([
      "development_case_not_headline_eligible",
      "non_live_evidence_not_headline_eligible",
    ]);
  });

  it("freezes three trials, visible fallback use, and explicit exclusions without results", () => {
    const benchmarkConfig = config("complete_workflow");
    const record = TrialRecordSchema.parse({
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      configHash: benchmarkConfig.configHash,
      caseId: benchmarkConfig.case.id,
      conditionId: benchmarkConfig.conditionId,
      trialId: "trial-1",
      evidenceMode: "simulated",
      seed: null,
      attempted: true,
      fallbackUsed: true,
      actualPrimaryModel: benchmarkConfig.primaryModel,
      fallbackModel: {
        provider: "groq",
        modelId: "fallback",
        developerFamily: "other",
        baseFamily: "other",
      },
      excluded: false,
      exclusionReason: null,
    });
    expect(record).not.toHaveProperty("metrics");
    expect(record.fallbackUsed).toBe(true);

    const baselineConfig = config("strong_baseline");
    const baselineTrial = TrialRecordSchema.parse({
      ...record,
      configHash: baselineConfig.configHash,
      conditionId: baselineConfig.conditionId,
      fallbackUsed: false,
      fallbackModel: null,
    });
    const assessment = assessTrialPair({
      leftConfig: baselineConfig,
      rightConfig: benchmarkConfig,
      leftTrial: baselineTrial,
      rightTrial: record,
      reportingUse: "development",
    });
    expect(assessment.valid).toBe(false);
    expect(assessment.invalidationReasons).toContain("fallback_observed");
  });
});
