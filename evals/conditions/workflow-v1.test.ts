import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256, canonicalizeJson } from "../../src/contracts";
import { DEVELOPMENT_CASES } from "../cases/development-v1";
import { assessComparisonPair } from "../protocol/v1";
import { createRequestMetadata, RunManifestSchema } from "../runner/v1";
import {
  WORKFLOW_CONDITION_IDS,
  WORKFLOW_CONDITION_SPECS,
  WORKFLOW_DEVELOPMENT_CASES,
  WORKFLOW_DEVELOPMENT_CASE_SET,
  WorkflowConditionFixtureSchema,
  createWorkflowConditionFixture as createAuthorizedWorkflowConditionFixture,
  createWorkflowDevelopmentMatrix,
  materializeWorkflowConditionFixture as materializeAuthorizedWorkflowConditionFixture,
  type WorkflowConditionId,
  type WorkflowConditionFixture,
  type WorkflowDevelopmentCaseToken,
} from "./workflow-v1";

function workflowCaseTokenFor(
  developmentCase: unknown,
): WorkflowDevelopmentCaseToken {
  const index = DEVELOPMENT_CASES.findIndex(
    (accepted) => accepted === developmentCase,
  );
  return (index >= 0
    ? WORKFLOW_DEVELOPMENT_CASES[index]
    : developmentCase) as WorkflowDevelopmentCaseToken;
}

function createWorkflowConditionFixture(input: {
  developmentCase: unknown;
  conditionId: WorkflowConditionId;
  trialId: "trial-1" | "trial-2" | "trial-3";
  runId?: string;
  rerunOfRunId?: string | null;
}) {
  return createAuthorizedWorkflowConditionFixture(
    workflowCaseTokenFor(input.developmentCase),
    input.conditionId,
    input.trialId,
    input.runId,
    input.rerunOfRunId,
  );
}

function materializeWorkflowConditionFixture(input: {
  artifactRoot: string;
  fixture: WorkflowConditionFixture;
}) {
  return materializeAuthorizedWorkflowConditionFixture(
    input.fixture,
    input.artifactRoot,
  );
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryArtifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evidenceforge-workflow-conditions-"));
  temporaryRoots.push(root);
  return root;
}

function rehashFixture(fixture: WorkflowConditionFixture): void {
  fixture.fixtureHash = canonicalSha256({
    schemaVersion: fixture.schemaVersion,
    condition: fixture.condition,
    developmentCaseBundleHash: fixture.developmentCase.bundleHash,
    modelInputHash: fixture.modelInputHash,
    runConfig: fixture.runConfig,
    attempts: fixture.attempts,
  });
}

function rehashCanonicalRun(fixture: WorkflowConditionFixture): void {
  const parsed = fixture.attempts[0]!.parsed;
  if (parsed.parseStatus !== "valid") {
    throw new Error("test fixture must have a valid canonical run");
  }
  parsed.canonicalRunHash = canonicalSha256(parsed.canonicalRun);
  rehashFixture(fixture);
}

function synchronizeFixtureLatency(fixture: WorkflowConditionFixture): void {
  const attempt = fixture.attempts[0]!;
  const canonicalRun = attempt.parsed.canonicalRun!;
  const totalLatencyMs = canonicalRun.executions.reduce(
    (total, execution) => total + (execution.clientLatencyMs ?? 0),
    0,
  );
  (
    attempt.raw.rawOutput as {
      executionVisibility: { totalLatencyMs: number };
    }
  ).executionVisibility.totalLatencyMs = totalLatencyMs;
  attempt.raw.latencyMs = totalLatencyMs;
  rehashCanonicalRun(fixture);
}

function unapprovedSelfConsistentCase() {
  const developmentCase = structuredClone(DEVELOPMENT_CASES[0]);
  developmentCase.permissionNotes.push(
    "Self-consistent but not approved by the frozen two-case registry.",
  );
  const withoutBundleHash: Partial<typeof developmentCase> = {
    ...developmentCase,
  };
  delete withoutBundleHash.bundleHash;
  developmentCase.bundleHash = canonicalSha256({
    schemaVersion: "1.0.0",
    ...withoutBundleHash,
  });
  return developmentCase;
}

function trapCountingProxy<T extends object>(target: T) {
  let trapCount = 0;
  const proxy = new Proxy(target, {
    get(proxiedTarget, property, receiver) {
      trapCount += 1;
      return Reflect.get(proxiedTarget, property, receiver);
    },
    getOwnPropertyDescriptor(proxiedTarget, property) {
      trapCount += 1;
      return Reflect.getOwnPropertyDescriptor(proxiedTarget, property);
    },
    getPrototypeOf(proxiedTarget) {
      trapCount += 1;
      return Reflect.getPrototypeOf(proxiedTarget);
    },
    ownKeys(proxiedTarget) {
      trapCount += 1;
      return Reflect.ownKeys(proxiedTarget);
    },
  });
  return { proxy, trapCount: () => trapCount };
}

describe("workflow and ablation conditions v1", () => {
  it("defines exactly the complete workflow and two precise ablations without an unmeasured reviewer-family dimension", () => {
    expect(WORKFLOW_CONDITION_IDS).toEqual([
      "complete_workflow",
      "no_verification",
      "no_adversarial_review",
    ]);
    expect(WORKFLOW_CONDITION_SPECS.complete_workflow.removedContributions)
      .toEqual([]);
    expect(WORKFLOW_CONDITION_SPECS.no_verification.removedContributions)
      .toEqual([
        "deterministic_metadata_verification",
        "entailment_strength_verification",
      ]);
    expect(
      WORKFLOW_CONDITION_SPECS.no_adversarial_review.removedContributions,
    ).toEqual([
      "adversarial_experiment_review",
      "post_review_selective_revision",
    ]);
    expect(canonicalizeJson(WORKFLOW_CONDITION_SPECS)).not.toMatch(
      /same.family|cross.family/i,
    );
  });

  it.each(DEVELOPMENT_CASES)(
    "uses byte-identical model-visible input and parity-matched config for $benchmarkCase.id",
    (developmentCase) => {
      const fixtures = WORKFLOW_CONDITION_IDS.map((conditionId) =>
        createWorkflowConditionFixture({
          developmentCase,
          conditionId,
          trialId: "trial-1",
        }),
      );

      expect(new Set(fixtures.map(({ modelInputHash }) => modelInputHash)))
        .toHaveLength(1);
      expect(
        new Set(
          fixtures.map(
            ({ runConfig }) => runConfig.benchmarkConfig.pairingHash,
          ),
        ),
      ).toHaveLength(1);
      expect(
        new Set(
          fixtures.map(
            ({ runConfig }) => runConfig.benchmarkConfig.configHash,
          ),
        ),
      ).toHaveLength(3);
      expect(
        fixtures.map(
          ({ runConfig }) => runConfig.benchmarkConfig.trialPlan,
        ),
      ).toEqual([
        fixtures[0]!.runConfig.benchmarkConfig.trialPlan,
        fixtures[0]!.runConfig.benchmarkConfig.trialPlan,
        fixtures[0]!.runConfig.benchmarkConfig.trialPlan,
      ]);
      expect(
        fixtures.map(({ modelInput }) => canonicalizeJson(modelInput)),
      ).toEqual([
        canonicalizeJson(fixtures[0]!.modelInput),
        canonicalizeJson(fixtures[0]!.modelInput),
        canonicalizeJson(fixtures[0]!.modelInput),
      ]);
      for (const fixture of fixtures.slice(1)) {
        expect(
          assessComparisonPair({
            left: fixtures[0]!.runConfig.benchmarkConfig,
            right: fixture.runConfig.benchmarkConfig,
            reportingUse: "development",
          }),
        ).toMatchObject({ valid: true, invalidationReasons: [] });
      }
      for (const fixture of fixtures) {
        const serialized = canonicalizeJson(fixture.modelInput);
        expect(serialized).not.toMatch(
          /scoringKey|chunkExpectations|knownContradictions|graderInstructions/,
        );
      }
    },
  );

  it("runs the complete workflow through review and revision while preserving heterogeneous reviewer failure and retry visibility", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const canonicalRun = fixture.attempts[0]!.parsed.canonicalRun!;
    const rawOutput = fixture.attempts[0]!.raw.rawOutput as {
      stagePlan: Array<{ nodeId: string }>;
      executionVisibility: {
        totalCalls: number;
        reviewerCalls: number;
        failedCalls: number;
        totalLatencyMs: number;
        tokenUsage: { status: string };
        estimatedCost: { status: string };
      };
    };

    expect(rawOutput.stagePlan.map(({ nodeId }) => nodeId)).toEqual([
      "clarify-and-decompose",
      "collect-sources",
      "extract-evidence",
      "assess-entailment",
      "synthesize-conclusions",
      "plan-experiment",
      "review-experiment",
      "revise-experiment",
    ]);
    expect(canonicalRun.review).not.toBeNull();
    expect(canonicalRun.revision).not.toBeNull();
    expect(canonicalRun.errors).toHaveLength(1);
    expect(
      canonicalRun.executions.filter(
        ({ nodeId }) => nodeId === "review-experiment",
      ),
    ).toMatchObject([
      { status: "failed", retryOfExecutionId: null },
      { status: "succeeded" },
    ]);
    expect(
      canonicalRun.evidenceCards.every(
        ({ deterministicVerification }) =>
          deterministicVerification.status === "verified",
      ),
    ).toBe(true);
    expect(rawOutput.executionVisibility).toMatchObject({
      reviewerCalls: 2,
      failedCalls: 1,
      tokenUsage: { status: "unavailable" },
      estimatedCost: { status: "unavailable" },
    });
    expect(rawOutput.executionVisibility.totalCalls).toBeGreaterThan(7);
    expect(rawOutput.executionVisibility.totalLatencyMs).toBeGreaterThan(0);
    const failedReview = canonicalRun.executions.find(
      ({ nodeId, status }) =>
        nodeId === "review-experiment" && status === "failed",
    );
    const successfulReview = canonicalRun.executions.find(
      ({ nodeId, status }) =>
        nodeId === "review-experiment" && status === "succeeded",
    );
    expect(failedReview).toBeDefined();
    expect(successfulReview?.retryOfExecutionId).toBe(failedReview?.id);
    expect(successfulReview?.requestedBaseFamily).not.toBe(
      fixture.runConfig.benchmarkConfig.primaryModel.baseFamily,
    );
    expect(canonicalRun.errors).toHaveLength(1);
  });

  it("freezes the complete provider-outcome, body, finish-reason, timing, request, and retry table", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const executions = fixture.attempts[0]!.parsed.canonicalRun!.executions;
    const runId = fixture.runConfig.runId;
    const expectedRows = [
      ["clarify-and-decompose", 1, "succeeded", 12, 1, null],
      ["collect-sources", 1, "succeeded", 13, 2, null],
      ["extract-evidence", 1, "succeeded", 14, 3, null],
      ["assess-entailment", 1, "succeeded", 15, 4, null],
      ["synthesize-conclusions", 1, "succeeded", 16, 5, null],
      ["plan-experiment", 1, "succeeded", 17, 6, null],
      ["review-experiment", 1, "failed", 7, 7, null],
      ["review-experiment", 2, "succeeded", 19, 8, 7],
      ["revise-experiment", 1, "succeeded", 20, 9, null],
    ] as const;

    expect(
      executions.map((execution) => ({
        nodeId: execution.nodeId,
        attempt: execution.attempt,
        status: execution.status,
        body: execution.outputRefs.length === 1 ? "present" : "absent",
        finishReason: execution.finishReason,
        refused: execution.refusal.refused,
        clientLatencyMs: execution.clientLatencyMs,
        providerTiming: execution.providerTiming,
        clientRequestId: execution.requestIds.clientRequestId,
        retryOfExecutionId: execution.retryOfExecutionId,
      })),
    ).toEqual(
      expectedRows.map(
        ([nodeId, attempt, status, latency, sequence, retrySequence]) => ({
          nodeId,
          attempt,
          status,
          body: status === "succeeded" ? "present" : "absent",
          finishReason:
            status === "succeeded" ? "simulated_fixture_complete" : null,
          refused: false,
          clientLatencyMs: latency,
          providerTiming: {
            queueMs: null,
            promptMs: null,
            completionMs: null,
            totalMs: latency,
          },
          clientRequestId: `${runId}-${nodeId}-${sequence}-request`,
          retryOfExecutionId:
            retrySequence === null
              ? null
              : `${runId}-review-experiment-${retrySequence}`,
        }),
      ),
    );
    expect(fixture.attempts[0]).toMatchObject({
      raw: { status: "succeeded", failure: null },
      parsed: { parseStatus: "valid", validationIssues: [] },
    });
  });

  it("removes only deterministic metadata and entailment-strength verification while retaining identical input, planning, review, and revision", () => {
    const complete = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[1],
      conditionId: "complete_workflow",
      trialId: "trial-2",
    });
    const ablated = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[1],
      conditionId: "no_verification",
      trialId: "trial-2",
    });
    const canonicalRun = ablated.attempts[0]!.parsed.canonicalRun!;

    expect(ablated.modelInputHash).toBe(complete.modelInputHash);
    expect(
      canonicalRun.executions.some(
        ({ nodeId }) => nodeId === "assess-entailment",
      ),
    ).toBe(false);
    expect(
      canonicalRun.sources.every(
        ({ metadataVerification }) =>
          metadataVerification.status === "not_checked" &&
          metadataVerification.checkedAt === null,
      ),
    ).toBe(true);
    expect(
      canonicalRun.evidenceCards.every(
        ({ deterministicVerification, modelAssessment }) =>
          deterministicVerification.status === "not_checked" &&
          deterministicVerification.checkedAt === null &&
          modelAssessment.entailment === "unclear" &&
          modelAssessment.executionId.includes("extract-evidence"),
      ),
    ).toBe(true);
    expect(canonicalRun.review).not.toBeNull();
    expect(canonicalRun.revision).not.toBeNull();
  });

  it("stops the no-adversarial-review condition after the original experiment plan", () => {
    const complete = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-3",
    });
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "no_adversarial_review",
      trialId: "trial-3",
    });
    const canonicalRun = fixture.attempts[0]!.parsed.canonicalRun!;

    expect(canonicalRun.experiment).not.toBeNull();
    expect(canonicalRun.experiment).toEqual(
      complete.attempts[0]!.parsed.canonicalRun!.experiment,
    );
    expect(canonicalRun.review).toBeNull();
    expect(canonicalRun.objectionDispositionDecision).toBeNull();
    expect(canonicalRun.revision).toBeNull();
    expect(
      canonicalRun.executions.some(({ nodeId }) =>
        ["review-experiment", "revise-experiment"].includes(nodeId),
      ),
    ).toBe(false);
    expect(
      (fixture.attempts[0]!.raw.rawOutput as {
        executionVisibility: { reviewerCalls: number };
      }).executionVisibility.reviewerCalls,
    ).toBe(0);
  });

  it("builds a canonically ordered two-case, three-condition, three-trial development matrix without headline or live output", () => {
    const matrix = createWorkflowDevelopmentMatrix();

    expect(matrix).toHaveLength(18);
    expect(matrix.map(({ runConfig }) => runConfig.runId)).toEqual(
      [...matrix.map(({ runConfig }) => runConfig.runId)].sort(),
    );
    expect(
      matrix.every(
        ({ runConfig, attempts }) =>
          runConfig.evidenceMode === "simulated" &&
          runConfig.reportingUse === "development" &&
          runConfig.headlineEligible === false &&
          attempts[0]!.parsed.canonicalRun?.evidenceMode === "simulated",
      ),
    ).toBe(true);
  });

  it("rejects context, condition-plan, and canonical-stage tampering", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });

    const contextTamper = structuredClone(fixture);
    contextTamper.modelInput.benchmarkCase.originalQuestion += " changed";
    expect(() => WorkflowConditionFixtureSchema.parse(contextTamper)).toThrow();

    const planTamper = structuredClone(fixture);
    const rawOutput = planTamper.attempts[0]!.raw.rawOutput as {
      stagePlan: Array<{ nodeId: string }>;
    };
    rawOutput.stagePlan.reverse();
    rehashFixture(planTamper);
    expect(() => WorkflowConditionFixtureSchema.parse(planTamper)).toThrow();

    const executionTamper = structuredClone(fixture);
    executionTamper.attempts[0]!.parsed.canonicalRun!.executions =
      executionTamper.attempts[0]!.parsed.canonicalRun!.executions.filter(
        ({ nodeId }) => nodeId !== "assess-entailment",
      );
    executionTamper.attempts[0]!.parsed.canonicalRunHash = canonicalSha256(
      executionTamper.attempts[0]!.parsed.canonicalRun,
    );
    rehashFixture(executionTamper);
    expect(() => WorkflowConditionFixtureSchema.parse(executionTamper)).toThrow();

    const visibilityTamper = structuredClone(fixture);
    (
      visibilityTamper.attempts[0]!.raw.rawOutput as {
        executionVisibility: { reviewerCalls: number };
      }
    ).executionVisibility.reviewerCalls = 0;
    rehashFixture(visibilityTamper);
    expect(() => WorkflowConditionFixtureSchema.parse(visibilityTamper)).toThrow();
  });

  it("rejects a failed, not-parsed sole workflow attempt and an arbitrary fixture hash", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const attempt = fixture.attempts[0]!;
    if (
      attempt.raw.status !== "succeeded" ||
      attempt.parsed.parseStatus !== "valid"
    ) {
      throw new Error("generated fixture must contain a successful attempt");
    }
    attempt.raw = {
      schemaVersion: attempt.raw.schemaVersion,
      runId: attempt.raw.runId,
      attemptId: attempt.raw.attemptId,
      attemptNumber: attempt.raw.attemptNumber,
      trialId: attempt.raw.trialId,
      evidenceMode: attempt.raw.evidenceMode,
      startedAt: attempt.raw.startedAt,
      completedAt: attempt.raw.completedAt,
      latencyMs: attempt.raw.latencyMs,
      request: attempt.raw.request,
      status: "failed",
      rawOutput: null,
      failure: {
        kind: "fixture_failure",
        message: "synthetic outer workflow failure",
        retryable: false,
        providerCode: null,
      },
    };
    attempt.parsed = {
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
    };
    fixture.fixtureHash = "0".repeat(64);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects canonical model-visible input drift even when canonical and fixture hashes are recomputed", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    fixture.attempts[0]!.parsed.canonicalRun!.intake.intendedApplication =
      "Drifted application that was never in the selected case.";
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects outer requested-model drift after the request and fixture hashes are recomputed", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const raw = fixture.attempts[0]!.raw;
    raw.request = createRequestMetadata({
      ...raw.request,
      requestedModelId: "fixture-primary-drifted",
    });
    rehashFixture(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects successful returned-model identity drift after canonical and fixture hashes are recomputed", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const successfulReview =
      fixture.attempts[0]!.parsed.canonicalRun!.executions.find(
        ({ nodeId, status }) =>
          nodeId === "review-experiment" && status === "succeeded",
      );
    if (!successfulReview) throw new Error("review execution is required");
    successfulReview.returnedModelId = "fixture-reviewer-drifted";
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects coherent, fully rehashed successful-execution latency drift", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const execution =
      fixture.attempts[0]!.parsed.canonicalRun!.executions.find(
        ({ nodeId, status }) =>
          nodeId === "clarify-and-decompose" && status === "succeeded",
      );
    if (!execution || execution.clientLatencyMs === null) {
      throw new Error("successful execution latency is required");
    }
    execution.clientLatencyMs += 100;
    execution.providerTiming.totalMs = execution.clientLatencyMs;
    synchronizeFixtureLatency(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects coherent, fully rehashed failed-reviewer latency drift", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const execution =
      fixture.attempts[0]!.parsed.canonicalRun!.executions.find(
        ({ nodeId, status }) =>
          nodeId === "review-experiment" && status === "failed",
      );
    if (!execution || execution.clientLatencyMs === null) {
      throw new Error("failed reviewer latency is required");
    }
    execution.clientLatencyMs += 50;
    execution.providerTiming.totalMs = execution.clientLatencyMs;
    synchronizeFixtureLatency(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects a fully rehashed deterministic client-request identity drift", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    fixture.attempts[0]!.parsed.canonicalRun!.executions[0]!.requestIds.clientRequestId =
      "drifted-client-request";
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects contradictory provider timing after canonical and fixture rehashing", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const execution = fixture.attempts[0]!.parsed.canonicalRun!.executions[0]!;
    execution.providerTiming.totalMs =
      (execution.providerTiming.totalMs ?? 0) + 500;
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects a succeeded execution carrying a refusal outcome after full rehashing", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const execution = fixture.attempts[0]!.parsed.canonicalRun!.executions[0]!;
    execution.refusal = {
      refused: true,
      reason: "synthetic refusal relabel",
    };
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();

    const relabeled = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const relabeledExecution =
      relabeled.attempts[0]!.parsed.canonicalRun!.executions[0]!;
    relabeledExecution.status = "refused";
    relabeledExecution.outputRefs = [];
    relabeledExecution.finishReason = "simulated_fixture_refusal";
    relabeledExecution.refusal = {
      refused: true,
      reason: "synthetic status relabel",
    };
    relabeledExecution.validation = {
      valid: false,
      issues: ["Synthetic refusal relabel."],
    };
    rehashCanonicalRun(relabeled);

    expect(() => WorkflowConditionFixtureSchema.parse(relabeled)).toThrow();
  });

  it("rejects fully rehashed deterministic finish-reason drift", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    fixture.attempts[0]!.parsed.canonicalRun!.executions[0]!.finishReason =
      "drifted_finish_reason";
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects observed usage and cost when the raw summary still reports unavailable", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const successfulPrimary =
      fixture.attempts[0]!.parsed.canonicalRun!.executions.find(
        ({ nodeId, status }) =>
          nodeId === "clarify-and-decompose" && status === "succeeded",
      );
    if (!successfulPrimary) throw new Error("primary execution is required");
    successfulPrimary.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    };
    successfulPrimary.pricing = {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      estimatedCost: 0.00002,
      snapshotDate: "2026-08-07",
    };
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).toThrow();
  });

  it("accepts the preserved reviewer failure and coherent partial usage visibility", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const canonicalRun = fixture.attempts[0]!.parsed.canonicalRun!;
    const failedReview = canonicalRun.executions.find(
      ({ nodeId, status }) =>
        nodeId === "review-experiment" && status === "failed",
    );
    const successfulPrimary = canonicalRun.executions.find(
      ({ nodeId, status }) =>
        nodeId === "clarify-and-decompose" && status === "succeeded",
    );
    if (!failedReview || !successfulPrimary) {
      throw new Error("fixture must preserve both boundary executions");
    }
    expect(failedReview).toMatchObject({
      returnedProvider: null,
      returnedModelId: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      pricing: { estimatedCost: null },
    });

    successfulPrimary.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    };
    successfulPrimary.pricing = {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      estimatedCost: 0.00002,
      snapshotDate: "2026-08-07",
    };
    const visibility = (
      fixture.attempts[0]!.raw.rawOutput as {
        executionVisibility: {
          tokenUsage: {
            status: string;
            inputTokens: number | null;
            outputTokens: number | null;
            totalTokens: number | null;
          };
          estimatedCost: {
            status: string;
            currency: string;
            value: number | null;
          };
        };
      }
    ).executionVisibility;
    visibility.tokenUsage = {
      status: "partial",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
    visibility.estimatedCost = {
      status: "partial",
      currency: "USD",
      value: 0.00002,
    };
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("accepts coherent partial telemetry on the preserved failed reviewer without fabricating a body", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const failedReview =
      fixture.attempts[0]!.parsed.canonicalRun!.executions.find(
        ({ nodeId, status }) =>
          nodeId === "review-experiment" && status === "failed",
      );
    if (!failedReview) throw new Error("failed reviewer is required");
    failedReview.usage.inputTokens = 4;
    failedReview.pricing = {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      estimatedCost: null,
      snapshotDate: "2026-08-07",
    };
    const visibility = (
      fixture.attempts[0]!.raw.rawOutput as {
        executionVisibility: {
          tokenUsage: {
            status: string;
            inputTokens: number | null;
            outputTokens: number | null;
            totalTokens: number | null;
          };
          estimatedCost: {
            status: string;
            currency: string;
            value: number | null;
          };
        };
      }
    ).executionVisibility;
    visibility.tokenUsage = {
      status: "partial",
      inputTokens: 4,
      outputTokens: null,
      totalTokens: null,
    };
    visibility.estimatedCost = {
      status: "partial",
      currency: "USD",
      value: null,
    };
    rehashCanonicalRun(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(fixture)).not.toThrow();
    expect(failedReview).toMatchObject({
      status: "failed",
      outputRefs: [],
      finishReason: null,
      returnedProvider: null,
      returnedModelId: null,
      usage: { inputTokens: 4, outputTokens: null, totalTokens: null },
    });
  });

  it("rejects accessor-bearing and exotic-prototype creator input without invoking accessors", () => {
    const accessorCase = structuredClone(DEVELOPMENT_CASES[0]);
    const originalQuestion = accessorCase.benchmarkCase.originalQuestion;
    let getterCalls = 0;
    Object.defineProperty(accessorCase.benchmarkCase, "originalQuestion", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return originalQuestion;
      },
    });

    expect(() =>
      createWorkflowConditionFixture({
        developmentCase: accessorCase,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }),
    ).toThrow(/approved|accepted|brand|authority/i);
    expect(getterCalls).toBe(0);

    const exoticCase = structuredClone(DEVELOPMENT_CASES[0]);
    Object.setPrototypeOf(exoticCase.benchmarkCase, { inherited: true });
    expect(() =>
      createWorkflowConditionFixture({
        developmentCase: exoticCase,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }),
    ).toThrow(/approved|accepted|brand|authority/i);
  });

  it("rejects accessor-bearing materialization input without invoking its getter", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    let getterCalls = 0;
    const fakeFixture = structuredClone(fixture);
    Object.defineProperty(fakeFixture, "condition", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return fixture.condition;
      },
    });

    await expect(
      materializeAuthorizedWorkflowConditionFixture(
        fakeFixture,
        artifactRoot,
      ),
    ).rejects.toThrow(/approved|accepted|brand|authority/i);
    expect(getterCalls).toBe(0);
  });

  it("rejects a fully self-consistent unapproved development case in creator and matrix boundaries", () => {
    const unapproved = unapprovedSelfConsistentCase();

    expect(() =>
      createWorkflowConditionFixture({
        developmentCase: unapproved,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }),
    ).toThrow(/approved|accepted|registry|authority/i);
    expect(() =>
      createWorkflowDevelopmentMatrix([
        DEVELOPMENT_CASES[0],
        unapproved,
      ] as unknown as Parameters<
        typeof createWorkflowDevelopmentMatrix
      >[0]),
    ).toThrow(/approved|accepted|registry|authority/i);
  });

  it("rejects creator outer and nested proxies without executing a single trap", () => {
    const outer = trapCountingProxy(WORKFLOW_DEVELOPMENT_CASES[0]);
    expect(() =>
      createAuthorizedWorkflowConditionFixture(
        outer.proxy as unknown as WorkflowDevelopmentCaseToken,
        "complete_workflow",
        "trial-1",
      ),
    ).toThrow(/approved|accepted|brand|authority/i);
    expect(outer.trapCount()).toBe(0);

    const nestedCase = structuredClone(DEVELOPMENT_CASES[0]);
    const nested = trapCountingProxy(nestedCase.benchmarkCase);
    nestedCase.benchmarkCase = nested.proxy;
    expect(() =>
      createWorkflowConditionFixture({
        developmentCase: nestedCase,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }),
    ).toThrow(/approved|accepted|brand|authority/i);
    expect(nested.trapCount()).toBe(0);
  });

  it("rejects proxied and cloned exported-schema inputs before traversal", () => {
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const proxied = trapCountingProxy(fixture);

    expect(() => WorkflowConditionFixtureSchema.parse(proxied.proxy)).toThrow(
      /approved|accepted|brand|authority/i,
    );
    expect(proxied.trapCount()).toBe(0);
    expect(
      WorkflowConditionFixtureSchema.safeParse(proxied.proxy).success,
    ).toBe(false);
    expect(proxied.trapCount()).toBe(0);
    expect(() =>
      WorkflowConditionFixtureSchema.parse(structuredClone(fixture)),
    ).toThrow(/approved|accepted|brand|authority/i);
  });

  it("rejects cloned and structurally forged case and case-set brands", () => {
    const clonedCaseToken = structuredClone(WORKFLOW_DEVELOPMENT_CASES[0]);
    expect(() =>
      createAuthorizedWorkflowConditionFixture(
        clonedCaseToken,
        "complete_workflow",
        "trial-1",
      ),
    ).toThrow(/approved|accepted|brand|authority/i);

    const forgedCaseToken = {
      caseId: WORKFLOW_DEVELOPMENT_CASES[0].caseId,
    } as WorkflowDevelopmentCaseToken;
    expect(() =>
      createAuthorizedWorkflowConditionFixture(
        forgedCaseToken,
        "complete_workflow",
        "trial-1",
      ),
    ).toThrow(/approved|accepted|brand|authority/i);

    expect(() =>
      createWorkflowDevelopmentMatrix(
        structuredClone(WORKFLOW_DEVELOPMENT_CASE_SET),
      ),
    ).toThrow(/approved|accepted|brand|authority/i);
  });

  it("rejects a proxied materializer input before executing a single trap", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[0],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const proxied = trapCountingProxy(fixture);

    await expect(
      materializeAuthorizedWorkflowConditionFixture(
        proxied.proxy as WorkflowConditionFixture,
        artifactRoot,
      ),
    ).rejects.toThrow(/approved|accepted|brand|authority/i);
    expect(proxied.trapCount()).toBe(0);
  });

  it("uses an internally owned case snapshot, rejects aliases, and remains creation-order deterministic", () => {
    const acceptedCase = DEVELOPMENT_CASES[0];
    const before = structuredClone(acceptedCase);
    const reverse = [...WORKFLOW_CONDITION_IDS]
      .reverse()
      .map((conditionId) =>
        createWorkflowConditionFixture({
          developmentCase: acceptedCase,
          conditionId,
          trialId: "trial-1",
        }),
      );
    const forward = WORKFLOW_CONDITION_IDS.map((conditionId) =>
      createWorkflowConditionFixture({
        developmentCase: acceptedCase,
        conditionId,
        trialId: "trial-1",
      }),
    );

    expect(acceptedCase).toEqual(before);
    const alias = structuredClone(acceptedCase);
    alias.permissionNotes.push("Caller-owned alias mutation.");
    expect(() =>
      createWorkflowConditionFixture({
        developmentCase: alias,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }),
    ).toThrow(/approved|accepted|brand|authority/i);

    const mutatedFixture = createWorkflowConditionFixture({
      developmentCase: acceptedCase,
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    mutatedFixture.developmentCase.permissionNotes.push(
      "Mutation through a caller-held fixture alias.",
    );
    expect(() =>
      WorkflowConditionFixtureSchema.parse(mutatedFixture),
    ).toThrow();
    expect(
      createWorkflowConditionFixture({
        developmentCase: acceptedCase,
        conditionId: "complete_workflow",
        trialId: "trial-1",
      }).developmentCase,
    ).toEqual(before);
    expect(
      reverse
        .sort((left, right) =>
          left.condition.id.localeCompare(right.condition.id),
        )
        .map(({ fixtureHash }) => fixtureHash),
    ).toEqual(
      forward
        .sort((left, right) =>
          left.condition.id.localeCompare(right.condition.id),
        )
        .map(({ fixtureHash }) => fixtureHash),
    );
  });

  it("materializes raw and canonical artifacts through the accepted runner and refuses overwrite without changing bytes", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const fixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[1],
      conditionId: "complete_workflow",
      trialId: "trial-1",
    });
    const first = await materializeWorkflowConditionFixture({
      artifactRoot,
      fixture,
    });
    const manifestBytes = await readFile(first.manifestPath, "utf8");
    const manifest = RunManifestSchema.parse(JSON.parse(manifestBytes));
    const rawPath = join(
      first.runPath,
      "raw",
      `attempt-001-${fixture.attempts[0]!.raw.attemptId}.json`,
    );
    const parsedPath = join(
      first.runPath,
      "parsed",
      `attempt-001-${fixture.attempts[0]!.raw.attemptId}.json`,
    );
    const raw = JSON.parse(await readFile(rawPath, "utf8")) as {
      rawOutput: { modelInputHash: string; conditionId: string };
    };
    const parsed = JSON.parse(await readFile(parsedPath, "utf8")) as {
      canonicalRun: { evidenceMode: string };
    };

    expect(manifest).toMatchObject({
      conditionId: "complete_workflow",
      evidenceMode: "simulated",
      reportingUse: "development",
      resultClass: "smoke_only",
      headlineEligible: false,
      complete: true,
    });
    expect(raw.rawOutput).toMatchObject({
      conditionId: "complete_workflow",
      modelInputHash: fixture.modelInputHash,
    });
    expect(parsed.canonicalRun.evidenceMode).toBe("simulated");

    await expect(
      materializeWorkflowConditionFixture({ artifactRoot, fixture }),
    ).rejects.toThrow(/already exists/i);
    expect(await readFile(first.manifestPath, "utf8")).toBe(manifestBytes);

    const rerunFixture = createWorkflowConditionFixture({
      developmentCase: DEVELOPMENT_CASES[1],
      conditionId: "complete_workflow",
      trialId: "trial-1",
      runId: `${fixture.runConfig.runId}-rerun`,
      rerunOfRunId: fixture.runConfig.runId,
    });
    const rerun = await materializeWorkflowConditionFixture({
      artifactRoot,
      fixture: rerunFixture,
    });
    expect(
      RunManifestSchema.parse(
        JSON.parse(await readFile(rerun.manifestPath, "utf8")),
      ).rerunOfRunId,
    ).toBe(fixture.runConfig.runId);
    expect(await readFile(first.manifestPath, "utf8")).toBe(manifestBytes);
  });
});
