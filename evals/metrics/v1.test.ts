import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/contracts/canonical";
import {
  WORKFLOW_DEVELOPMENT_CASES,
  createWorkflowConditionFixture,
  createWorkflowDevelopmentMatrix,
} from "../conditions/workflow-v1";
import {
  materializeStrongBaselineSmoke,
  type StrongBaselineRunAuthority,
} from "../baseline/v1";
import { DEVELOPMENT_CASES } from "../cases/development-v1";
import {
  assessComparisonEligibility,
  materializeDevelopmentComparisonFixtureSet,
} from "../comparison/parity-v1";
import { createBenchmarkConfig } from "../protocol/v1";
import type { RecordedAttempt } from "../runner/v1";
import {
  METRICS_VERSION,
  MetricArtifactSchema,
  MetricRunRecordSchema,
  type MetricArtifact,
  type MetricComparisonBinding,
  buildMetricExports,
  createBaselineMetricRunRecord as createAuthorizedBaselineMetricRunRecord,
  createDeterministicMetricArtifact,
  createMetricTestFixtureRecord,
  createWorkflowMetricRunRecord as createAuthorizedWorkflowMetricRunRecord,
  parseMetricArtifact,
  retainMetricArtifactAuthority,
  retainMetricRunRecordAuthority,
  revokeMetricArtifactAuthority,
  revokeMetricComparisonPairAuthority,
  revokeMetricRunRecordAuthority,
} from "./v1";

function clone<T>(value: T): T {
  return structuredClone(value);
}

type ComparisonPair = Awaited<
  ReturnType<typeof materializeDevelopmentComparisonFixtureSet>
>["pairs"][number];

let comparisonRoot: string;
let comparisonPairs: ComparisonPair[];
const COMPARISON_BENCHMARK_CODE_VERSION =
  "348324361782ccbaaed9e959eec79fcf5bb262b6";

beforeAll(async () => {
  comparisonRoot = await mkdtemp(join(tmpdir(), "metric-comparison-pairs-"));
  comparisonPairs = (
    await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: comparisonRoot,
    })
  ).pairs;
});

afterAll(async () => {
  if (comparisonRoot) {
    await rm(comparisonRoot, { recursive: true, force: true });
  }
});

function validComparisonForFixture(
  fixture: ReturnType<typeof createWorkflowDevelopmentMatrix>[number],
): MetricComparisonBinding {
  const pair = comparisonPairs.find(
    ({ candidate }) =>
      candidate.caseId === fixture.developmentCase.benchmarkCase.id &&
      candidate.rightConditionId === fixture.condition.id &&
      candidate.trialId === fixture.runConfig.trialId,
  );
  if (!pair) throw new Error("matching comparison pair fixture is required");
  return {
    authority: pair.authority,
    candidate: pair.candidate,
    assessment: assessComparisonEligibility(pair.authority, pair.candidate),
  };
}

function generationChangedComparisonForFixture(
  fixture: ReturnType<typeof createWorkflowDevelopmentMatrix>[number],
): MetricComparisonBinding {
  const valid = validComparisonForFixture(fixture);
  const candidate = clone(valid.candidate);
  candidate.rightConfig = createBenchmarkConfig({
    ...candidate.rightConfig,
    generation: {
      ...candidate.rightConfig.generation,
      maxOutputTokens: candidate.rightConfig.generation.maxOutputTokens + 1,
    },
  });
  candidate.rightTrial.configHash = candidate.rightConfig.configHash;
  return {
    authority: valid.authority,
    candidate,
    assessment: assessComparisonEligibility(valid.authority, candidate),
  };
}

function createWorkflowMetricRunRecord(
  fixture: ReturnType<typeof createWorkflowDevelopmentMatrix>[number],
  comparisonOrMapIndex?: MetricComparisonBinding | number,
) {
  const comparison =
    typeof comparisonOrMapIndex === "object"
      ? comparisonOrMapIndex
      : validComparisonForFixture(fixture);
  return createAuthorizedWorkflowMetricRunRecord(fixture, comparison);
}

type BaselineMetricInput = Parameters<
  typeof createAuthorizedBaselineMetricRunRecord
>[0];

function createBaselineMetricRunRecord(
  input: Omit<BaselineMetricInput, "comparison"> & {
    comparison?: MetricComparisonBinding;
  },
) {
  const comparison =
    input.comparison ??
    (() => {
      const pair = comparisonPairs.find(
        ({ candidate }) =>
          candidate.caseId === input.manifest.caseReference.id &&
          candidate.rightConditionId === "complete_workflow" &&
          candidate.trialId === input.manifest.trialId,
      );
      if (!pair) throw new Error("matching baseline comparison pair is required");
      return {
        authority: pair.authority,
        candidate: pair.candidate,
        assessment: assessComparisonEligibility(
          pair.authority,
          pair.candidate,
        ),
      };
    })();
  return createAuthorizedBaselineMetricRunRecord({ ...input, comparison });
}

function failedAttemptFrom(attempt: RecordedAttempt): RecordedAttempt {
  return {
    raw: {
      ...clone(attempt.raw),
      status: "failed",
      rawOutput: null,
      failure: {
        kind: "provider_timeout",
        message: "Preserved fixture timeout.",
        retryable: false,
        providerCode: null,
      },
    },
    parsed: {
      schemaVersion: attempt.parsed.schemaVersion,
      runId: attempt.parsed.runId,
      attemptId: attempt.parsed.attemptId,
      attemptNumber: attempt.parsed.attemptNumber,
      trialId: attempt.parsed.trialId,
      evidenceMode: attempt.parsed.evidenceMode,
      parseStatus: "not_parsed",
      canonicalRun: null,
      canonicalRunHash: null,
      validationIssues: [],
    },
  };
}

function metric(
  artifact: ReturnType<typeof createDeterministicMetricArtifact>,
  id: string,
) {
  const found = artifact.metrics.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing metric ${id}`);
  return found;
}

function rehash<T extends { artifactHash: string }>(artifact: T): T {
  const { artifactHash: oldHash, ...payload } = artifact;
  void oldHash;
  return {
    ...artifact,
    artifactHash: canonicalSha256(payload),
  };
}

describe("deterministic metric artifact v1", () => {
  it("publishes the versioned metric compiler contract", () => {
    expect(METRICS_VERSION).toBe("1.0.0");
  });

  it("retains an authority-issued generation-config invalidation in comparative metrics", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "metric-comparison-authority-red-"),
    );
    try {
      const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
        artifactRoot,
      });
      const pair = fixtureSet.pairs.find(
        ({ candidate }) =>
          candidate.rightConditionId === "complete_workflow" &&
          candidate.trialId === "trial-1",
      )!;
      const fixture = createWorkflowDevelopmentMatrix().find(
        ({ developmentCase, condition, runConfig }) =>
          developmentCase.benchmarkCase.id === pair.candidate.caseId &&
          condition.id === pair.candidate.rightConditionId &&
          runConfig.trialId === pair.candidate.trialId,
      )!;
      const changed = clone(pair.candidate);
      changed.rightConfig = createBenchmarkConfig({
        ...changed.rightConfig,
        generation: {
          ...changed.rightConfig.generation,
          maxOutputTokens:
            changed.rightConfig.generation.maxOutputTokens + 1,
        },
      });
      changed.rightTrial.configHash = changed.rightConfig.configHash;
      const assessment = assessComparisonEligibility(pair.authority, changed);
      expect(assessment).toMatchObject({
        eligible: false,
        invalidationReasons: expect.arrayContaining([
          "generation_config_changed",
        ]),
        excludedFromAggregates: true,
      });

      const record = createWorkflowMetricRunRecord(fixture, {
        authority: pair.authority,
        candidate: changed,
        assessment,
      });
      const artifact = createDeterministicMetricArtifact({
        runs: [record],
        preRunExclusions: [],
      });

      expect(artifact.summary.comparisonInvalidRuns).toBe(1);
      expect(artifact.invalidComparisons).toEqual([
        expect.objectContaining({
          runId: record.runId,
          reasons: expect.arrayContaining(["generation_config_changed"]),
        }),
      ]);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("derives the complete issued invalidation-reason set without caller selection", () => {
    const fixture = createWorkflowDevelopmentMatrix()[0]!;
    const valid = validComparisonForFixture(fixture);
    const candidate = clone(valid.candidate);
    const promptManifest = clone(candidate.rightConfig.promptManifest);
    promptManifest[0]!.version = "9.9.9";
    candidate.rightConfig = createBenchmarkConfig({
      ...candidate.rightConfig,
      promptManifest,
      primaryModel: {
        provider: "fixture",
        modelId: "fixture-primary-changed",
        developerFamily: "fixture-primary-family",
        baseFamily: "fixture-primary-base",
      },
      generation: {
        ...candidate.rightConfig.generation,
        maxOutputTokens: candidate.rightConfig.generation.maxOutputTokens + 1,
      },
      fallbackPolicy: {
        mode: "explicit_invalidating",
        configuredModel: {
          provider: "fixture",
          modelId: "fixture-fallback-v1",
          developerFamily: "fixture-fallback-family",
          baseFamily: "fixture-fallback-base",
        },
      },
      retryPolicy: {
        maximumAttempts: 1,
        repairInvalidOutput: false,
        retryableFailureKinds: [],
      },
    });
    candidate.rightTrial.configHash = candidate.rightConfig.configHash;
    candidate.rightTrial.actualPrimaryModel = candidate.rightConfig.primaryModel;
    const assessment = assessComparisonEligibility(valid.authority, candidate);
    expect(assessment.invalidationReasons).toEqual(
      expect.arrayContaining([
        "primary_model_changed",
        "generation_config_changed",
        "prompt_manifest_changed",
        "retry_policy_changed",
        "fallback_policy_changed",
      ]),
    );
    expect(assessment.invalidationReasons).toHaveLength(5);

    const record = createWorkflowMetricRunRecord(fixture, {
      authority: valid.authority,
      candidate,
      assessment,
    });
    expect(record.comparison).toEqual({
      status: "invalid",
      reasons: assessment.invalidationReasons,
    });
    const artifact = createDeterministicMetricArtifact({
      runs: [record],
      preRunExclusions: [],
    });
    expect(artifact.invalidComparisons[0]!.reasons).toEqual(
      [...assessment.invalidationReasons].sort(),
    );
  });

  it("keeps partial and all-invalid comparison matrices out of comparative denominators", () => {
    const fixtures = createWorkflowDevelopmentMatrix()
      .filter(({ condition }) => condition.id === "complete_workflow")
      .slice(0, 3);
    const partialRecords = fixtures.map((fixture, index) =>
      createWorkflowMetricRunRecord(
        fixture,
        index < 2
          ? generationChangedComparisonForFixture(fixture)
          : validComparisonForFixture(fixture),
      ),
    );
    const partial = createDeterministicMetricArtifact({
      runs: partialRecords,
      preRunExclusions: [],
    });
    expect(partial.summary).toMatchObject({
      attemptedRuns: 3,
      comparisonInvalidRuns: 2,
    });
    expect(partial.conditionMetrics[0]!.comparisonEligibleRuns).toBe(1);

    const allInvalidRecords = fixtures.map((fixture) =>
      createWorkflowMetricRunRecord(
        fixture,
        generationChangedComparisonForFixture(fixture),
      ),
    );
    const allInvalid = createDeterministicMetricArtifact({
      runs: allInvalidRecords,
      preRunExclusions: [],
    });
    expect(allInvalid.summary).toMatchObject({
      attemptedRuns: 3,
      comparisonInvalidRuns: 3,
    });
    expect(allInvalid.conditionMetrics[0]!.comparisonEligibleRuns).toBe(0);
    expect(metric(allInvalid, "schema_error_rate").denominator).toBe(3);
  });

  it("requires exact pair authority and issued assessment identities before fixture traversal", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "metric-pair-authority-"));
    try {
      const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
        artifactRoot,
      });
      const pair = fixtureSet.pairs[0]!;
      const other = fixtureSet.pairs[1]!;
      const fixture = createWorkflowDevelopmentMatrix().find(
        ({ developmentCase, condition, runConfig }) =>
          developmentCase.benchmarkCase.id === pair.candidate.caseId &&
          condition.id === pair.candidate.rightConditionId &&
          runConfig.trialId === pair.candidate.trialId,
      )!;
      const assessment = assessComparisonEligibility(
        pair.authority,
        pair.candidate,
      );
      const binding = {
        authority: pair.authority,
        candidate: pair.candidate,
        assessment,
      };
      const recomputed = assessComparisonEligibility(
        pair.authority,
        pair.candidate,
      );
      expect(
        createAuthorizedWorkflowMetricRunRecord(fixture, {
          ...binding,
          assessment: recomputed,
        }).comparison.status,
      ).toBe("valid");

      expect(() =>
        createAuthorizedWorkflowMetricRunRecord(fixture, undefined as never),
      ).toThrow(/comparison|binding|required/i);
      for (const authority of [
        {},
        clone(pair.authority),
        { ...pair.authority },
        JSON.parse(JSON.stringify(pair.authority)),
        other.authority,
      ]) {
        expect(() =>
          createAuthorizedWorkflowMetricRunRecord(fixture, {
            ...binding,
            authority: authority as never,
          }),
        ).toThrow(/authority|authorize|pair/i);
      }
      for (const candidateAssessment of [
        clone(assessment),
        { ...assessment },
        JSON.parse(JSON.stringify(assessment)),
        assessComparisonEligibility(other.authority, other.candidate),
      ]) {
        expect(() =>
          createAuthorizedWorkflowMetricRunRecord(fixture, {
            ...binding,
            assessment: candidateAssessment,
          }),
        ).toThrow(/assessment|issued|contradict|authority/i);
      }
      const changedAfterAssessment = clone(pair.candidate);
      changedAfterAssessment.preference = "right";
      expect(() =>
        createAuthorizedWorkflowMetricRunRecord(fixture, {
          ...binding,
          candidate: changedAfterAssessment,
        }),
      ).toThrow(/assessment|contradict|authorize/i);

      const crossRun = clone(pair.candidate);
      crossRun.leftRunId = "caller-selected-left-run";
      crossRun.rightRunId = "caller-selected-right-run";
      const crossConfig = clone(pair.candidate);
      crossConfig.rightConfig = createBenchmarkConfig({
        ...crossConfig.rightConfig,
        benchmarkCodeVersion: "a".repeat(40),
      });
      crossConfig.rightTrial.configHash = crossConfig.rightConfig.configHash;
      const crossCandidates = [
        crossRun,
        crossConfig,
        fixtureSet.pairs.find(
          ({ candidate }) => candidate.caseId !== pair.candidate.caseId,
        )!.candidate,
        fixtureSet.pairs.find(
          ({ candidate }) =>
            candidate.caseId === pair.candidate.caseId &&
            candidate.rightConditionId !== pair.candidate.rightConditionId &&
            candidate.trialId === pair.candidate.trialId,
        )!.candidate,
        fixtureSet.pairs.find(
          ({ candidate }) =>
            candidate.caseId === pair.candidate.caseId &&
            candidate.rightConditionId === pair.candidate.rightConditionId &&
            candidate.trialId !== pair.candidate.trialId,
        )!.candidate,
      ];
      for (const crossCandidate of crossCandidates) {
        expect(() =>
          createAuthorizedWorkflowMetricRunRecord(fixture, {
            authority: pair.authority,
            candidate: crossCandidate,
            assessment: assessComparisonEligibility(
              pair.authority,
              crossCandidate,
            ),
          }),
        ).toThrow(/authority|authorize|pair/i);
      }

      let accessorReads = 0;
      const accessorBinding = { ...binding };
      Object.defineProperty(accessorBinding, "assessment", {
        enumerable: true,
        get() {
          accessorReads += 1;
          return assessment;
        },
      });
      expect(() =>
        createAuthorizedWorkflowMetricRunRecord(
          fixture,
          accessorBinding as never,
        ),
      ).toThrow(/data property/i);
      expect(accessorReads).toBe(0);

      let traps = 0;
      const hostileHandler: ProxyHandler<object> = {
        get() {
          traps += 1;
          throw new Error("comparison proxy trap executed");
        },
        ownKeys() {
          traps += 1;
          throw new Error("comparison proxy trap executed");
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error("comparison proxy trap executed");
        },
      };
      for (const hostileBinding of [
        new Proxy(binding, hostileHandler),
        { ...binding, authority: new Proxy(pair.authority, hostileHandler) },
        { ...binding, candidate: new Proxy(pair.candidate, hostileHandler) },
        { ...binding, assessment: new Proxy(assessment, hostileHandler) },
      ]) {
        expect(() =>
          createAuthorizedWorkflowMetricRunRecord(
            fixture,
            hostileBinding as never,
          ),
        ).toThrow(/proxy/i);
      }
      expect(traps).toBe(0);

      const record = createAuthorizedWorkflowMetricRunRecord(fixture, binding);
      const artifact = createDeterministicMetricArtifact({
        runs: [record],
        preRunExclusions: [],
      });
      revokeMetricComparisonPairAuthority(pair.authority);
      expect(() => buildMetricExports(artifact)).toThrow(/revoked/i);
      expect(() =>
        createAuthorizedWorkflowMetricRunRecord(fixture, binding),
      ).toThrow(/revoked/i);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("derives every required metric from accepted workflow fixtures", () => {
    const records = createWorkflowDevelopmentMatrix().map((fixture) =>
      createWorkflowMetricRunRecord(fixture),
    );
    const artifact = createDeterministicMetricArtifact({
      runs: records,
      preRunExclusions: [],
    });
    const expectedCitations = records.reduce(
      (total, record) =>
        total +
        record.attempts.reduce(
          (attemptTotal, { parsed }) =>
            attemptTotal +
            (parsed.parseStatus === "valid"
              ? parsed.canonicalRun.evidenceCards.length
              : 0),
          0,
        ),
      0,
    );

    expect(artifact.evidenceMode).toBe("simulated");
    expect(artifact.reportingUse).toBe("development");
    expect(artifact.headlineEligible).toBe(false);
    expect(artifact.summary).toMatchObject({
      attemptedRuns: records.length,
      retainedFailedRuns: 0,
      preRunExcluded: 0,
      comparisonInvalidRuns: 0,
    });
    expect(artifact.metrics.map(({ id }) => id)).toEqual([
      "call_count_per_attempted_run",
      "citation_existence",
      "contradiction_recall",
      "estimated_cost_micro_usd_per_attempted_run",
      "experiment_completeness",
      "latency_ms_per_attempted_run",
      "metadata_match",
      "requirement_coverage",
      "schema_error_rate",
      "token_usage_per_attempted_run",
    ]);
    expect(metric(artifact, "citation_existence")).toMatchObject({
      availability: "available",
      numerator: expectedCitations,
      denominator: expectedCitations,
      unit: "ratio",
    });
    expect(metric(artifact, "contradiction_recall")).toMatchObject({
      availability: "available",
      numerator: 0,
      denominator: records.length,
    });
    expect(metric(artifact, "schema_error_rate")).toMatchObject({
      availability: "available",
      numerator: 0,
      denominator: records.length,
    });
    expect(metric(artifact, "metadata_match")).toMatchObject({
      availability: "partial",
      quotient: null,
    });
    expect(artifact.conditionMetrics.map(({ conditionId }) => conditionId)).toEqual([
      "complete_workflow",
      "no_adversarial_review",
      "no_verification",
    ]);
    expect(
      artifact.conditionMetrics.find(
        ({ conditionId }) => conditionId === "no_verification",
      ),
    ).toMatchObject({
      comparisonEligibleRuns: 6,
      metrics: expect.arrayContaining([
        expect.objectContaining({
          id: "metadata_match",
          availability: "unavailable",
          denominator: 0,
        }),
      ]),
    });
    expect(metric(artifact, "token_usage_per_attempted_run")).toMatchObject({
      availability: "unavailable",
      numerator: 0,
      denominator: records.length,
      quotient: null,
      telemetry: { observed: 0 },
    });
    expect(metric(artifact, "estimated_cost_micro_usd_per_attempted_run")).toMatchObject({
      availability: "unavailable",
      numerator: 0,
      denominator: records.length,
      quotient: null,
      telemetry: { observed: 0 },
    });
  });

  it("is order-independent and rejects duplicate run identities", () => {
    const records = createWorkflowDevelopmentMatrix()
      .slice(0, 6)
      .map((fixture) => createWorkflowMetricRunRecord(fixture));
    const forward = createDeterministicMetricArtifact({
      runs: records,
      preRunExclusions: [],
    });
    const reverse = createDeterministicMetricArtifact({
      runs: [...records].reverse(),
      preRunExclusions: [],
    });

    expect(reverse).toEqual(forward);
    expect(() =>
      createDeterministicMetricArtifact({
        runs: [records[0]!, records[0]!],
        preRunExclusions: [],
      }),
    ).toThrow(/duplicate run identity/i);
  });

  it("retains failed attempts in structural denominators and records no fabricated success", () => {
    const fixture = createWorkflowConditionFixture(
      WORKFLOW_DEVELOPMENT_CASES[0],
      "complete_workflow",
      "trial-1",
    );
    const record = clone(createWorkflowMetricRunRecord(fixture));
    record.attempts = [failedAttemptFrom(record.attempts[0]!)];
    const artifact = createDeterministicMetricArtifact({
      runs: [createMetricTestFixtureRecord(record)],
      preRunExclusions: [],
    });

    expect(artifact.summary).toMatchObject({
      attemptedRuns: 1,
      retainedFailedRuns: 1,
    });
    expect(metric(artifact, "schema_error_rate")).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(metric(artifact, "requirement_coverage")).toMatchObject({
      numerator: 0,
      denominator: 11,
    });
    expect(metric(artifact, "experiment_completeness")).toMatchObject({
      numerator: 0,
      denominator: 10,
    });
    expect(metric(artifact, "contradiction_recall")).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
  });

  it("reports documented pre-run blockers as exclusions without disguising an attempt", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [
        {
          caseId: "blocked-case",
          conditionId: "complete_workflow",
          trialId: "trial-1",
          evidenceMode: "fixture",
          reason: "rights_gate_blocked",
          detail: "=RIGHTS gate, \"blocked\"\nno attempt was made",
        },
      ],
    });

    expect(artifact.summary).toEqual({
      attemptedRuns: 0,
      retainedFailedRuns: 0,
      preRunExcluded: 1,
      comparisonInvalidRuns: 0,
    });
    expect(artifact.exclusions).toHaveLength(1);
    expect(metric(artifact, "schema_error_rate")).toMatchObject({
      numerator: 0,
      denominator: 0,
      availability: "unavailable",
      quotient: null,
      unavailableReason: "zero_denominator",
    });
    const { csv } = buildMetricExports(artifact);
    expect(csv).toContain("'=RIGHTS gate, " + '""blocked""');
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("keeps comparison-invalid runs and reasons visible while retaining their metrics", () => {
    const fixture = createWorkflowConditionFixture(
      WORKFLOW_DEVELOPMENT_CASES[0],
      "complete_workflow",
      "trial-1",
    );
    const record = clone(createWorkflowMetricRunRecord(fixture));
    record.comparison = {
      status: "invalid",
      reasons: ["primary_model_changed", "packet_fingerprint_changed"],
    };
    const artifact = createDeterministicMetricArtifact({
      runs: [createMetricTestFixtureRecord(record)],
      preRunExclusions: [],
    });

    expect(artifact.summary).toMatchObject({
      attemptedRuns: 1,
      comparisonInvalidRuns: 1,
    });
    expect(artifact.invalidComparisons).toEqual([
      {
        runId: record.runId,
        conditionId: "complete_workflow",
        retainedFailure: false,
        reasons: ["packet_fingerprint_changed", "primary_model_changed"],
      },
    ]);
    expect(metric(artifact, "schema_error_rate").denominator).toBe(1);
    expect(artifact.conditionMetrics).toMatchObject([
      {
        conditionId: "complete_workflow",
        comparisonEligibleRuns: 0,
        metrics: expect.arrayContaining([
          expect.objectContaining({
            id: "schema_error_rate",
            denominator: 0,
            availability: "unavailable",
          }),
        ]),
      },
    ]);
  });

  it("distinguishes unavailable telemetry from an observed zero", () => {
    const fixture = createWorkflowConditionFixture(
      WORKFLOW_DEVELOPMENT_CASES[0],
      "complete_workflow",
      "trial-1",
    );
    const unavailable = createWorkflowMetricRunRecord(fixture);
    const zero = clone(unavailable);
    const canonical = zero.attempts[0]!.parsed;
    if (canonical.parseStatus !== "valid") throw new Error("valid fixture required");
    for (const execution of canonical.canonicalRun.executions) {
      if (execution.nodeId === "collect-sources") continue;
      execution.usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      };
      execution.pricing = {
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        estimatedCost: 0,
        snapshotDate: "2026-08-08",
      };
    }
    zero.attempts[0]!.parsed.canonicalRunHash = canonicalSha256(
      canonical.canonicalRun,
    );
    const unavailableArtifact = createDeterministicMetricArtifact({
      runs: [unavailable],
      preRunExclusions: [],
    });
    const zeroArtifact = createDeterministicMetricArtifact({
      runs: [createMetricTestFixtureRecord(zero)],
      preRunExclusions: [],
    });

    expect(metric(unavailableArtifact, "token_usage_per_attempted_run").availability).toBe("unavailable");
    expect(metric(zeroArtifact, "token_usage_per_attempted_run")).toMatchObject({
      availability: "available",
      numerator: 0,
      quotient: { scaledInteger: 0, scale: 1_000_000, decimal: "0.000000" },
    });
    expect(metric(zeroArtifact, "estimated_cost_micro_usd_per_attempted_run")).toMatchObject({
      availability: "available",
      numerator: 0,
      quotient: { scaledInteger: 0, scale: 1_000_000, decimal: "0.000000" },
    });
  });

  it("marks mixed telemetry partial and withholds an incomplete quotient", () => {
    const records = createWorkflowDevelopmentMatrix()
      .slice(0, 2)
      .map((fixture) => clone(createWorkflowMetricRunRecord(fixture)));
    const parsed = records[0]!.attempts[0]!.parsed;
    if (parsed.parseStatus !== "valid") throw new Error("valid fixture required");
    const execution = parsed.canonicalRun.executions.find(
      ({ nodeId }) => nodeId !== "collect-sources",
    )!;
    execution.usage.totalTokens = 17;
    execution.pricing = {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
      estimatedCost: 0.000017,
      snapshotDate: "2026-08-08",
    };
    parsed.canonicalRunHash = canonicalSha256(parsed.canonicalRun);
    const artifact = createDeterministicMetricArtifact({
      runs: records.map(createMetricTestFixtureRecord),
      preRunExclusions: [],
    });

    expect(metric(artifact, "token_usage_per_attempted_run")).toMatchObject({
      availability: "partial",
      numerator: 17,
      denominator: 2,
      quotient: null,
    });
    expect(metric(artifact, "estimated_cost_micro_usd_per_attempted_run")).toMatchObject({
      availability: "partial",
      numerator: 17,
      denominator: 2,
      quotient: null,
    });
  });

  it("uses exact six-decimal half-up quotients without NaN or Infinity", () => {
    const records = createWorkflowDevelopmentMatrix()
      .slice(0, 3)
      .map((fixture) => clone(createWorkflowMetricRunRecord(fixture)));
    records[0]!.attempts = [failedAttemptFrom(records[0]!.attempts[0]!)];
    const artifact = createDeterministicMetricArtifact({
      runs: records.map(createMetricTestFixtureRecord),
      preRunExclusions: [],
    });
    const errorRate = metric(artifact, "schema_error_rate");

    expect(errorRate.quotient).toEqual({
      scaledInteger: 333_333,
      scale: 1_000_000,
      decimal: "0.333333",
    });
    expect(JSON.stringify(artifact)).not.toMatch(/NaN|Infinity/);
  });

  it("handles an entirely empty input and a matrix where every attempt failed", () => {
    const empty = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [],
    });
    expect(empty.evidenceMode).toBe("unavailable");
    expect(empty.conditionMetrics).toEqual([]);
    expect(empty.metrics.every(({ availability }) => availability === "unavailable")).toBe(true);

    const failedRecords = createWorkflowDevelopmentMatrix()
      .slice(0, 3)
      .map((fixture) => clone(createWorkflowMetricRunRecord(fixture)))
      .map((record) => {
        record.attempts = [failedAttemptFrom(record.attempts[0]!)];
        return createMetricTestFixtureRecord(record);
      });
    const allFailed = createDeterministicMetricArtifact({
      runs: failedRecords,
      preRunExclusions: [],
    });
    expect(allFailed.summary.retainedFailedRuns).toBe(3);
    expect(metric(allFailed, "schema_error_rate")).toMatchObject({
      numerator: 3,
      denominator: 3,
      quotient: { decimal: "1.000000" },
    });
    expect(metric(allFailed, "requirement_coverage")).toMatchObject({
      numerator: 0,
      denominator: 33,
      quotient: { decimal: "0.000000" },
    });
  });

  it("derives all-failed strong-baseline smoke records from accepted runner artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidenceforge-metrics-baseline-"));
    try {
      const materialized = await materializeStrongBaselineSmoke({
        artifactRoot: root,
        developmentCase: DEVELOPMENT_CASES[0],
        benchmarkCodeVersion: COMPARISON_BENCHMARK_CODE_VERSION,
      });
      const records = [
        createBaselineMetricRunRecord({
          authority: materialized.parentAuthority,
          developmentCase: DEVELOPMENT_CASES[0],
          manifest: materialized.parentManifest,
          attempts: materialized.parentAttempts,
        }),
        createBaselineMetricRunRecord({
          authority: materialized.rerunAuthority,
          developmentCase: DEVELOPMENT_CASES[0],
          manifest: materialized.rerunManifest,
          attempts: materialized.rerunAttempts,
        }),
      ];
      const artifact = createDeterministicMetricArtifact({
        runs: records,
        preRunExclusions: [],
      });

      expect(artifact.summary).toMatchObject({
        attemptedRuns: 2,
        retainedFailedRuns: 2,
      });
      const baseline = artifact.conditionMetrics.find(
        ({ conditionId }) => conditionId === "strong_baseline",
      );
      expect(baseline).toMatchObject({
        comparisonEligibleRuns: 2,
      });
      expect(baseline?.metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "schema_error_rate",
            numerator: 4,
            denominator: 4,
            quotient: expect.objectContaining({ decimal: "1.000000" }),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits canonical hash-bound JSON, RFC4180 CSV, and chart data from one artifact", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: createWorkflowDevelopmentMatrix()
        .slice(0, 2)
        .map((fixture) => createWorkflowMetricRunRecord(fixture)),
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    const first = buildMetricExports(artifact);
    const second = buildMetricExports(parseMetricArtifact(first.json, authority));

    expect(second).toEqual(first);
    expect(JSON.parse(first.json)).toEqual(artifact);
    expect(JSON.parse(first.chartJson)).toEqual(first.chart);
    expect(first.chart.artifactHash).toBe(artifact.artifactHash);
    expect(first.chart.series).toEqual(
      artifact.conditionMetrics.flatMap((condition) =>
        condition.metrics.map((entry) => ({
          conditionId: condition.conditionId,
          comparisonEligibleRuns: condition.comparisonEligibleRuns,
          metricId: entry.id,
          numerator: entry.numerator,
          denominator: entry.denominator,
          availability: entry.availability,
          scaledInteger: entry.quotient?.scaledInteger ?? null,
          scale: entry.quotient?.scale ?? null,
          unit: entry.unit,
        })),
      ),
    );
    expect(first.csv.split("\r\n")[0]).toBe(
      "row_type,condition_id,metric_id,numerator,denominator,availability,scaled_integer,scale,unit,run_id,reason,note",
    );
  });

  it("rejects tampered hashes and returns frozen non-aliased artifacts", () => {
    const fixture = createWorkflowConditionFixture(
      WORKFLOW_DEVELOPMENT_CASES[0],
      "complete_workflow",
      "trial-1",
    );
    const source = createWorkflowMetricRunRecord(fixture);
    const artifact = createDeterministicMetricArtifact({
      runs: [source],
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    expect(() =>
      source.comparison.reasons.push("late_alias_mutation"),
    ).toThrow();

    expect(artifact.invalidComparisons).toEqual([]);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.metrics)).toBe(true);
    const tampered = clone(artifact);
    tampered.metrics[0]!.numerator += 1;
    expect(() => MetricArtifactSchema.parse(tampered)).toThrow(/authority/i);
    expect(() => parseMetricArtifact(JSON.stringify(tampered), authority)).toThrow(
      /artifact hash|authority/i,
    );
    const rehashed = clone(tampered);
    const { artifactHash: _oldHash, ...payload } = rehashed;
    void _oldHash;
    rehashed.artifactHash = canonicalSha256(payload);
    expect(() => MetricArtifactSchema.parse(rehashed)).toThrow(/authority/i);
  });

  it("rejects a fully rehashed summary contradiction at every public boundary", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    const contradictory = clone(artifact);
    contradictory.summary.attemptedRuns = 1;
    const forged = rehash(contradictory);

    expect(MetricArtifactSchema.safeParse(forged).success).toBe(false);
    expect(() => parseMetricArtifact(JSON.stringify(forged), authority)).toThrow(
      /authority|source|summary/i,
    );
    expect(() => buildMetricExports(forged, authority)).toThrow(
      /authority|source|summary/i,
    );
  });

  it("rejects a fully rehashed nonzero numerator over a zero denominator", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    const contradictory = clone(artifact);
    const errorRate = metric(contradictory, "schema_error_rate");
    errorRate.numerator = 7;
    const forged = rehash(contradictory);

    expect(MetricArtifactSchema.safeParse(forged).success).toBe(false);
    expect(() => parseMetricArtifact(JSON.stringify(forged), authority)).toThrow(
      /authority|numerator|denominator/i,
    );
    expect(() => buildMetricExports(forged, authority)).toThrow(
      /authority|numerator|denominator/i,
    );
  });

  it("does not mint artifact authority from a caller-relabeled workflow record", () => {
    const fixture = createWorkflowDevelopmentMatrix()[0]!;
    const record = clone(createWorkflowMetricRunRecord(fixture));
    record.comparison = {
      status: "invalid",
      reasons: ["caller_relabelled_comparison"],
    };

    expect(() =>
      createDeterministicMetricArtifact({
        runs: [record],
        preRunExclusions: [],
      }),
    ).toThrow(/authority|authorized|adapter/i);
  });

  it("rejects a whole-record workflow edit after embedded hashes are recomputed", () => {
    const original = createWorkflowMetricRunRecord(
      createWorkflowDevelopmentMatrix()[0]!,
    );
    const edited = clone(original);
    const parsed = edited.attempts[0]!.parsed;
    if (parsed.parseStatus !== "valid") throw new Error("valid fixture required");
    const execution = parsed.canonicalRun.executions[0]!;
    execution.clientLatencyMs = (execution.clientLatencyMs ?? 0) + 10_000;
    execution.providerTiming.totalMs = execution.clientLatencyMs;
    parsed.canonicalRunHash = canonicalSha256(parsed.canonicalRun);
    edited.attempts[0]!.raw.latencyMs += 10_000;

    expect(MetricRunRecordSchema.safeParse(edited).success).toBe(false);
    expect(() =>
      createDeterministicMetricArtifact({
        runs: [edited],
        preRunExclusions: [],
      }),
    ).toThrow(/authority|adapter/i);
  });

  it("requires strong-baseline run authority before accepting persisted latency", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidenceforge-metrics-authority-red-"));
    try {
      const materialized = await materializeStrongBaselineSmoke({
        artifactRoot: root,
        developmentCase: DEVELOPMENT_CASES[0],
        benchmarkCodeVersion: COMPARISON_BENCHMARK_CODE_VERSION,
      });
      const attempts = clone(materialized.parentAttempts);
      attempts[0]!.raw.latencyMs = 123_456;

      expect(() =>
        createBaselineMetricRunRecord({
          developmentCase: clone(DEVELOPMENT_CASES[0]!),
          manifest: clone(materialized.parentManifest),
          attempts,
        } as never),
      ).toThrow(/authority|authorized|latency/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps metric run source authority identity-bound, cross-record safe, and revocable", () => {
    const fixtures = createWorkflowDevelopmentMatrix().slice(0, 2);
    const first = createWorkflowMetricRunRecord(fixtures[0]!);
    const second = createWorkflowMetricRunRecord(fixtures[1]!);
    const firstAuthority = retainMetricRunRecordAuthority(first);
    const authorityAlias = firstAuthority;
    const secondAuthority = retainMetricRunRecordAuthority(second);
    const artifact = createDeterministicMetricArtifact({
      runs: [first],
      preRunExclusions: [],
    });
    const artifactAuthority = retainMetricArtifactAuthority(artifact);

    expect(MetricRunRecordSchema.parse(first, authorityAlias)).toBe(first);
    expect(Object.keys(MetricRunRecordSchema).sort()).toEqual([
      "parse",
      "safeParse",
    ]);
    expect("shape" in MetricRunRecordSchema).toBe(false);
    for (const candidate of [
      clone(first),
      { ...first },
      JSON.parse(JSON.stringify(first)),
    ]) {
      expect(MetricRunRecordSchema.safeParse(candidate).success).toBe(false);
      expect(() =>
        createDeterministicMetricArtifact({
          runs: [candidate],
          preRunExclusions: [],
        }),
      ).toThrow(/authority|adapter/i);
    }
    expect(() => MetricRunRecordSchema.parse(first, clone(firstAuthority))).toThrow(
      /authority/i,
    );
    expect(() => MetricRunRecordSchema.parse(first, secondAuthority)).toThrow(
      /another record/i,
    );

    revokeMetricRunRecordAuthority(firstAuthority);
    expect(() => MetricRunRecordSchema.parse(first)).toThrow(/revoked/i);
    expect(() => buildMetricExports(artifact)).toThrow(/revoked/i);
    expect(() =>
      parseMetricArtifact(JSON.stringify(artifact), artifactAuthority),
    ).toThrow(/revoked/i);
  });

  it("rejects missing, fake, cross-run, and edited baseline evidence under authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidenceforge-metrics-baseline-chain-"));
    try {
      const materialized = await materializeStrongBaselineSmoke({
        artifactRoot: root,
        developmentCase: DEVELOPMENT_CASES[0],
        benchmarkCodeVersion: COMPARISON_BENCHMARK_CODE_VERSION,
      });
      const acceptedInput = {
        authority: materialized.parentAuthority,
        developmentCase: clone(DEVELOPMENT_CASES[0]!),
        manifest: clone(materialized.parentManifest),
        attempts: clone(materialized.parentAttempts),
      };
      const baselineFixture = createWorkflowDevelopmentMatrix().find(
        ({ developmentCase, condition, runConfig }) =>
          developmentCase.benchmarkCase.id ===
            materialized.parentManifest.caseReference.id &&
          condition.id === "complete_workflow" &&
          runConfig.trialId === materialized.parentManifest.trialId,
      )!;
      const baselineComparison = validComparisonForFixture(baselineFixture);
      expect(
        createAuthorizedBaselineMetricRunRecord({
          ...acceptedInput,
          comparison: baselineComparison,
        }).runId,
      ).toBe(materialized.parentManifest.runId);
      expect(() =>
        createAuthorizedBaselineMetricRunRecord(acceptedInput as never),
      ).toThrow(/comparison|binding|required/i);
      const crossPair = comparisonPairs.find(
        ({ candidate }) =>
          candidate.caseId !== materialized.parentManifest.caseReference.id,
      )!;
      expect(() =>
        createAuthorizedBaselineMetricRunRecord({
          ...acceptedInput,
          comparison: {
            authority: crossPair.authority,
            candidate: crossPair.candidate,
            assessment: assessComparisonEligibility(
              crossPair.authority,
              crossPair.candidate,
            ),
          },
        }),
      ).toThrow(/pair|baseline|run|case/i);
      expect(createBaselineMetricRunRecord(acceptedInput).runId).toBe(
        materialized.parentManifest.runId,
      );

      const wrongAuthorities = [
        materialized.rerunAuthority,
        clone(materialized.parentAuthority),
        { ...materialized.parentAuthority } as StrongBaselineRunAuthority,
        JSON.parse(
          JSON.stringify(materialized.parentAuthority),
        ) as StrongBaselineRunAuthority,
      ];
      for (const authority of wrongAuthorities) {
        expect(() =>
          createBaselineMetricRunRecord({
            ...acceptedInput,
            authority,
          }),
        ).toThrow(/authority|authorized|attempt/i);
      }

      let authorityTraps = 0;
      const authorityProxy = new Proxy(materialized.parentAuthority, {
        get() {
          authorityTraps += 1;
          throw new Error("baseline authority proxy trap executed");
        },
        ownKeys() {
          authorityTraps += 1;
          throw new Error("baseline authority proxy trap executed");
        },
        getPrototypeOf() {
          authorityTraps += 1;
          throw new Error("baseline authority proxy trap executed");
        },
      });
      expect(() =>
        createBaselineMetricRunRecord({
          ...acceptedInput,
          authority: authorityProxy,
        }),
      ).toThrow(/proxy/i);
      expect(authorityTraps).toBe(0);

      const mutations: Array<(attempts: RecordedAttempt[]) => void> = [
        (attempts) => {
          attempts[0]!.raw.latencyMs = 123_456;
        },
        (attempts) => {
          const evidence = attempts[0]!.raw.rawOutput as {
            latency: { milliseconds: number };
          };
          evidence.latency.milliseconds = 123_456;
          attempts[0]!.raw.latencyMs = 123_456;
        },
        (attempts) => {
          const evidence = attempts[0]!.raw.rawOutput as {
            usage: { status: string; totalTokens: number | null };
          };
          evidence.usage.status = "available";
          evidence.usage.totalTokens = 999;
        },
        (attempts) => {
          const evidence = attempts[0]!.raw.rawOutput as {
            cost: { status: string; amount: number | null; currency: string | null };
          };
          evidence.cost.status = "available";
          evidence.cost.amount = 42;
          evidence.cost.currency = "USD";
        },
        (attempts) => {
          if (attempts[0]!.raw.status !== "failed") {
            throw new Error("failed fixture required");
          }
          attempts[0]!.raw.failure.message = "Caller relabeled failure.";
        },
      ];
      for (const mutate of mutations) {
        const attempts = clone(materialized.parentAttempts);
        mutate(attempts);
        expect(() =>
          createBaselineMetricRunRecord({
            ...acceptedInput,
            attempts,
          }),
        ).toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects metric source records and source authorities as Proxies before traps", () => {
    const record = createWorkflowMetricRunRecord(
      createWorkflowDevelopmentMatrix()[0]!,
    );
    const authority = retainMetricRunRecordAuthority(record);
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("source proxy trap executed");
      },
      ownKeys() {
        traps += 1;
        throw new Error("source proxy trap executed");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("source proxy trap executed");
      },
    };
    const recordProxy = new Proxy(record, handler);
    const authorityProxy = new Proxy(authority, handler);
    const revoked = Proxy.revocable(authority, handler);
    revoked.revoke();

    expect(() => MetricRunRecordSchema.parse(recordProxy)).toThrow(/proxy/i);
    expect(() => MetricRunRecordSchema.parse(record, authorityProxy as never)).toThrow(/proxy/i);
    expect(() => MetricRunRecordSchema.parse(record, revoked.proxy as never)).toThrow(/proxy/i);
    expect(() =>
      createDeterministicMetricArtifact({
        runs: [recordProxy as never],
        preRunExclusions: [],
      }),
    ).toThrow(/proxy/i);
    expect(traps).toBe(0);
  });

  it("requires exact artifact identity or retained authority for clone, spread, and JSON data", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: createWorkflowDevelopmentMatrix()
        .slice(0, 1)
        .map(createWorkflowMetricRunRecord),
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    const cloneArtifact = clone(artifact);
    const spreadArtifact = { ...artifact };
    const jsonArtifact = JSON.parse(JSON.stringify(artifact));

    expect(MetricArtifactSchema.parse(artifact)).toBe(artifact);
    for (const candidate of [cloneArtifact, spreadArtifact, jsonArtifact]) {
      expect(MetricArtifactSchema.safeParse(candidate).success).toBe(false);
      expect(() => buildMetricExports(candidate, authority)).toThrow(/authority/i);
    }
    const rehydrated = parseMetricArtifact(JSON.stringify(artifact), authority);
    expect(buildMetricExports(rehydrated)).toEqual(buildMetricExports(artifact));
  });

  it("rejects cross-artifact, fake, and revoked authority", () => {
    const first = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [],
    });
    const second = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [
        {
          caseId: "blocked-case",
          conditionId: "complete_workflow",
          trialId: "trial-1",
          evidenceMode: "fixture",
          reason: "safety_gate_blocked",
          detail: "Blocked before any attempt.",
        },
      ],
    });
    const firstAuthority = retainMetricArtifactAuthority(first);
    const fake = clone(firstAuthority);

    expect(() => parseMetricArtifact(JSON.stringify(second), firstAuthority)).toThrow(
      /authority/i,
    );
    expect(() => parseMetricArtifact(JSON.stringify(first), fake)).toThrow(
      /authority/i,
    );
    revokeMetricArtifactAuthority(firstAuthority);
    expect(() => buildMetricExports(first)).toThrow(/revoked/i);
    expect(() => parseMetricArtifact(JSON.stringify(first), firstAuthority)).toThrow(
      /revoked/i,
    );
  });

  it("rejects proxies before any trap at compiler, schema, export, and authority boundaries", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: [],
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    let traps = 0;
    const hostileHandler: ProxyHandler<object> = {
      getPrototypeOf() {
        traps += 1;
        throw new Error("proxy trap executed");
      },
      ownKeys() {
        traps += 1;
        throw new Error("proxy trap executed");
      },
      get() {
        traps += 1;
        throw new Error("proxy trap executed");
      },
    };
    const compilerProxy = new Proxy(
      { runs: [], preRunExclusions: [] },
      hostileHandler,
    );
    const artifactProxy = new Proxy(artifact, hostileHandler);
    const authorityProxy = new Proxy(authority, hostileHandler);
    const adapterProxy = new Proxy({}, hostileHandler);

    expect(() => createDeterministicMetricArtifact(compilerProxy as never)).toThrow(/proxy/i);
    const fixture = createWorkflowDevelopmentMatrix()[0]!;
    expect(() =>
      createAuthorizedWorkflowMetricRunRecord(
        adapterProxy as never,
        validComparisonForFixture(fixture),
      ),
    ).toThrow(/proxy/i);
    expect(() =>
      createAuthorizedBaselineMetricRunRecord(adapterProxy as never),
    ).toThrow(/proxy/i);
    expect(() => MetricArtifactSchema.parse(artifactProxy)).toThrow(/proxy/i);
    expect(() => buildMetricExports(artifactProxy as never, authority)).toThrow(/proxy/i);
    expect(() => parseMetricArtifact(JSON.stringify(artifact), authorityProxy as never)).toThrow(
      /proxy/i,
    );
    expect(traps).toBe(0);
  });

  it("rejects every recomputed summary and metric mutation before JSON CSV or chart export", () => {
    const artifact = createDeterministicMetricArtifact({
      runs: createWorkflowDevelopmentMatrix()
        .slice(0, 3)
        .map(createWorkflowMetricRunRecord),
      preRunExclusions: [],
    });
    const authority = retainMetricArtifactAuthority(artifact);
    const mutations: MetricArtifact[] = [];
    for (const field of Object.keys(artifact.summary) as Array<
      keyof typeof artifact.summary
    >) {
      const changed = clone(artifact);
      changed.summary[field] += 1;
      mutations.push(rehash(changed));
    }
    for (let index = 0; index < artifact.metrics.length; index += 1) {
      const changed = clone(artifact);
      changed.metrics[index]!.numerator += 1;
      mutations.push(rehash(changed));
    }

    for (const forged of mutations) {
      expect(MetricArtifactSchema.safeParse(forged).success).toBe(false);
      expect(() => parseMetricArtifact(JSON.stringify(forged), authority)).toThrow();
      expect(() => buildMetricExports(forged, authority)).toThrow();
    }
  });

  it("rejects accessors before invoking them", () => {
    let reads = 0;
    const malicious = Object.defineProperty({}, "runs", {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });
    Object.defineProperty(malicious, "preRunExclusions", {
      enumerable: true,
      value: [],
    });

    expect(() => createDeterministicMetricArtifact(malicious as never)).toThrow(
      /accessor/i,
    );
    expect(reads).toBe(0);

    let authorityReads = 0;
    const baselineInput = Object.defineProperty({}, "authority", {
      enumerable: true,
      get() {
        authorityReads += 1;
        throw new Error("authority accessor executed");
      },
    });
    expect(() =>
      createAuthorizedBaselineMetricRunRecord(baselineInput as never),
    ).toThrow(
      /data property/i,
    );
    expect(authorityReads).toBe(0);
  });
});
