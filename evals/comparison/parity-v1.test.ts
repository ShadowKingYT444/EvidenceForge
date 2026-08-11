import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBenchmarkCase, createBenchmarkConfig } from "../protocol/v1";
import {
  aggregateEligibleComparisons,
  assessComparisonEligibility,
  exportComparisonEligibilityTable,
  materializeDevelopmentComparisonFixtureSet,
  type ComparisonCandidate,
  type ComparisonEligibilityResult,
  type ComparisonPairAuthority,
} from "./parity-v1";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(label: string) {
  const root = await mkdtemp(join(tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rebuildRightConfig(
  candidate: ComparisonCandidate,
  patch: Record<string, unknown>,
) {
  candidate.rightConfig = createBenchmarkConfig({
    ...candidate.rightConfig,
    ...patch,
  });
  candidate.rightTrial.configHash = candidate.rightConfig.configHash;
}

describe("authority-bound comparison parity and invalidation v1", () => {
  it("builds the exact two-case by three-condition by three-trial fixture matrix from accepted authorities", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-matrix"),
    });

    expect(fixtureSet.pairs).toHaveLength(18);
    expect(fixtureSet.pairs.map(({ candidate }) => candidate.pairId)).toEqual(
      [...fixtureSet.pairs.map(({ candidate }) => candidate.pairId)].sort(),
    );
    expect(
      new Set(fixtureSet.pairs.map(({ candidate }) => candidate.caseId)),
    ).toHaveLength(2);
    expect(
      new Set(
        fixtureSet.pairs.map(({ candidate }) => candidate.rightConditionId),
      ),
    ).toEqual(
      new Set([
        "complete_workflow",
        "no_verification",
        "no_adversarial_review",
      ]),
    );
    expect(
      new Set(fixtureSet.pairs.map(({ candidate }) => candidate.trialId)),
    ).toEqual(new Set(["trial-1", "trial-2", "trial-3"]));

    for (const { authority, candidate } of fixtureSet.pairs) {
      const assessment = assessComparisonEligibility(authority, candidate);
      expect(assessment).toMatchObject({
        pairId: candidate.pairId,
        eligible: true,
        invalidationReasons: [],
        excludedFromAggregates: false,
        preference: null,
        metrics: null,
      });
      expect(candidate.classification).toEqual({
        evidenceMode: "fixture",
        workflowEvidenceMode: "simulated",
        reportingUse: "development",
        headlineEligible: false,
        trialRecordUse: "structural_eligibility_fixture_only",
      });
      expect(candidate.baselineEvidence.parentAttempts).toHaveLength(2);
      expect(candidate.baselineEvidence.rerunAttempts).toHaveLength(2);
      expect(
        (candidate.baselineEvidence.parentAttempts as Array<{ outcome: string }>).map(
          ({ outcome }) => outcome,
        ),
      ).toEqual(["timeout", "refusal"]);
      expect(
        (candidate.baselineEvidence.rerunAttempts as Array<{ outcome: string }>).map(
          ({ outcome }) => outcome,
        ),
      ).toEqual(["invalid_output", "provider_failure"]);
      expect(candidate.workflowEvidence.attempts).toHaveLength(1);
      expect(candidate.workflowEvidence.attempts[0]).toMatchObject({
        raw: { status: "succeeded" },
        parsed: { parseStatus: "valid" },
      });
      const workflowAttempt = candidate.workflowEvidence.attempts[0] as {
        parsed: {
          canonicalRun: {
            executions: Array<{
              nodeId: string;
              status: string;
              retryOfExecutionId: string | null;
            }>;
            errors: unknown[];
          };
        };
      };
      if (candidate.rightConditionId === "no_adversarial_review") {
        expect(workflowAttempt.parsed.canonicalRun.errors).toEqual([]);
      } else {
        const reviewerAttempts = workflowAttempt.parsed.canonicalRun.executions
          .filter(({ nodeId }) => nodeId === "review-experiment");
        expect(reviewerAttempts).toMatchObject([
          { status: "failed", retryOfExecutionId: null },
          { status: "succeeded" },
        ]);
        expect(reviewerAttempts[1]!.retryOfExecutionId).toEqual(
          expect.any(String),
        );
        expect(workflowAttempt.parsed.canonicalRun.errors).toHaveLength(1);
      }
      expect(candidate.leftConfig.pairingHash).toBe(
        candidate.rightConfig.pairingHash,
      );
      expect(candidate.leftTrial.trialId).toBe(candidate.rightTrial.trialId);
    }
  });

  it.each([
    [
      "prompt_manifest_changed",
      (candidate: ComparisonCandidate) => {
        const manifest = clone(candidate.rightConfig.promptManifest);
        manifest[0]!.version = "9.9.9";
        rebuildRightConfig(candidate, { promptManifest: manifest });
      },
    ],
    [
      "primary_model_changed",
      (candidate: ComparisonCandidate) => {
        rebuildRightConfig(candidate, {
          primaryModel: {
            provider: "fixture",
            modelId: "fixture-primary-changed",
            developerFamily: "fixture-primary-family",
            baseFamily: "fixture-primary-base",
          },
        });
        candidate.rightTrial.actualPrimaryModel =
          candidate.rightConfig.primaryModel;
      },
    ],
    [
      "generation_config_changed",
      (candidate: ComparisonCandidate) => {
        rebuildRightConfig(candidate, {
          generation: {
            ...candidate.rightConfig.generation,
            maxOutputTokens:
              candidate.rightConfig.generation.maxOutputTokens + 1,
          },
        });
      },
    ],
    [
      "benchmark_code_changed",
      (candidate: ComparisonCandidate) => {
        rebuildRightConfig(candidate, {
          benchmarkCodeVersion: "a".repeat(40),
        });
      },
    ],
    [
      "fallback_policy_changed",
      (candidate: ComparisonCandidate) => {
        rebuildRightConfig(candidate, {
          fallbackPolicy: {
            mode: "explicit_invalidating",
            configuredModel: {
              provider: "fixture",
              modelId: "fixture-fallback-v1",
              developerFamily: "fixture-fallback-family",
              baseFamily: "fixture-fallback-base",
            },
          },
        });
      },
    ],
    [
      "retry_policy_changed",
      (candidate: ComparisonCandidate) => {
        rebuildRightConfig(candidate, {
          retryPolicy: {
            maximumAttempts: 1,
            repairInvalidOutput: false,
            retryableFailureKinds: [],
          },
        });
      },
    ],
  ] as const)(
    "invalidates a fully rehashed one-sided %s change without forwarding aggregate payloads",
    async (expectedReason, mutate) => {
      const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
        artifactRoot: await temporaryRoot(`comparison-${expectedReason}`),
      });
      const pair = fixtureSet.pairs[0]!;
      const candidate = clone(pair.candidate);
      mutate(candidate);
      candidate.preference = "right";
      candidate.metrics = { fixtureScoreDelta: 1 };

      const assessment = assessComparisonEligibility(pair.authority, candidate);

      expect(assessment.eligible).toBe(false);
      expect(assessment.invalidationReasons).toContain(expectedReason);
      expect(assessment.excludedFromAggregates).toBe(true);
      expect(assessment.preference).toBeNull();
      expect(assessment.metrics).toBeNull();
      expect(assessment.preservedEvidence).toEqual({
        baseline: candidate.baselineEvidence,
        workflow: candidate.workflowEvidence,
      });
    },
  );

  it("reports exact packet-membership and metadata reason sets after canonical rehashing", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-exact-reasons"),
    });
    const pair = fixtureSet.pairs[0]!;

    const packet = clone(pair.candidate);
    const packetCase = createBenchmarkCase({
      ...packet.rightConfig.case,
      packet: {
        ...packet.rightConfig.case.packet,
        sourceHashes: [
          ...packet.rightConfig.case.packet.sourceHashes,
          "f".repeat(64),
        ].sort(),
      },
    });
    rebuildRightConfig(packet, { case: packetCase });
    packet.rightTrial.caseId = packetCase.id;
    expect(
      assessComparisonEligibility(pair.authority, packet).invalidationReasons,
    ).toEqual(["case_definition_changed", "source_membership_changed"]);

    const metadata = clone(pair.candidate);
    const metadataCase = createBenchmarkCase({
      ...metadata.rightConfig.case,
      metadataSnapshot: {
        ...metadata.rightConfig.case.metadataSnapshot,
        hash: "e".repeat(64),
      },
    });
    rebuildRightConfig(metadata, { case: metadataCase });
    metadata.rightTrial.caseId = metadataCase.id;
    expect(
      assessComparisonEligibility(pair.authority, metadata)
        .invalidationReasons,
    ).toEqual(["case_definition_changed", "metadata_snapshot_changed"]);

    const fingerprint = clone(pair.candidate);
    const fingerprintCase = createBenchmarkCase({
      ...fingerprint.rightConfig.case,
      packet: {
        ...fingerprint.rightConfig.case.packet,
        fingerprint: "d".repeat(64),
      },
    });
    rebuildRightConfig(fingerprint, { case: fingerprintCase });
    fingerprint.rightTrial.caseId = fingerprintCase.id;
    expect(
      assessComparisonEligibility(pair.authority, fingerprint)
        .invalidationReasons,
    ).toEqual(["case_definition_changed", "source_packet_changed"]);
  });

  it("invalidates changed failure evidence without dropping the changed bytes", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-evidence-change"),
    });
    const pair = fixtureSet.pairs[0]!;
    const candidate = clone(pair.candidate);
    const firstAttempt = candidate.baselineEvidence.parentAttempts[0] as {
      validation: { issues: string[] };
    };
    firstAttempt.validation.issues.push("caller-selected failure annotation");

    const assessment = assessComparisonEligibility(pair.authority, candidate);
    expect(assessment.invalidationReasons).toEqual(["evidence_mismatch"]);
    expect(assessment.preservedEvidence?.baseline).toEqual(
      candidate.baselineEvidence,
    );
    expect(assessment.excludedFromAggregates).toBe(true);
  });

  it("invalidates actual-model and observed-fallback trial drift while preserving explicit exclusion evidence", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-trial-drift"),
    });
    const pair = fixtureSet.pairs[0]!;
    const candidate = clone(pair.candidate);
    candidate.rightTrial.actualPrimaryModel = {
      provider: "fixture",
      modelId: "fixture-returned-different",
      developerFamily: "fixture-other-family",
      baseFamily: "fixture-other-base",
    };
    candidate.rightTrial.fallbackUsed = true;
    candidate.rightTrial.fallbackModel = {
      provider: "fixture",
      modelId: "fixture-visible-fallback",
      developerFamily: "fixture-fallback-family",
      baseFamily: "fixture-fallback-base",
    };

    expect(
      assessComparisonEligibility(pair.authority, candidate)
        .invalidationReasons,
    ).toEqual(["actual_model_changed", "fallback_observed"]);

    const excluded = clone(pair.candidate);
    excluded.rightTrial.attempted = false;
    excluded.rightTrial.excluded = true;
    excluded.rightTrial.exclusionReason =
      "provider_unavailable_before_attempt";
    const assessment = assessComparisonEligibility(pair.authority, excluded);
    expect(assessment.invalidationReasons).toEqual([
      "pre_run_exclusion_present",
    ]);
    expect(assessment.preservedEligibility).toMatchObject({
      right: {
        attempted: false,
        excluded: true,
        exclusionReason: "provider_unavailable_before_attempt",
      },
    });
  });

  it("binds opaque authorities to exact case, code, run, condition, and trial identities", async () => {
    const first = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-authority-first"),
      benchmarkCodeVersion: "a".repeat(40),
    });
    const second = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-authority-second"),
      benchmarkCodeVersion: "b".repeat(40),
    });
    const authority = first.pairs[0]!.authority;

    expect(
      assessComparisonEligibility(authority, second.pairs[0]!.candidate)
        .invalidationReasons,
    ).toContain("authority_code_mismatch");
    expect(
      assessComparisonEligibility(authority, first.pairs[9]!.candidate)
        .invalidationReasons,
    ).toContain("authority_case_mismatch");
    expect(
      assessComparisonEligibility(authority, first.pairs[3]!.candidate)
        .invalidationReasons,
    ).toContain("authority_condition_mismatch");
    expect(
      assessComparisonEligibility(authority, first.pairs[1]!.candidate)
        .invalidationReasons,
    ).toContain("authority_trial_mismatch");

    const runDrift = clone(first.pairs[0]!.candidate);
    runDrift.leftRunId = "caller-selected-left-run";
    runDrift.rightRunId = "caller-selected-right-run";
    expect(
      assessComparisonEligibility(authority, runDrift).invalidationReasons,
    ).toEqual(["authority_run_mismatch"]);

    const forgedAuthorities = [
      {} as ComparisonPairAuthority,
      structuredClone(authority) as ComparisonPairAuthority,
      { ...(authority as object) } as ComparisonPairAuthority,
      JSON.parse(JSON.stringify(authority)) as ComparisonPairAuthority,
    ];
    for (const forged of forgedAuthorities) {
      expect(
        assessComparisonEligibility(forged, first.pairs[0]!.candidate),
      ).toMatchObject({
        pairId: null,
        eligible: false,
        invalidationReasons: ["unauthorized_pair"],
      });
    }
  });

  it("rejects missing, extra, and accessor-bearing records without invoking accessors", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-passive-input"),
    });
    const pair = fixtureSet.pairs[0]!;

    const missing = clone(pair.candidate) as unknown as Record<string, unknown>;
    delete missing.rightTrial;
    expect(
      assessComparisonEligibility(pair.authority, missing)
        .invalidationReasons,
    ).toEqual(["record_invalid"]);

    const extra = clone(pair.candidate) as unknown as Record<string, unknown>;
    extra.callerSelectedEligibility = true;
    expect(
      assessComparisonEligibility(pair.authority, extra).invalidationReasons,
    ).toEqual(["record_invalid"]);

    const accessor = clone(pair.candidate) as unknown as Record<string, unknown>;
    const original = accessor.rightConfig;
    let calls = 0;
    Object.defineProperty(accessor, "rightConfig", {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return original;
      },
    });
    expect(
      assessComparisonEligibility(pair.authority, accessor)
        .invalidationReasons,
    ).toEqual(["record_invalid"]);
    expect(calls).toBe(0);

    let evidenceCalls = 0;
    const hostileEvidence = clone(pair.candidate) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostileEvidence, "baselineEvidence", {
      enumerable: true,
      configurable: true,
      get() {
        evidenceCalls += 1;
        return pair.candidate.baselineEvidence;
      },
    });
    expect(
      assessComparisonEligibility(
        {} as ComparisonPairAuthority,
        hostileEvidence,
      ).invalidationReasons,
    ).toEqual(["unauthorized_pair"]);
    expect(evidenceCalls).toBe(0);
  });

  it("rejects proxied authorities and nested candidate proxies without executing traps", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-proxy-input"),
    });
    const pair = fixtureSet.pairs[0]!;
    let authorityTraps = 0;
    const proxiedAuthority = new Proxy(pair.authority, {
      get() {
        authorityTraps += 1;
        throw new Error("authority proxy trap must not execute");
      },
      ownKeys() {
        authorityTraps += 1;
        throw new Error("authority proxy trap must not execute");
      },
    });
    expect(
      assessComparisonEligibility(proxiedAuthority, pair.candidate)
        .invalidationReasons,
    ).toEqual(["unauthorized_pair"]);
    expect(authorityTraps).toBe(0);

    const candidate = clone(pair.candidate);
    let configTraps = 0;
    candidate.rightConfig = new Proxy(candidate.rightConfig, {
      get() {
        configTraps += 1;
        throw new Error("candidate proxy trap must not execute");
      },
      getPrototypeOf() {
        configTraps += 1;
        throw new Error("candidate proxy trap must not execute");
      },
      ownKeys() {
        configTraps += 1;
        throw new Error("candidate proxy trap must not execute");
      },
    });
    expect(
      assessComparisonEligibility(pair.authority, candidate)
        .invalidationReasons,
    ).toEqual(["record_invalid"]);
    expect(configTraps).toBe(0);
  });

  it("exports no raw structural candidate or aggregate acceptance schema", async () => {
    const comparisonModule = await import("./parity-v1");

    expect(comparisonModule).not.toHaveProperty("ComparisonCandidateSchema");
    expect(comparisonModule).not.toHaveProperty("ComparisonEligibilityResultSchema");
    expect(comparisonModule).not.toHaveProperty("trustedPairByAuthority");
    expect(comparisonModule).toHaveProperty("assessComparisonEligibility");
    expect(comparisonModule).toHaveProperty("aggregateEligibleComparisons");
  });

  it("owns caller aliases and emits byte-identical tables regardless of input order", async () => {
    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-order"),
    });
    const firstThree = fixtureSet.pairs.slice(0, 3).map(({ authority, candidate }) =>
      assessComparisonEligibility(authority, candidate),
    );
    const first = firstThree[0]!;
    const candidateAlias = fixtureSet.pairs[0]!.candidate;
    const mutableAttempt = candidateAlias.baselineEvidence
      .parentAttempts[0] as { validation: { issues: string[] } };
    mutableAttempt.validation.issues.push("caller mutation after assessment");
    if (first.preservedEvidence === null) {
      throw new Error("eligible comparison must preserve evidence");
    }
    const preservedAttempt = first.preservedEvidence.baseline
      .parentAttempts[0] as { validation: { issues: string[] } };
    expect(preservedAttempt.validation.issues)
      .not.toContain("caller mutation after assessment");

    expect(exportComparisonEligibilityTable(firstThree)).toBe(
      exportComparisonEligibilityTable([...firstThree].reverse()),
    );
    expect(aggregateEligibleComparisons(firstThree)).toEqual(
      aggregateEligibleComparisons([...firstThree].reverse()),
    );
  });

  it("rejects aggregate injection and handles empty and all-invalid tables deterministically", async () => {
    expect(aggregateEligibleComparisons([])).toEqual({
      schemaVersion: "1.0.0",
      inputPairs: 0,
      eligiblePairs: 0,
      invalidPairs: 0,
      includedPreferencePairIds: [],
      includedMetricPairIds: [],
      exclusions: [],
    });
    expect(exportComparisonEligibilityTable([])).toBe(
      '{"rows":[],"schemaVersion":"1.0.0"}\n',
    );

    const fixtureSet = await materializeDevelopmentComparisonFixtureSet({
      artifactRoot: await temporaryRoot("comparison-all-invalid"),
    });
    const invalid = fixtureSet.pairs.slice(0, 2).map(({ authority, candidate }) => {
      const changed = clone(candidate);
      rebuildRightConfig(changed, {
        benchmarkCodeVersion: "f".repeat(40),
      });
      return assessComparisonEligibility(authority, changed);
    });
    const aggregate = aggregateEligibleComparisons(invalid);
    expect(aggregate).toMatchObject({
      inputPairs: 2,
      eligiblePairs: 0,
      invalidPairs: 2,
      includedPreferencePairIds: [],
      includedMetricPairIds: [],
    });
    expect(aggregate.exclusions).toHaveLength(2);

    const injected = clone(invalid[0]!) as ComparisonEligibilityResult;
    await expect(async () =>
      aggregateEligibleComparisons([injected]),
    ).rejects.toThrow(/issued comparison assessment/i);
    await expect(async () =>
      exportComparisonEligibilityTable([injected]),
    ).rejects.toThrow(/issued comparison assessment/i);
  });
});
