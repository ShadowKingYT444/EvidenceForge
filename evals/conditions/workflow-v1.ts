import { z } from "zod";

import {
  ResearchRunSchema,
  canonicalSha256,
  canonicalizeJson,
  freezePacket,
  type NodeExecution,
  type ResearchRun,
} from "../../src/contracts";
import {
  DEVELOPMENT_CASES,
  DevelopmentCaseSchema,
  toDevelopmentCaseModelInput,
  type DevelopmentCase,
} from "../cases/development-v1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  createBenchmarkConfig,
} from "../protocol/v1";
import {
  EVAL_RUNNER_VERSION,
  EvalRunConfigSchema,
  RecordedAttemptSchema,
  createRequestMetadata,
  createValidParsedAttempt,
  materializeFixtureRun,
  type EvalRunConfig,
  type RecordedAttempt,
} from "../runner/v1";

export const WORKFLOW_CONDITION_VERSION = "1.0.0" as const;

export const WORKFLOW_CONDITION_IDS = Object.freeze([
  "complete_workflow",
  "no_verification",
  "no_adversarial_review",
] as const);

export type WorkflowConditionId =
  (typeof WORKFLOW_CONDITION_IDS)[number];

const WorkflowConditionIdSchema = z.enum(WORKFLOW_CONDITION_IDS);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

declare const workflowDevelopmentCaseTokenBrand: unique symbol;
declare const workflowDevelopmentCaseSetTokenBrand: unique symbol;

export type WorkflowDevelopmentCaseToken = Readonly<{
  caseId: string;
  [workflowDevelopmentCaseTokenBrand]: true;
}>;

export type WorkflowDevelopmentCaseSetToken = Readonly<{
  version: typeof WORKFLOW_CONDITION_VERSION;
  [workflowDevelopmentCaseSetTokenBrand]: true;
}>;

const acceptedDevelopmentCaseSnapshots = DEVELOPMENT_CASES.map(
  (developmentCase) =>
    DevelopmentCaseSchema.parse(structuredClone(developmentCase)),
);
const acceptedCaseByBundleHash = new Map(
  acceptedDevelopmentCaseSnapshots.map((developmentCase) => [
    developmentCase.bundleHash,
    developmentCase,
  ]),
);
const acceptedCaseByToken = new WeakMap<object, DevelopmentCase>();

export const WORKFLOW_DEVELOPMENT_CASES = Object.freeze(
  acceptedDevelopmentCaseSnapshots.map((developmentCase) => {
    const token = Object.freeze({
      caseId: developmentCase.benchmarkCase.id,
    }) as WorkflowDevelopmentCaseToken;
    acceptedCaseByToken.set(token, developmentCase);
    return token;
  }),
);

const acceptedCaseSetByToken = new WeakMap<
  object,
  readonly WorkflowDevelopmentCaseToken[]
>();
export const WORKFLOW_DEVELOPMENT_CASE_SET = Object.freeze({
  version: WORKFLOW_CONDITION_VERSION,
}) as WorkflowDevelopmentCaseSetToken;
acceptedCaseSetByToken.set(
  WORKFLOW_DEVELOPMENT_CASE_SET,
  WORKFLOW_DEVELOPMENT_CASES,
);

function acceptedCaseSnapshot(candidate: unknown): DevelopmentCase {
  const accepted =
    typeof candidate === "object" && candidate !== null
      ? acceptedCaseByToken.get(candidate)
      : undefined;
  if (!accepted) {
    throw new TypeError(
      "workflow development case must be an accepted registry token",
    );
  }
  return structuredClone(accepted);
}

function assertPlainData(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only plain data`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} must not contain circular plain data`);
  }
  seen.add(value);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (isArray ? Array.prototype : Object.prototype)
  ) {
    throw new TypeError(`${path} has a non-plain prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol properties`);
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if ("get" in descriptor || "set" in descriptor) {
      throw new TypeError(`${path}.${key} must not be an accessor`);
    }
    if (isArray && key === "length") continue;
    assertPlainData(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

const RemovedContributionSchema = z.enum([
  "deterministic_metadata_verification",
  "entailment_strength_verification",
  "adversarial_experiment_review",
  "post_review_selective_revision",
]);

const ModelRoleSchema = z.enum([
  "primary",
  "heterogeneous_reviewer",
  "deterministic_boundary",
]);

const StagePlanEntrySchema = z
  .object({
    nodeId: z.enum([
      "clarify-and-decompose",
      "collect-sources",
      "extract-evidence",
      "assess-entailment",
      "synthesize-conclusions",
      "plan-experiment",
      "review-experiment",
      "revise-experiment",
    ]),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    promptHash: HashSchema,
    modelRole: ModelRoleSchema,
    contribution: z.string().min(1),
  })
  .strict();

type StagePlanEntry = z.infer<typeof StagePlanEntrySchema>;

const allStages = Object.freeze([
  {
    nodeId: "clarify-and-decompose",
    promptId: "clarify-decompose",
    modelRole: "primary",
    contribution: "bounded claim and scope decomposition",
  },
  {
    nodeId: "collect-sources",
    promptId: "collect-bounded-source-packet",
    modelRole: "deterministic_boundary",
    contribution: "frozen user-approved packet boundary",
  },
  {
    nodeId: "extract-evidence",
    promptId: "extract-grounded-evidence",
    modelRole: "primary",
    contribution: "literal chunk-linked evidence extraction",
  },
  {
    nodeId: "assess-entailment",
    promptId: "assess-evidence-entailment",
    modelRole: "primary",
    contribution: "entailment-strength verification",
  },
  {
    nodeId: "synthesize-conclusions",
    promptId: "synthesize-conclusions-gaps",
    modelRole: "primary",
    contribution: "bounded conclusion and gap synthesis",
  },
  {
    nodeId: "plan-experiment",
    promptId: "design-reviewable-experiment",
    modelRole: "primary",
    contribution: "original reviewable experiment plan",
  },
  {
    nodeId: "review-experiment",
    promptId: "adversarial-experiment-review",
    modelRole: "heterogeneous_reviewer",
    contribution: "adversarial experiment review",
  },
  {
    nodeId: "revise-experiment",
    promptId: "selective-experiment-revision",
    modelRole: "primary",
    contribution: "selective post-review revision",
  },
] as const);

function promptDescriptor(promptId: string) {
  const prompt = FROZEN_CONSUMER_EDGE.promptManifest.find(
    ({ id }) => id === promptId,
  );
  if (!prompt) throw new Error(`missing frozen prompt resource: ${promptId}`);
  return prompt;
}

function stagePlanFor(conditionId: WorkflowConditionId): StagePlanEntry[] {
  return allStages
    .filter(({ nodeId }) => {
      if (conditionId === "no_verification")
        return nodeId !== "assess-entailment";
      if (conditionId === "no_adversarial_review")
        return !["review-experiment", "revise-experiment"].includes(nodeId);
      return true;
    })
    .map((stage) => {
      const prompt = promptDescriptor(stage.promptId);
      return StagePlanEntrySchema.parse({
        ...stage,
        promptVersion: prompt.version,
        promptHash: prompt.hash,
      });
    });
}

export const WORKFLOW_CONDITION_SPECS = Object.freeze({
  complete_workflow: Object.freeze({
    id: "complete_workflow" as const,
    label: "Complete workflow",
    removedContributions: Object.freeze([] as const),
  }),
  no_verification: Object.freeze({
    id: "no_verification" as const,
    label: "No-verification ablation",
    removedContributions: Object.freeze([
      "deterministic_metadata_verification",
      "entailment_strength_verification",
    ] as const),
  }),
  no_adversarial_review: Object.freeze({
    id: "no_adversarial_review" as const,
    label: "No-adversarial-review ablation",
    removedContributions: Object.freeze([
      "adversarial_experiment_review",
      "post_review_selective_revision",
    ] as const),
  }),
});

const ConditionSpecSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_CONDITION_VERSION),
    id: WorkflowConditionIdSchema,
    label: z.string().min(1),
    removedContributions: z.array(RemovedContributionSchema),
    stagePlan: z.array(StagePlanEntrySchema).min(1),
    specHash: HashSchema,
  })
  .strict()
  .superRefine((condition, context) => {
    const { specHash, ...payload } = condition;
    if (specHash !== canonicalSha256(payload)) {
      context.addIssue({
        code: "custom",
        path: ["specHash"],
        message: "condition spec hash does not match its canonical payload",
      });
    }
  });

type ConditionSpec = z.infer<typeof ConditionSpecSchema>;

function conditionSpec(conditionId: WorkflowConditionId): ConditionSpec {
  const declared = WORKFLOW_CONDITION_SPECS[conditionId];
  const payload = {
    schemaVersion: WORKFLOW_CONDITION_VERSION,
    id: declared.id,
    label: declared.label,
    removedContributions: [...declared.removedContributions],
    stagePlan: stagePlanFor(conditionId),
  };
  return ConditionSpecSchema.parse({
    ...payload,
    specHash: canonicalSha256(payload),
  });
}

const AvailabilitySchema = z
  .object({
    status: z.enum(["available", "partial", "unavailable"]),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    const values = [
      summary.inputTokens,
      summary.outputTokens,
      summary.totalTokens,
    ];
    if (
      (summary.status === "unavailable" &&
        values.some((value) => value !== null)) ||
      (summary.status === "available" &&
        values.some((value) => value === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "token availability must match the reported token totals",
      });
    }
  });

const CostAvailabilitySchema = z
  .object({
    status: z.enum(["available", "partial", "unavailable"]),
    currency: z.literal("USD"),
    value: z.number().nonnegative().nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      (summary.status === "unavailable" && summary.value !== null) ||
      (summary.status === "available" && summary.value === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "cost availability must match the reported cost total",
      });
    }
  });

const ExecutionVisibilitySchema = z
  .object({
    totalCalls: z.number().int().nonnegative(),
    primaryCalls: z.number().int().nonnegative(),
    reviewerCalls: z.number().int().nonnegative(),
    deterministicBoundaryExecutions: z.number().int().nonnegative(),
    failedCalls: z.number().int().nonnegative(),
    totalLatencyMs: z.number().int().nonnegative(),
    tokenUsage: AvailabilitySchema,
    estimatedCost: CostAvailabilitySchema,
  })
  .strict();

const WorkflowFixtureRawOutputSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_CONDITION_VERSION),
    conditionId: WorkflowConditionIdSchema,
    conditionSpecHash: HashSchema,
    caseId: z.string().min(1),
    trialId: z.string().min(1),
    modelInputHash: HashSchema,
    configHash: HashSchema,
    stagePlan: z.array(StagePlanEntrySchema).min(1),
    removedContributions: z.array(RemovedContributionSchema),
    executionVisibility: ExecutionVisibilitySchema,
    note: z.literal(
      "Deterministic simulated structure only; no provider executed and no quality result is claimed.",
    ),
  })
  .strict();

type DevelopmentCaseModelInput = ReturnType<
  typeof toDevelopmentCaseModelInput
>;

export type WorkflowConditionFixture = {
  schemaVersion: typeof WORKFLOW_CONDITION_VERSION;
  condition: ConditionSpec;
  developmentCase: DevelopmentCase;
  modelInput: DevelopmentCaseModelInput;
  modelInputHash: string;
  runConfig: EvalRunConfig;
  attempts: RecordedAttempt[];
  fixtureHash: string;
};

const WorkflowConditionFixtureBaseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_CONDITION_VERSION),
    condition: ConditionSpecSchema,
    developmentCase: DevelopmentCaseSchema,
    modelInput: z.json(),
    modelInputHash: HashSchema,
    runConfig: EvalRunConfigSchema,
    attempts: z.array(RecordedAttemptSchema).length(1),
    fixtureHash: HashSchema,
  })
  .strict();

function fixtureHashPayload(
  fixture: Omit<WorkflowConditionFixture, "fixtureHash">,
) {
  return {
    schemaVersion: fixture.schemaVersion,
    condition: fixture.condition,
    developmentCaseBundleHash: fixture.developmentCase.bundleHash,
    modelInputHash: fixture.modelInputHash,
    runConfig: fixture.runConfig,
    attempts: fixture.attempts,
  };
}

function expectedExecutionNodes(conditionId: WorkflowConditionId): string[] {
  return stagePlanFor(conditionId).flatMap(({ nodeId }) =>
    nodeId === "review-experiment" ? [nodeId, nodeId] : [nodeId],
  );
}

function canonicalInputState(run: ResearchRun) {
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    status: run.status,
    evidenceMode: run.evidenceMode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    intake: run.intake,
    claims: run.claims,
    scopeDecision: run.scopeDecision,
    packet: run.packet,
    sources: run.sources,
    chunks: run.chunks,
  };
}

function executionGraphState(run: ResearchRun) {
  return {
    executions: run.executions.map((execution) => ({
      id: execution.id,
      nodeId: execution.nodeId,
      attempt: execution.attempt,
      status: execution.status,
      evidenceMode: execution.evidenceMode,
      inputRefs: execution.inputRefs,
      outputRefs: execution.outputRefs,
      promptId: execution.promptId,
      promptVersion: execution.promptVersion,
      promptHash: execution.promptHash,
      structuredOutputSchemaVersion:
        execution.structuredOutputSchemaVersion,
      generationSettings: execution.generationSettings,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      clientLatencyMs: execution.clientLatencyMs,
      providerTiming: execution.providerTiming,
      requestIds: execution.requestIds,
      finishReason: execution.finishReason,
      refusal: execution.refusal,
      returnedReasoningMode: execution.returnedReasoningMode,
      validation: execution.validation,
      errorIds: execution.errorIds,
      retryOfExecutionId: execution.retryOfExecutionId,
      fallbackFromExecutionId: execution.fallbackFromExecutionId,
      codeVersion: execution.codeVersion,
    })),
    errors: run.errors,
  };
}

function hasCoherentDeterministicOutcome(
  execution: NodeExecution,
): boolean {
  const hasFrozenTerminalTiming =
    execution.endedAt !== null &&
    execution.clientLatencyMs !== null &&
    execution.providerTiming.queueMs === null &&
    execution.providerTiming.promptMs === null &&
    execution.providerTiming.completionMs === null &&
    execution.providerTiming.totalMs === execution.clientLatencyMs;
  const hasFrozenRequestIdentity =
    execution.requestIds.clientRequestId === `${execution.id}-request` &&
    execution.requestIds.providerRequestId === null &&
    execution.requestIds.responseId === null;
  if (!hasFrozenTerminalTiming || !hasFrozenRequestIdentity) return false;

  if (execution.status === "succeeded") {
    const retryIsCoherent =
      execution.attempt === 1
        ? execution.retryOfExecutionId === null
        : execution.attempt === 2 &&
          execution.nodeId === "review-experiment" &&
          execution.retryOfExecutionId !== null;
    return (
      retryIsCoherent &&
      execution.outputRefs.length === 1 &&
      execution.finishReason === "simulated_fixture_complete" &&
      execution.refusal.refused === false &&
      execution.refusal.reason === null &&
      execution.validation.valid === true &&
      execution.validation.issues.length === 0 &&
      execution.errorIds.length === 0
    );
  }

  if (execution.status === "failed") {
    return (
      execution.nodeId === "review-experiment" &&
      execution.attempt === 1 &&
      execution.retryOfExecutionId === null &&
      execution.outputRefs.length === 0 &&
      execution.finishReason === null &&
      execution.refusal.refused === false &&
      execution.refusal.reason === null &&
      execution.validation.valid === false &&
      execution.validation.issues.length > 0 &&
      execution.errorIds.length === 1
    );
  }

  return false;
}

function executionModelIdentity(
  execution: NodeExecution,
  expected: ReturnType<typeof modelForRole>,
): boolean {
  if (
    execution.requestedProvider !== expected.provider ||
    execution.requestedModelId !== expected.modelId ||
    execution.requestedDeveloperFamily !== expected.developerFamily ||
    execution.requestedBaseFamily !== expected.baseFamily ||
    execution.fallbackFromExecutionId !== null ||
    execution.pricing.currency !== "USD"
  ) {
    return false;
  }
  if (execution.status === "succeeded") {
    return (
      execution.returnedProvider === expected.provider &&
      execution.returnedModelId === expected.modelId &&
      execution.returnedDeveloperFamily === expected.developerFamily &&
      execution.returnedBaseFamily === expected.baseFamily &&
      execution.returnedReasoningMode !== null
    );
  }
  return (
    execution.returnedProvider === null &&
    execution.returnedModelId === null &&
    execution.returnedDeveloperFamily === null &&
    execution.returnedBaseFamily === null &&
    execution.returnedReasoningMode === null
  );
}

const ValidatedWorkflowConditionFixtureSchema =
  WorkflowConditionFixtureBaseSchema.superRefine((fixture, context) => {
    const computedFixtureHash = canonicalSha256(
      fixtureHashPayload(
        fixture as unknown as Omit<
          WorkflowConditionFixture,
          "fixtureHash"
        >,
      ),
    );
    if (fixture.fixtureHash !== computedFixtureHash) {
      context.addIssue({
        code: "custom",
        path: ["fixtureHash"],
        message: "fixture hash does not match the full workflow fixture",
      });
    }

    const expectedCondition = conditionSpec(fixture.condition.id);
    if (
      canonicalizeJson(fixture.condition) !==
      canonicalizeJson(expectedCondition)
    ) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "condition does not match the frozen condition definition",
      });
    }

    const acceptedDevelopmentCase = acceptedCaseByBundleHash.get(
      fixture.developmentCase.bundleHash,
    );
    if (
      !acceptedDevelopmentCase ||
      canonicalizeJson(fixture.developmentCase) !==
        canonicalizeJson(acceptedDevelopmentCase)
    ) {
      context.addIssue({
        code: "custom",
        path: ["developmentCase"],
        message:
          "development case is not an exact accepted registry snapshot",
      });
    }
    const authoritativeDevelopmentCase =
      acceptedDevelopmentCase ?? acceptedDevelopmentCaseSnapshots[0]!;
    const expectedModelInput = toDevelopmentCaseModelInput(
      authoritativeDevelopmentCase,
    );
    const computedModelInputHash = canonicalSha256(fixture.modelInput);
    if (
      canonicalizeJson(fixture.modelInput) !==
        canonicalizeJson(expectedModelInput) ||
      fixture.modelInputHash !== computedModelInputHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelInput"],
        message: "model input must be the exact grader-safe case projection",
      });
    }

    if (
      fixture.runConfig.benchmarkConfig.conditionId !== fixture.condition.id ||
      fixture.runConfig.benchmarkConfig.case.caseHash !==
        authoritativeDevelopmentCase.benchmarkCase.caseHash ||
      fixture.runConfig.evidenceMode !== "simulated"
    ) {
      context.addIssue({
        code: "custom",
        path: ["runConfig"],
        message: "run config does not bind the condition and frozen case",
      });
    }
    const expectedBenchmarkConfig = benchmarkConfigFor({
      developmentCase: authoritativeDevelopmentCase,
      conditionId: fixture.condition.id,
    });
    if (
      canonicalizeJson(fixture.runConfig.benchmarkConfig) !==
      canonicalizeJson(expectedBenchmarkConfig)
    ) {
      context.addIssue({
        code: "custom",
        path: ["runConfig", "benchmarkConfig"],
        message: "benchmark config drifted from the parity-matched fixture",
      });
    }

    const attempt = fixture.attempts[0]!;
    const expectedAttemptId = `${fixture.runConfig.runId}-attempt`;
    const expectedRequest = createRequestMetadata({
      runId: fixture.runConfig.runId,
      attemptId: expectedAttemptId,
      trialId: fixture.runConfig.trialId,
      evidenceMode: "simulated",
      requestedAt: timestamp(0),
      requestedProvider: expectedBenchmarkConfig.primaryModel.provider,
      requestedModelId: expectedBenchmarkConfig.primaryModel.modelId,
      providerRequestId: null,
      seed: null,
      generation: expectedBenchmarkConfig.generation,
      promptManifestHash: expectedBenchmarkConfig.promptManifestHash,
    });
    if (
      attempt.raw.status !== "succeeded" ||
      attempt.parsed.parseStatus !== "valid" ||
      attempt.raw.runId !== fixture.runConfig.runId ||
      attempt.raw.attemptId !== expectedAttemptId ||
      attempt.raw.attemptNumber !== 1 ||
      attempt.raw.trialId !== fixture.runConfig.trialId ||
      attempt.raw.evidenceMode !== "simulated" ||
      attempt.raw.startedAt !== timestamp(0) ||
      attempt.raw.completedAt !== timestamp(31) ||
      canonicalizeJson(attempt.raw.request) !==
        canonicalizeJson(expectedRequest)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts", 0],
        message:
          "workflow fixture requires one successful canonical attempt with frozen request identity",
      });
    }

    const rawResult = WorkflowFixtureRawOutputSchema.safeParse(
      attempt.raw.rawOutput,
    );
    if (!rawResult.success) {
      context.addIssue({
        code: "custom",
        path: ["attempts", 0, "raw", "rawOutput"],
        message: "raw condition envelope is invalid",
      });
    } else if (
      rawResult.data.conditionId !== fixture.condition.id ||
      rawResult.data.conditionSpecHash !== fixture.condition.specHash ||
      rawResult.data.caseId !==
        authoritativeDevelopmentCase.benchmarkCase.id ||
      rawResult.data.trialId !== fixture.runConfig.trialId ||
      rawResult.data.modelInputHash !== fixture.modelInputHash ||
      rawResult.data.configHash !==
        fixture.runConfig.benchmarkConfig.configHash ||
      canonicalizeJson(rawResult.data.stagePlan) !==
        canonicalizeJson(fixture.condition.stagePlan) ||
      canonicalizeJson(rawResult.data.removedContributions) !==
        canonicalizeJson(fixture.condition.removedContributions)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts", 0, "raw", "rawOutput"],
        message: "raw condition envelope drifted from the frozen fixture",
      });
    }

    if (attempt.parsed.parseStatus !== "valid") {
      context.addIssue({
        code: "custom",
        path: ["attempts", 0, "parsed"],
        message: "workflow fixture requires one valid simulated canonical run",
      });
    } else {
      const canonicalRun = attempt.parsed.canonicalRun;
      const expectedCanonicalRun = canonicalRunFor({
        developmentCase: authoritativeDevelopmentCase,
        condition: expectedCondition,
        config: expectedBenchmarkConfig,
        runId: fixture.runConfig.runId,
      });
      if (
        canonicalizeJson(canonicalInputState(canonicalRun)) !==
          canonicalizeJson(canonicalInputState(expectedCanonicalRun)) ||
        canonicalizeJson(
          canonicalRun.executions.map(({ nodeId }) => nodeId),
        ) !== canonicalizeJson(expectedExecutionNodes(fixture.condition.id)) ||
        canonicalizeJson(executionGraphState(canonicalRun)) !==
          canonicalizeJson(executionGraphState(expectedCanonicalRun))
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts", 0, "parsed", "canonicalRun"],
          message:
            "canonical input state, execution graph, or failure provenance drifted",
        });
      }

      if (
        canonicalRun.executions.some((execution) => {
          const stage = expectedCondition.stagePlan.find(
            ({ nodeId }) => nodeId === execution.nodeId,
          );
          return (
            stage === undefined ||
            !hasCoherentDeterministicOutcome(execution) ||
            !executionModelIdentity(
              execution,
              modelForRole(stage.modelRole, expectedBenchmarkConfig),
            )
          );
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts", 0, "parsed", "canonicalRun", "executions"],
          message:
            "model identity, outcome, timing, request, retry, or fallback evidence drifted",
        });
      }

      const expectedVisibility = summarizeExecutions(
        canonicalRun.executions,
      );
      if (
        !rawResult.success ||
        canonicalizeJson(rawResult.data.executionVisibility) !==
          canonicalizeJson(expectedVisibility) ||
        attempt.raw.latencyMs !== expectedVisibility.totalLatencyMs
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "attempts",
            0,
            "raw",
            "rawOutput",
            "executionVisibility",
          ],
          message:
            "execution visibility and outer latency must derive from canonical executions",
        });
      }

      const isNoVerification = fixture.condition.id === "no_verification";
      if (
        canonicalRun.sources.some(
          ({ metadataVerification }) =>
            metadataVerification.status !==
            (isNoVerification ? "not_checked" : "match"),
        ) ||
        canonicalRun.evidenceCards.some(
          ({ deterministicVerification }) =>
            deterministicVerification.status !==
            (isNoVerification ? "not_checked" : "verified"),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts", 0, "parsed", "canonicalRun"],
          message: "verification contributions do not match the condition",
        });
      }

      const stopsAfterPlan =
        fixture.condition.id === "no_adversarial_review";
      if (
        stopsAfterPlan !==
        (canonicalRun.review === null &&
          canonicalRun.objectionDispositionDecision === null &&
          canonicalRun.revision === null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts", 0, "parsed", "canonicalRun", "review"],
          message: "review and revision fields do not match the ablation",
        });
      }
    }
  });

const WorkflowConditionFixtureInternalSchema = z.preprocess(
  (input) => {
    assertPlainData(input, "workflow fixture");
    return input;
  },
  ValidatedWorkflowConditionFixtureSchema,
) as unknown as z.ZodType<WorkflowConditionFixture>;

const authorizedFixtureCaseByIdentity = new WeakMap<object, string>();

function parseAuthorizedWorkflowFixture(
  input: unknown,
): WorkflowConditionFixture {
  const authorizedCaseHash =
    typeof input === "object" && input !== null
      ? authorizedFixtureCaseByIdentity.get(input)
      : undefined;
  if (!authorizedCaseHash) {
    throw new TypeError(
      "workflow fixture must be an accepted internally produced bundle",
    );
  }
  const fixture = WorkflowConditionFixtureInternalSchema.parse(input);
  if (fixture.developmentCase.bundleHash !== authorizedCaseHash) {
    throw new TypeError(
      "workflow fixture no longer matches its accepted case authority",
    );
  }
  return fixture;
}

export const WorkflowConditionFixtureSchema = Object.freeze({
  parse: parseAuthorizedWorkflowFixture,
  safeParse(input: unknown) {
    try {
      return {
        success: true as const,
        data: parseAuthorizedWorkflowFixture(input),
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
});

const WORKFLOW_FIXTURE_CODE_VERSION =
  "9328bb59f46633f96aea5b5e7e428af9ab0f144c";

const trialIds = ["trial-1", "trial-2", "trial-3"] as const;

function benchmarkConfigFor(input: {
  developmentCase: DevelopmentCase;
  conditionId: WorkflowConditionId;
}) {
  const caseId = input.developmentCase.benchmarkCase.id;
  return createBenchmarkConfig({
    id: `${caseId}-${input.conditionId.replaceAll("_", "-")}`,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    case: input.developmentCase.benchmarkCase,
    conditionId: input.conditionId,
    primaryModel: {
      provider: "fixture",
      modelId: "fixture-primary-v1",
      developerFamily: "fixture-primary-family",
      baseFamily: "fixture-primary-base",
    },
    adversarialReviewerModel: {
      provider: "fixture",
      modelId: "fixture-reviewer-v1",
      developerFamily: "fixture-reviewer-family",
      baseFamily: "fixture-reviewer-base",
    },
    generation: {
      maxOutputTokens: 4096,
      timeoutMs: 30_000,
      temperature: 0,
      topP: 1,
      responseFormat: "json_schema",
      seedPolicy: "unsupported",
    },
    outputContract: {
      schemaId: "workflow-condition-fixture-output",
      schemaVersion: WORKFLOW_CONDITION_VERSION,
      schemaHash: canonicalSha256({
        schema: "simulated-workflow-condition-envelope",
        version: WORKFLOW_CONDITION_VERSION,
      }),
      requiredFieldsHash: canonicalSha256({
        required: [
          "conditionId",
          "modelInputHash",
          "stagePlan",
          "executionVisibility",
        ],
      }),
      safetyConstraintsHash: canonicalSha256({
        evidenceMode: "simulated",
        reportingUse: "development",
        providerExecution: "forbidden",
        qualityClaims: "forbidden",
      }),
    },
    promptManifest: FROZEN_CONSUMER_EDGE.promptManifest.map((prompt) => ({
      ...prompt,
    })),
    benchmarkCodeVersion: WORKFLOW_FIXTURE_CODE_VERSION,
    retryPolicy: {
      maximumAttempts: 2,
      repairInvalidOutput: true,
      retryableFailureKinds: [
        "provider_transport",
        "provider_timeout",
        "invalid_structured_output",
      ],
    },
    fallbackPolicy: { mode: "forbidden", configuredModel: null },
    trialPlan: {
      count: 3,
      trialIds,
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
  });
}

function timestamp(index: number): string {
  return `2026-08-08T05:${String(30 + Math.floor(index / 60)).padStart(
    2,
    "0",
  )}:${String(index % 60).padStart(2, "0")}.000Z`;
}

function modelForRole(
  role: z.infer<typeof ModelRoleSchema>,
  config: ReturnType<typeof benchmarkConfigFor>,
) {
  if (role === "heterogeneous_reviewer")
    return config.adversarialReviewerModel;
  if (role === "deterministic_boundary")
    return {
      provider: "fixture",
      modelId: "fixture-deterministic-boundary-v1",
      developerFamily: "fixture-deterministic-family",
      baseFamily: "fixture-deterministic-base",
    };
  return config.primaryModel;
}

function execution(input: {
  runId: string;
  sequence: number;
  stage: StagePlanEntry;
  config: ReturnType<typeof benchmarkConfigFor>;
  status?: "succeeded" | "failed";
  retryOfExecutionId?: string | null;
  errorId?: string | null;
}): NodeExecution {
  const status = input.status ?? "succeeded";
  const id = `${input.runId}-${input.stage.nodeId}-${input.sequence}`;
  const model = modelForRole(input.stage.modelRole, input.config);
  const latencyMs = status === "failed" ? 7 : 11 + input.sequence;
  return {
    id,
    nodeId: input.stage.nodeId,
    attempt: input.retryOfExecutionId ? 2 : 1,
    status,
    evidenceMode: "simulated",
    inputRefs: [input.config.case.id],
    outputRefs: status === "succeeded" ? [`${id}-output`] : [],
    requestedProvider: model.provider,
    returnedProvider: status === "succeeded" ? model.provider : null,
    requestedModelId: model.modelId,
    returnedModelId: status === "succeeded" ? model.modelId : null,
    requestedDeveloperFamily: model.developerFamily,
    returnedDeveloperFamily:
      status === "succeeded" ? model.developerFamily : null,
    requestedBaseFamily: model.baseFamily,
    returnedBaseFamily: status === "succeeded" ? model.baseFamily : null,
    returnedReasoningMode:
      status === "succeeded" ? "provider_default" : null,
    promptId: input.stage.promptId,
    promptVersion: input.stage.promptVersion,
    promptHash: input.stage.promptHash,
    structuredOutputSchemaVersion: WORKFLOW_CONDITION_VERSION,
    generationSettings: {
      temperature: input.config.generation.temperature,
      maxOutputTokens: input.config.generation.maxOutputTokens,
      topP: input.config.generation.topP,
      seed: null,
      reasoningMode: "provider_default",
      reasoningBudgetTokens: null,
    },
    startedAt: timestamp(input.sequence * 2),
    endedAt: timestamp(input.sequence * 2 + 1),
    clientLatencyMs: latencyMs,
    providerTiming: {
      queueMs: null,
      promptMs: null,
      completionMs: null,
      totalMs: latencyMs,
    },
    requestIds: {
      clientRequestId: `${id}-request`,
      providerRequestId: null,
      responseId: null,
    },
    finishReason: status === "succeeded" ? "simulated_fixture_complete" : null,
    refusal: { refused: false, reason: null },
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
    pricing: {
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      estimatedCost: null,
      snapshotDate: null,
    },
    validation: {
      valid: status === "succeeded",
      issues:
        status === "failed"
          ? ["Preserved simulated reviewer transport failure."]
          : [],
    },
    errorIds: input.errorId ? [input.errorId] : [],
    retryOfExecutionId: input.retryOfExecutionId ?? null,
    fallbackFromExecutionId: null,
    codeVersion: WORKFLOW_FIXTURE_CODE_VERSION,
  };
}

function executionGraph(input: {
  runId: string;
  condition: ConditionSpec;
  config: ReturnType<typeof benchmarkConfigFor>;
}): { executions: NodeExecution[]; reviewerFailureId: string | null } {
  const executions: NodeExecution[] = [];
  let sequence = 1;
  let reviewerFailureId: string | null = null;
  for (const stage of input.condition.stagePlan) {
    if (stage.nodeId === "review-experiment") {
      const errorId = `${input.runId}-reviewer-transport-error`;
      const failed = execution({
        runId: input.runId,
        sequence: sequence++,
        stage,
        config: input.config,
        status: "failed",
        errorId,
      });
      executions.push(failed);
      executions.push(
        execution({
          runId: input.runId,
          sequence: sequence++,
          stage,
          config: input.config,
          retryOfExecutionId: failed.id,
        }),
      );
      reviewerFailureId = errorId;
      continue;
    }
    executions.push(
      execution({
        runId: input.runId,
        sequence: sequence++,
        stage,
        config: input.config,
      }),
    );
  }
  return { executions, reviewerFailureId };
}

function summarizeExecutions(
  executions: readonly NodeExecution[],
): z.infer<typeof ExecutionVisibilitySchema> {
  const modelExecutions = executions.filter(
    ({ nodeId }) => nodeId !== "collect-sources",
  );
  const usageFields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const;
  const observedUsageValues = modelExecutions.flatMap(({ usage }) =>
    usageFields.map((field) => usage[field]),
  );
  const anyUsage = observedUsageValues.some((value) => value !== null);
  const completeUsage = modelExecutions.every(({ usage }) =>
    usageFields.every((field) => usage[field] !== null),
  );
  const sumUsageField = (
    field: "inputTokens" | "outputTokens" | "totalTokens",
  ) => {
    const values = modelExecutions
      .map(({ usage }) => usage[field])
      .filter((value): value is number => value !== null);
    return values.length === 0
      ? null
      : values.reduce((total, value) => total + value, 0);
  };
  const anyPricing = modelExecutions.some(
    ({ pricing }) =>
      pricing.inputPerMillionTokens !== null ||
      pricing.outputPerMillionTokens !== null ||
      pricing.estimatedCost !== null ||
      pricing.snapshotDate !== null,
  );
  const completePricing = modelExecutions.every(
    ({ pricing }) =>
      pricing.inputPerMillionTokens !== null &&
      pricing.outputPerMillionTokens !== null &&
      pricing.estimatedCost !== null &&
      pricing.snapshotDate !== null,
  );
  const observedCosts = modelExecutions
    .map(({ pricing }) => pricing.estimatedCost)
    .filter((value): value is number => value !== null);
  return ExecutionVisibilitySchema.parse({
    totalCalls: modelExecutions.length,
    primaryCalls: modelExecutions.filter(
      ({ nodeId }) => nodeId !== "review-experiment",
    ).length,
    reviewerCalls: modelExecutions.filter(
      ({ nodeId }) => nodeId === "review-experiment",
    ).length,
    deterministicBoundaryExecutions: executions.filter(
      ({ nodeId }) => nodeId === "collect-sources",
    ).length,
    failedCalls: modelExecutions.filter(({ status }) => status === "failed")
      .length,
    totalLatencyMs: executions.reduce(
      (total, { clientLatencyMs }) => total + (clientLatencyMs ?? 0),
      0,
    ),
    tokenUsage: {
      status: !anyUsage
        ? "unavailable"
        : completeUsage
          ? "available"
          : "partial",
      inputTokens: sumUsageField("inputTokens"),
      outputTokens: sumUsageField("outputTokens"),
      totalTokens: sumUsageField("totalTokens"),
    },
    estimatedCost: {
      status: !anyPricing
        ? "unavailable"
        : completePricing
          ? "available"
          : "partial",
      currency: "USD",
      value:
        observedCosts.length === 0
          ? null
          : observedCosts.reduce((total, value) => total + value, 0),
    },
  });
}

function canonicalRunFor(input: {
  developmentCase: DevelopmentCase;
  condition: ConditionSpec;
  config: ReturnType<typeof benchmarkConfigFor>;
  runId: string;
}): ResearchRun {
  const { executions, reviewerFailureId } = executionGraph(input);
  const verified = input.condition.id !== "no_verification";
  const hasReview = input.condition.id !== "no_adversarial_review";
  const scopeDecision = {
    id: `${input.runId}-scope-decision`,
    checkpoint: "scope" as const,
    optionsShown: ["approve fixture scope", "reject fixture scope"],
    decision: "approve fixture scope",
    edits: [],
    decidedAt: timestamp(1),
    unresolvedObjections: [],
  };
  const packetFreezeDecision = {
    id: `${input.runId}-packet-freeze-decision`,
    checkpoint: "packet_freeze" as const,
    optionsShown: ["approve", "reject"],
    decision: "approve",
    edits: [],
    decidedAt: timestamp(2),
    unresolvedObjections: [],
  };
  const packet = freezePacket({
    sourceHashes: input.developmentCase.sources.map(
      ({ sourceHash }) => sourceHash,
    ),
    chunkHashes: input.developmentCase.chunks.map(
      ({ chunkHash }) => chunkHash,
    ),
    frozenAt: timestamp(3),
    freezeDecision: packetFreezeDecision,
  });
  const claims = input.developmentCase.claims.map((claim) => ({
    id: claim.id,
    statement: claim.statement,
    operationalDefinition: claim.successCriterion,
    category: "development_fixture_claim",
    parentClaimId: null,
    scopeConstraints: claim.scopeConstraints,
    disposition: "approved" as const,
    rationale: "Bounded claim from the frozen project-authored development case.",
  }));
  const sources = input.developmentCase.sources.map((source) => ({
    id: source.id,
    originalInput: source.stableIdentifier,
    canonicalDoi: null,
    canonicalUrl: null,
    doiResolution: {
      syntax: "not_provided" as const,
      resolution: "not_checked" as const,
      registrationAgency: null,
      checkedAt: null,
    },
    bibliographicMetadata: {
      title: source.title,
      authors: [source.creator],
      year: null,
      venue: null,
      studyType: "project-authored development fixture",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "user_excerpt" as const,
      provider: "fixture",
      version: input.developmentCase.benchmarkCase.version,
      location: source.stableIdentifier,
      retrievedAt: timestamp(3),
    },
    rights: {
      mayStore: "allowed" as const,
      mayDisplay: "allowed" as const,
      maySendToModel: "allowed" as const,
      basis: source.rights.basis,
      checkedAt: timestamp(3),
    },
    contentHash: source.sourceHash,
    metadataVerification: {
      status: verified ? ("match" as const) : ("not_checked" as const),
      method: verified
        ? "canonical authored-fixture manifest comparison"
        : "omitted by the no-verification ablation",
      checkedAt: verified ? timestamp(4) : null,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "Project-authored simulated development input; not an external authority or measured result.",
    ],
  }));
  const chunks = input.developmentCase.chunks.map((chunk) => ({
    id: chunk.id,
    sourceId: chunk.sourceId,
    text: chunk.text,
    location: chunk.location,
    contentHash: chunk.chunkHash,
    displayPermission: "allowed" as const,
  }));
  const assessmentNode = verified ? "assess-entailment" : "extract-evidence";
  const assessmentExecution = executions.find(
    ({ nodeId, status }) => nodeId === assessmentNode && status === "succeeded",
  )!;
  const assessmentStage = input.condition.stagePlan.find(
    ({ nodeId }) => nodeId === assessmentNode,
  )!;
  const evidenceCards = chunks.map((chunk, index) => ({
    id: `${input.developmentCase.benchmarkCase.id}-evidence-${index + 1}`,
    subclaimId: claims[0]!.id,
    sourceChunkId: chunk.id,
    excerpt: chunk.text,
    extractedResult:
      "Simulated structural extraction only; no entailment or quality result is claimed.",
    settingAndSample: "Project-authored development fixture.",
    studyType: "simulated fixture input",
    limitation: "Human grading and any provider execution remain unverified.",
    relationship: "unresolved" as const,
    deterministicVerification: {
      method: verified
        ? "literal chunk membership and content-hash check"
        : "omitted by the no-verification ablation",
      status: verified ? ("verified" as const) : ("not_checked" as const),
      checkedAt: verified ? timestamp(5) : null,
      details: verified
        ? "The excerpt is a literal member of the frozen authored fixture chunk."
        : "No deterministic metadata contribution was supplied to this condition.",
    },
    modelAssessment: {
      entailment: "unclear" as const,
      rationale: verified
        ? "Simulated verification wiring only; provider entailment and human grading remain unverified."
        : "Entailment-strength verification is intentionally absent in this ablation.",
      provider: assessmentExecution.requestedProvider,
      requestedModelId: assessmentExecution.requestedModelId,
      returnedModelId: assessmentExecution.returnedModelId,
      promptId: assessmentStage.promptId,
      promptVersion: assessmentStage.promptVersion,
      executionId: assessmentExecution.id,
    },
    conclusionStrengthWarning:
      "Do not treat simulated fixture structure as a measured conclusion.",
    humanReview: {
      status: "unreviewed" as const,
      reason: null,
      reviewedAt: null,
      reviewerId: null,
    },
    extractionIssues: [],
  }));
  const gapId = `${input.developmentCase.benchmarkCase.id}-gap`;
  const experiment = {
    selectedGapId: gapId,
    objective:
      "Evaluate the bounded development claim using a predeclared, human-reviewed fixture protocol.",
    designType: "bounded non-hazardous development simulation",
    hypothesis: claims[0]!.statement,
    nullHypothesis:
      "The predeclared bounded comparison does not meet the claim's success criterion.",
    experimentalOrObservationalUnit: "one predeclared fixture observation unit",
    unitOfAnalysis: "the predeclared fixture outcome per trial",
    interventionOrExposure: "the bounded change named in the development claim",
    comparator: "the predeclared fixture comparison condition",
    independentVariables: ["bounded comparison assignment"],
    dependentVariables: ["claim-specific predeclared outcome"],
    primaryOutcomes: [claims[0]!.operationalDefinition],
    secondaryOutcomes: ["preserved failure and latency records"],
    controls: ["fixed packet, scope, configuration, and trial identity"],
    comparisonGroups: ["bounded change", "bounded comparator"],
    measurementValidity:
      "Use only predeclared fixture fields; qualified human review is required before external use.",
    allocation: {
      randomization: "Not performed in this simulated structure.",
      blocking: "Predeclare case and trial identity.",
      blinding: "Condition labels are not used for a measured result in this fixture.",
      rationale: "This artifact validates execution structure, not experiment quality.",
    },
    replicationPlan: "Preserve all three frozen trial identities without best-of selection.",
    repeatedMeasurementPlan: "No live repeated measurement occurs in fixture mode.",
    inclusionCriteria: ["only frozen authored development-case inputs"],
    exclusionCriteria: ["any changed packet, scope, model, prompt, or configuration"],
    attritionPlan: "Retain attempted failures in the denominator.",
    missingDataPlan: "Keep missing values explicit and do not impute a success.",
    procedure: [
      "Confirm human-approved scope and packet identity.",
      "Execute only in a bounded non-live fixture environment.",
      "Preserve every attempt and request independent review before interpretation.",
    ],
    sampleSizeBasis:
      "Three protocol-defined development trials for structural verification only; no power claim.",
    missingPowerAssumptions: ["effect size", "variance", "live population"],
    estimand: "bounded fixture contrast under the predeclared success criterion",
    metrics: ["requirement coverage", "failure visibility", "latency availability"],
    analysisPlan: "Report all trials and unavailable quantities without cherry-picking.",
    assumptionChecks: ["packet equality", "config equality", "trial identity"],
    confounders: ["case-specific authored limitations and unmeasured external factors"],
    mitigations: ["bounded interpretation and qualified human review"],
    feasibility: "Feasible only as a deterministic local simulated fixture.",
    requiredResources: ["frozen authored packet", "local TypeScript runner"],
    constraints: input.developmentCase.benchmarkCase.resolvedScope.constraints,
    hazards: ["No hazardous execution is permitted."],
    ethics: ["Do not present simulated structure as real evidence or a provider result."],
    qualifiedReviewRequired: true,
    stoppingCriteria: ["configuration drift", "rights or safety gate failure"],
    failureCriteria: ["invalid artifact", "missing attempt", "unresolved drift"],
    expectedOutcomeBranches: [
      {
        outcome: "Structural fixture completes.",
        establishes: "The condition can be represented and preserved by the runner.",
        doesNotEstablish: "Any quality improvement or real-world causal effect.",
      },
    ],
    externalValidityBoundary:
      "No inference beyond the authored development fixture is permitted.",
    supportingEvidenceCardIds: evidenceCards.map(({ id }) => id),
  };
  const successfulReviewExecution = executions.find(
    ({ nodeId, status }) =>
      nodeId === "review-experiment" && status === "succeeded",
  );
  const objectionId = `${input.runId}-review-objection`;
  const review = hasReview
    ? {
        protocolVersion: WORKFLOW_CONDITION_VERSION,
        reviewerExecutionId: successfulReviewExecution!.id,
        objections: [
          {
            id: objectionId,
            category: "inferential_overreach" as const,
            severity: "high" as const,
            targetField: "externalValidityBoundary",
            rationale:
              "The simulated development fixture cannot establish provider quality or external validity.",
            evidenceCardIds: [],
          },
        ],
      }
    : null;
  const objectionDispositionDecision = hasReview
    ? {
        id: `${input.runId}-objection-decision`,
        checkpoint: "objection_dispositions" as const,
        optionsShown: ["accept", "reject", "leave unresolved"],
        decision: "accept",
        edits: [],
        decidedAt: timestamp(25),
        unresolvedObjections: [],
      }
    : null;
  const revision = hasReview
    ? {
        protocolVersion: WORKFLOW_CONDITION_VERSION,
        decisions: [
          {
            objectionId,
            disposition: "accepted" as const,
            basis: "Preserve the simulated/non-measured evidence boundary.",
            originalValue: experiment.externalValidityBoundary,
            revisedValue:
              "No inference beyond the authored development fixture or about provider quality is permitted.",
            residualRisk:
              "Human grading, live behavior, and external validity remain unverified.",
          },
        ],
      }
    : null;
  const errors = reviewerFailureId
    ? [
        {
          id: reviewerFailureId,
          kind: "provider_failure" as const,
          message:
            "Preserved simulated reviewer transport failure before a bounded retry.",
          nodeId: "review-experiment",
          executionId: executions.find(
            ({ nodeId, status }) =>
              nodeId === "review-experiment" && status === "failed",
          )!.id,
          retryable: true,
          occurredAt: timestamp(20),
          details: {
            field: null,
            providerCode: "FIXTURE_REVIEWER_TRANSPORT",
            httpStatus: null,
          },
        },
      ]
    : [];
  return ResearchRunSchema.parse({
    schemaVersion: "0.1",
    id: `${input.runId}-canonical`,
    status: "awaiting_final_approval",
    evidenceMode: "simulated",
    createdAt: timestamp(0),
    updatedAt: timestamp(30),
    intake: {
      originalQuestion: input.developmentCase.benchmarkCase.originalQuestion,
      intendedApplication: "Bounded development-fixture evaluation only.",
      populationOrGeography: "Only the authored development fixture.",
      timeHorizon: "Only the period described in the frozen case scope.",
      availableMaterialsOrBudget: "Local fixture artifacts; no paid provider calls.",
      desiredDepth: "Structural workflow and ablation verification.",
      constraints: input.developmentCase.benchmarkCase.resolvedScope.constraints,
      unansweredClarifications: [
        "Provider quality and human grading remain unverified.",
      ],
    },
    claims,
    scopeDecision,
    packet,
    sources,
    chunks,
    evidenceCards,
    conclusions: claims.map((claim) => ({
      subclaimId: claim.id,
      strength: "insufficient" as const,
      conclusion:
        "Simulated development structure only; no measured conclusion is available.",
      supportingEvidenceCardIds: [],
      contradictingEvidenceCardIds: [],
      disagreementSummary: null,
      limitations: ["No provider execution or human grading occurred."],
      changeEvidence: ["Measured provider output and blinded human grading."],
      overclaimingWarnings: ["Do not report this fixture as a quality result."],
      humanReviewStatus: "unreviewed" as const,
    })),
    researchGaps: [
      {
        id: gapId,
        affectedSubclaimIds: claims.map(({ id }) => id),
        type: "insufficient_data",
        impactRationale:
          "A simulated structural run cannot establish real evidence or model quality.",
        tractabilityRationale:
          "A later frozen measured benchmark with blinded human grading can address the gap.",
        evidenceCardIds: evidenceCards.map(({ id }) => id),
        rank: 1,
        selection: "selected",
      },
    ],
    selectedGapId: gapId,
    experiment,
    experimentAbstention: null,
    review,
    objectionDispositionDecision,
    revision,
    finalDecision: null,
    executions,
    errors,
  });
}

export function createWorkflowConditionFixture(
  developmentCaseToken: WorkflowDevelopmentCaseToken,
  conditionId: WorkflowConditionId,
  trialId: (typeof trialIds)[number],
  runIdInput?: string,
  rerunOfRunIdInput?: string | null,
): WorkflowConditionFixture {
  const developmentCase = acceptedCaseSnapshot(developmentCaseToken);
  const parsedConditionId = WorkflowConditionIdSchema.parse(conditionId);
  const parsedTrialId = z.enum(trialIds).parse(trialId);
  const parsedRunId = z.string().min(1).optional().parse(runIdInput);
  const parsedRerunOfRunId = z
    .string()
    .min(1)
    .nullable()
    .optional()
    .parse(rerunOfRunIdInput);
  const condition = conditionSpec(parsedConditionId);
  const modelInput = toDevelopmentCaseModelInput(developmentCase);
  const modelInputHash = canonicalSha256(modelInput);
  const benchmarkConfig = benchmarkConfigFor({
    developmentCase,
    conditionId: parsedConditionId,
  });
  const runId =
    parsedRunId ??
    `${developmentCase.benchmarkCase.id}-${parsedConditionId.replaceAll(
      "_",
      "-",
    )}-${parsedTrialId}`;
  const runConfig = EvalRunConfigSchema.parse({
    runnerVersion: EVAL_RUNNER_VERSION,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    runId,
    rerunOfRunId: parsedRerunOfRunId ?? null,
    createdAt: timestamp(0),
    trialId: parsedTrialId,
    benchmarkConfig,
    evidenceMode: "simulated",
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
  });
  const canonicalRun = canonicalRunFor({
    developmentCase,
    condition,
    config: benchmarkConfig,
    runId,
  });
  const executionVisibility = summarizeExecutions(canonicalRun.executions);
  const rawOutput = WorkflowFixtureRawOutputSchema.parse({
    schemaVersion: WORKFLOW_CONDITION_VERSION,
    conditionId: condition.id,
    conditionSpecHash: condition.specHash,
    caseId: developmentCase.benchmarkCase.id,
    trialId: parsedTrialId,
    modelInputHash,
    configHash: benchmarkConfig.configHash,
    stagePlan: condition.stagePlan,
    removedContributions: condition.removedContributions,
    executionVisibility,
    note:
      "Deterministic simulated structure only; no provider executed and no quality result is claimed.",
  });
  const attemptId = `${runId}-attempt`;
  const request = createRequestMetadata({
    runId,
    attemptId,
    trialId: parsedTrialId,
    evidenceMode: "simulated",
    requestedAt: timestamp(0),
    requestedProvider: benchmarkConfig.primaryModel.provider,
    requestedModelId: benchmarkConfig.primaryModel.modelId,
    providerRequestId: null,
    seed: null,
    generation: benchmarkConfig.generation,
    promptManifestHash: benchmarkConfig.promptManifestHash,
  });
  const attempts = z.array(RecordedAttemptSchema).length(1).parse([
    {
      raw: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId,
        attemptNumber: 1,
        trialId: parsedTrialId,
        evidenceMode: "simulated",
        startedAt: timestamp(0),
        completedAt: timestamp(31),
        latencyMs: executionVisibility.totalLatencyMs,
        request,
        status: "succeeded",
        rawOutput,
        failure: null,
      },
      parsed: createValidParsedAttempt({
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId,
        attemptNumber: 1,
        trialId: parsedTrialId,
        evidenceMode: "simulated",
        canonicalRun,
        validationIssues: [],
      }),
    },
  ]);
  const withoutFixtureHash: Omit<WorkflowConditionFixture, "fixtureHash"> = {
    schemaVersion: WORKFLOW_CONDITION_VERSION,
    condition,
    developmentCase,
    modelInput,
    modelInputHash,
    runConfig,
    attempts,
  };
  const fixture = WorkflowConditionFixtureInternalSchema.parse({
    ...withoutFixtureHash,
    fixtureHash: canonicalSha256(fixtureHashPayload(withoutFixtureHash)),
  });
  authorizedFixtureCaseByIdentity.set(
    fixture,
    developmentCase.bundleHash,
  );
  return fixture;
}

export function createWorkflowDevelopmentMatrix(
  caseSetToken: WorkflowDevelopmentCaseSetToken =
    WORKFLOW_DEVELOPMENT_CASE_SET,
): WorkflowConditionFixture[] {
  const acceptedCases =
    typeof caseSetToken === "object" && caseSetToken !== null
      ? acceptedCaseSetByToken.get(caseSetToken)
      : undefined;
  if (!acceptedCases) {
    throw new TypeError(
      "workflow matrix requires the accepted registry case-set token",
    );
  }
  return acceptedCases
    .flatMap((developmentCaseToken) =>
      WORKFLOW_CONDITION_IDS.flatMap((conditionId) =>
        trialIds.map((trialId) =>
          createWorkflowConditionFixture(
            developmentCaseToken,
            conditionId,
            trialId,
          ),
        ),
      ),
    )
    .sort((left, right) =>
      left.runConfig.runId.localeCompare(right.runConfig.runId),
    );
}

export async function materializeWorkflowConditionFixture(
  fixtureInput: WorkflowConditionFixture,
  artifactRoot: string,
) {
  const fixture = WorkflowConditionFixtureSchema.parse(fixtureInput);
  const parsedArtifactRoot = z.string().min(1).parse(artifactRoot);
  return materializeFixtureRun({
    artifactRoot: parsedArtifactRoot,
    config: fixture.runConfig,
    attempts: fixture.attempts,
  });
}
