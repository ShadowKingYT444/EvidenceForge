import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  PREVIOUS_CONTRACT_VERSION,
  ClaimSchema,
  EvidenceCardSchema,
  GenerationSettingsSchema,
  ExperimentReviewSchema,
  ExperimentRevisionSchema,
  DeclaredActorSchema,
  DecisionRationaleSchema,
  HumanDecisionSchema,
  NodeExecutionSchema,
  PacketFreezeSchema,
  ResearchGapSchema,
  ResearchIntakeSchema,
  ResearchRunSchema,
  RunErrorSchema,
  SourceChunkSchema,
  SourceRecordSchema,
  SubclaimConclusionSchema,
  canonicalSha256,
  canonicalizeJson,
  type NodeExecution,
  type ResearchRun,
} from "../../contracts";
import {
  GOLDEN_FIXTURE_ID_V02,
  GOLDEN_FIXTURE_SHA256_V02,
  GOLDEN_PACKET_FINGERPRINT_V02,
} from "../../fixtures/golden-run-v0.2";
import {
  EntailmentModelOutputSchema,
  EvidenceExtractionModelOutputSchema,
  ExperimentPlanningModelOutputSchema,
  ExperimentPlanningOutputSchema,
  SynthesisConclusionCandidateSchema,
  SynthesisGapCandidateSchema,
  SynthesisModelOutputSchema,
  promptRegistry,
} from "../prompts/registry";
import { createPromptRunNodeRequestBuilder } from "../prompts/render";
import {
  createFixtureAdapter,
  type StructuredGenerationAdapter,
  type StructuredGenerationRequest,
} from "../models";
import {
  InvalidExecutionAttemptError,
  InvalidTransitionError,
  MissingCheckpointError,
  NodeStartGuardError,
  advanceRun,
  appendExecutionAttempt,
  decideFinalApproval,
  persistObjectionDispositions,
  persistPacketApproval,
  persistScopeApproval,
  validateWorkflowMutation,
  type HumanDecision,
  type ObjectionDispositionPlan,
  type WorkflowNodeId,
} from "./state-machine";
import {
  DuplicateRunError,
  InMemoryWorkflowRunStore,
  RevisionConflictError,
  RunNotFoundError,
  type WorkflowRunSnapshot,
} from "./store";

const MAXIMUM_JSON_BYTES = 256 * 1024;
const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const RunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const RevisionSchema = z.string().min(1).max(128);

export const CreateRunRequestSchema = z
  .object({
    expectedRevision: z.null(),
    intake: ResearchIntakeSchema,
  })
  .strict();

export const ContinueRunRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
  })
  .strict();

const ScopeCheckpointRequestSchema = z
  .object({
    checkpoint: z.literal("scope"),
    expectedRevision: RevisionSchema,
    decision: HumanDecisionSchema,
  })
  .strict();

const PacketCheckpointRequestSchema = z
  .object({
    checkpoint: z.literal("packet_freeze"),
    expectedRevision: RevisionSchema,
    packet: PacketFreezeSchema,
  })
  .strict();

const ObjectionCheckpointRequestSchema = z
  .object({
    checkpoint: z.literal("objection_dispositions"),
    expectedRevision: RevisionSchema,
    decision: HumanDecisionSchema,
    dispositions: z.array(
      z
        .object({
          objectionId: z.string().min(1),
          disposition: z.enum(["accepted", "rejected", "unresolved"]),
          basis: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const FinalDecisionIntentSchema = z
  .object({
    choice: z.enum(["approve", "reject"]),
    declaredActor: DeclaredActorSchema,
    rationale: DecisionRationaleSchema,
  })
  .strict();

function parseFinalDecisionIntent(
  input: z.input<typeof FinalDecisionIntentSchema>,
) {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new InvalidExecutionAttemptError(
      "final decision intent must be an inert plain data object",
    );
  }
  return FinalDecisionIntentSchema.parse(structuredClone(input));
}

const FinalCheckpointRequestSchema = z
  .object({
    checkpoint: z.literal("final"),
    expectedRevision: RevisionSchema,
    decision: FinalDecisionIntentSchema,
  })
  .strict();

export const CheckpointRequestSchema = z.discriminatedUnion("checkpoint", [
  ScopeCheckpointRequestSchema,
  PacketCheckpointRequestSchema,
  ObjectionCheckpointRequestSchema,
  FinalCheckpointRequestSchema,
]);

export const RunSnapshotResponseSchema = z
  .object({
    run: ResearchRunSchema,
    revision: RevisionSchema,
  })
  .strict();

export const FixtureWorkbenchBootstrapRequestSchema = z.object({}).strict();

const PersistenceCapabilitiesSchema = z
  .object({
    scope: z.literal("process_local"),
    survivesCallsWithinProcess: z.boolean(),
    survivesProcessRestart: z.boolean(),
    diskDurable: z.boolean(),
    multiProcessSafe: z.boolean(),
  })
  .strict();

export const FixtureWorkbenchBootstrapResponseSchema = z
  .object({
    runId: RunIdSchema,
    revision: RevisionSchema,
    snapshot: ResearchRunSchema,
    disclosure: z
      .object({
        evidenceMode: z.literal("fixture"),
        sourceFixtureId: z.literal(GOLDEN_FIXTURE_ID_V02),
        sourceFixtureSha256: z.literal(GOLDEN_FIXTURE_SHA256_V02),
        packetFingerprint: z.literal(GOLDEN_PACKET_FINGERPRINT_V02),
        persistence: PersistenceCapabilitiesSchema,
        resetNotice: z.literal(
          "This isolated demo session is process-local and resets on server restart or redeploy.",
        ),
        actorAuthority: z.literal(
          "Final-decision actor labels are declared and unverified; authentication is not enabled.",
        ),
      })
      .strict(),
  })
  .strict();

const NodeFailureSchema = RunErrorSchema.pick({
  kind: true,
  nodeId: true,
  executionId: true,
  retryable: true,
  details: true,
});

export const ContinueRunResponseSchema = z.discriminatedUnion("advanced", [
  z
    .object({
      advanced: z.literal(true),
      snapshot: RunSnapshotResponseSchema,
      failure: z.null(),
    })
    .strict(),
  z
    .object({
      advanced: z.literal(false),
      snapshot: RunSnapshotResponseSchema,
      failure: NodeFailureSchema,
    })
    .strict(),
]);

const NextActionSchema = z.enum([
  "continue",
  "scope_approval",
  "packet_approval",
  "objection_dispositions",
  "final_decision",
  "complete",
  "failed",
  "blocked",
]);

const CheckpointNameSchema = z
  .enum(["scope", "packet_freeze", "objection_dispositions", "final"])
  .nullable();

export const RunProgressResponseSchema = z
  .object({
    runId: RunIdSchema,
    revision: RevisionSchema,
    status: ResearchRunSchema.shape.status,
    nextAction: NextActionSchema,
    currentNode: z.string().min(1).nullable(),
    canContinue: z.boolean(),
    checkpoint: CheckpointNameSchema,
    terminal: z.boolean(),
    executionCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    lastExecution: ResearchRunSchema.shape.executions.element.nullable(),
    persistence: z
      .object({
        scope: z.literal("process_local"),
        survivesCallsWithinProcess: z.boolean(),
        survivesProcessRestart: z.boolean(),
        diskDurable: z.boolean(),
        multiProcessSafe: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ApiProblemSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "invalid_json",
          "invalid_request",
          "invalid_run_id",
          "unsupported_media_type",
          "request_too_large",
          "run_not_found",
          "duplicate_run",
          "revision_conflict",
          "workflow_blocked",
          "workflow_conflict",
          "internal_error",
        ]),
        message: z.string().min(1),
        retryable: z.boolean(),
        runId: RunIdSchema.nullable(),
        revision: RevisionSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const ClarifyOutputSchema = z
  .object({ claims: z.array(ClaimSchema).min(1) })
  .strict()
  .superRefine(({ claims }, context) => {
    const ids = claims.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "claim IDs must be unique",
      });
    }
    const known = new Set(ids);
    for (const [index, claim] of claims.entries()) {
      if (claim.parentClaimId !== null && !known.has(claim.parentClaimId)) {
        context.addIssue({
          code: "custom",
          path: ["claims", index, "parentClaimId"],
          message: "parent claim must exist in the same output",
        });
      }
    }
  });
const SourcesOutputSchema = z
  .object({
    sources: z.array(SourceRecordSchema).min(1),
    chunks: z.array(SourceChunkSchema).min(1),
  })
  .strict()
  .superRefine(({ sources, chunks }, context) => {
    const sourceIds = sources.map(({ id }) => id);
    const chunkIds = chunks.map(({ id }) => id);
    if (
      new Set(sourceIds).size !== sourceIds.length ||
      new Set(chunkIds).size !== chunkIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "source and chunk IDs must each be unique",
      });
    }
    const knownSources = new Set(sourceIds);
    for (const [index, chunk] of chunks.entries()) {
      if (!knownSources.has(chunk.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "sourceId"],
          message: "chunk source must exist in the same output",
        });
      }
    }
  });
const EvidenceOutputSchema = z
  .object({ evidenceCards: z.array(EvidenceCardSchema).min(1) })
  .strict();
const SynthesisOutputSchema = z
  .object({
    conclusions: z.array(SubclaimConclusionSchema).min(1),
    researchGaps: z.array(ResearchGapSchema).min(1),
    selectedGapId: z.string().min(1),
  })
  .strict()
  .superRefine(({ researchGaps, selectedGapId }, context) => {
    const gapIds = researchGaps.map(({ id }) => id);
    if (
      new Set(gapIds).size !== gapIds.length ||
      !gapIds.includes(selectedGapId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedGapId"],
        message: "selected gap must uniquely identify an output gap",
      });
    }
  });
const ReviewOutputSchema = z
  .object({ review: ExperimentReviewSchema })
  .strict();
const RevisionOutputSchema = z
  .object({ revision: ExperimentRevisionSchema })
  .strict();

type NodeOutput =
  | z.output<typeof ClarifyOutputSchema>
  | z.output<typeof SourcesOutputSchema>
  | z.output<typeof EvidenceOutputSchema>
  | z.output<typeof SynthesisOutputSchema>
  | z.output<typeof ExperimentPlanningOutputSchema>
  | z.output<typeof ReviewOutputSchema>
  | z.output<typeof RevisionOutputSchema>;

type ModelNodeOutput =
  | Exclude<
      NodeOutput,
      | z.output<typeof EvidenceOutputSchema>
      | z.output<typeof SynthesisOutputSchema>
      | z.output<typeof ExperimentPlanningOutputSchema>
    >
  | z.output<typeof EvidenceExtractionModelOutputSchema>
  | z.output<typeof EntailmentModelOutputSchema>
  | z.output<typeof SynthesisModelOutputSchema>
  | z.output<typeof ExperimentPlanningModelOutputSchema>;

function sameMembers(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function synthesisModelOutputSchema(run: ResearchRun) {
  const claimIds = run.claims.map(({ id }) => id);
  if (claimIds.length === 0) {
    throw new TypeError(
      "synthesis requires at least one existing claim before provider invocation",
    );
  }
  const evidenceIds = run.evidenceCards.map(({ id }) => id);
  if (evidenceIds.length === 0) {
    throw new TypeError(
      "synthesis requires at least one existing evidence card before provider invocation",
    );
  }
  const claimIdSchema = z.enum(
    claimIds as [string, ...string[]],
  );
  const evidenceIdSchema = z.enum(
    evidenceIds as [string, ...string[]],
  );
  const knownClaims = new Set(claimIds);
  const knownEvidence = new Set(evidenceIds);
  const conclusionSchema = SynthesisConclusionCandidateSchema.extend({
    subclaimId: claimIdSchema,
  });
  const gapSchema = SynthesisGapCandidateSchema.extend({
    affectedSubclaimIds: z
      .array(claimIdSchema)
      .min(1)
      .max(claimIds.length),
    evidenceCardIds: z
      .array(evidenceIdSchema)
      .max(evidenceIds.length),
  });
  const runSchema = z
    .object({
      conclusions: z.array(conclusionSchema).length(claimIds.length),
      researchGaps: z.array(gapSchema).min(1).max(3),
      selectedGapIndex: z.number().int().min(0).max(2),
    })
    .strict();
  return runSchema.superRefine((output, context) => {
    const conclusionClaimIds = output.conclusions.map(
      ({ subclaimId }) => subclaimId,
    );
    if (!sameMembers(conclusionClaimIds, claimIds)) {
      context.addIssue({
        code: "custom",
        path: ["conclusions"],
        message:
          "synthesis output must contain exactly one conclusion for every existing claim",
      });
    }
    for (const [index, gap] of output.researchGaps.entries()) {
      if (
        !sameMembers(gap.affectedSubclaimIds, [
          ...new Set(gap.affectedSubclaimIds),
        ]) ||
        gap.affectedSubclaimIds.some((id) => !knownClaims.has(id)) ||
        !sameMembers(gap.evidenceCardIds, [
          ...new Set(gap.evidenceCardIds),
        ]) ||
        gap.evidenceCardIds.some((id) => !knownEvidence.has(id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["researchGaps", index],
          message:
            "research-gap claim/evidence references must be unique and resolve to the run",
        });
      }
    }
    if (output.selectedGapIndex >= output.researchGaps.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedGapIndex"],
        message: "selected gap index must identify an output gap",
      });
    }
  });
}

export function experimentPlanningModelOutputSchemaForRun(run: ResearchRun) {
  const selectedGap = run.researchGaps.find(
    ({ id }) => id === run.selectedGapId,
  );
  if (selectedGap === undefined) {
    throw new TypeError("experiment planning requires one exact selected gap");
  }
  const evidenceIds = selectedGap.evidenceCardIds;
  const evidenceIdSchema =
    evidenceIds.length === 0
      ? z.never()
      : z.enum(evidenceIds as [string, ...string[]]);
  const baseExperiment =
    ExperimentPlanningModelOutputSchema.shape.experiment.unwrap();
  const experiment = baseExperiment
    .extend({
      supportingEvidenceCardIds: z
        .array(evidenceIdSchema)
        .min(1)
        .max(Math.max(1, evidenceIds.length)),
    })
    .strict();
  return z
    .object({
      disposition: ExperimentPlanningModelOutputSchema.shape.disposition,
      experiment: experiment.nullable(),
      abstention: ExperimentPlanningModelOutputSchema.shape.abstention,
    })
    .strict()
    .superRefine((planning, context) => {
      const proposed =
        planning.disposition === "proposed" &&
        planning.experiment !== null &&
        planning.abstention === null;
      const abstained =
        planning.disposition === "abstained" &&
        planning.experiment === null &&
        planning.abstention !== null;
      if (!proposed && !abstained) {
        context.addIssue({
          code: "custom",
          message: "planning disposition must match exactly one semantic result",
        });
      }
      if (
        planning.experiment !== null &&
        new Set(planning.experiment.supportingEvidenceCardIds).size !==
          planning.experiment.supportingEvidenceCardIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["experiment", "supportingEvidenceCardIds"],
          message: "supporting evidence references must be unique",
        });
      }
    });
}

function nodeOutputSchema(
  run: ResearchRun,
  nodeId: WorkflowNodeId,
): z.ZodType<ModelNodeOutput> {
  switch (nodeId) {
    case "clarify-and-decompose":
      return ClarifyOutputSchema;
    case "collect-sources":
      return SourcesOutputSchema;
    case "extract-evidence":
      return EvidenceExtractionModelOutputSchema;
    case "assess-entailment":
      return EntailmentModelOutputSchema.superRefine(
        ({ entailmentDeltas }, context) => {
          const expectedIds = run.evidenceCards.map(({ id }) => id);
          const actualIds = entailmentDeltas.map(
            ({ evidenceCardId }) => evidenceCardId,
          );
          if (!sameMembers(actualIds, expectedIds)) {
            context.addIssue({
              code: "custom",
              path: ["entailmentDeltas"],
              message:
                "entailment output must contain exactly one delta for every existing evidence card",
            });
          }
        },
      );
    case "synthesize-conclusions": {
      return synthesisModelOutputSchema(run);
    }
    case "plan-experiment": {
      return experimentPlanningModelOutputSchemaForRun(run);
    }
    case "review-experiment":
      return ReviewOutputSchema.superRefine(({ review }, context) => {
        const ids = review.objections.map(({ id }) => id);
        if (new Set(ids).size !== ids.length) {
          context.addIssue({
            code: "custom",
            path: ["review", "objections"],
            message: "review objection IDs must be unique",
          });
        }
      });
    case "revise-experiment":
      return RevisionOutputSchema.superRefine(({ revision }, context) => {
        const objectionIds =
          run.review?.objections.map(({ id }) => id) ?? [];
        const decisionIds = revision.decisions.map(
          ({ objectionId }) => objectionId,
        );
        if (!sameMembers(objectionIds, decisionIds)) {
          context.addIssue({
            code: "custom",
            path: ["revision", "decisions"],
            message:
              "revision must cover every reviewed objection exactly once",
          });
        }
      });
  }
}

const statusNode = {
  draft: "clarify-and-decompose",
  decomposing: "clarify-and-decompose",
  collecting_sources: "collect-sources",
  extracting_evidence: "extract-evidence",
  verifying_evidence: "assess-entailment",
  synthesizing: "synthesize-conclusions",
  planning_experiment: "plan-experiment",
  reviewing_experiment: "review-experiment",
  revising_experiment: "revise-experiment",
} as const satisfies Partial<Record<ResearchRun["status"], WorkflowNodeId>>;

const nodeDestination = {
  "clarify-and-decompose": "awaiting_scope_approval",
  "collect-sources": "awaiting_packet_approval",
  "extract-evidence": "verifying_evidence",
  "assess-entailment": "synthesizing",
  "synthesize-conclusions": "planning_experiment",
  "plan-experiment": "reviewing_experiment",
  "review-experiment": "awaiting_objection_dispositions",
  "revise-experiment": "awaiting_final_approval",
} as const satisfies Record<WorkflowNodeId, ResearchRun["status"]>;

type RunServiceRuntime = Readonly<{
  now: () => Date;
  makeId: (prefix: string) => string;
}>;

const RunNodeRequestEnvelopeSchema = z
  .object({
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    settings: GenerationSettingsSchema,
    timeoutMs: z.number().int().positive(),
    repairInvalidOutput: z.boolean(),
    maximumAttempts: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();

export type RunNodeRequestBuilder = (input: Readonly<{
  run: ResearchRun;
  nodeId: WorkflowNodeId;
  inputRefs: readonly string[];
  objectionDispositions: ObjectionDispositionPlan | null;
}>) => z.input<typeof RunNodeRequestEnvelopeSchema>;

export type RunHistorySink = Readonly<{
  append: (input: Readonly<{
    runId: string;
    attempt: NodeExecution;
    errors: readonly z.output<typeof RunErrorSchema>[];
  }>) => Promise<void>;
}>;

const defaultRuntime: RunServiceRuntime = {
  now: () => new Date(),
  makeId: (prefix) => `${prefix}-${randomUUID()}`,
};

type RunServiceOptions = Readonly<{
  store: InMemoryWorkflowRunStore;
  primaryAdapter: StructuredGenerationAdapter;
  reviewerAdapter: StructuredGenerationAdapter;
  evidenceMode: ResearchRun["evidenceMode"];
  requestBuilder: RunNodeRequestBuilder;
  codeVersion?: string | null;
  historySink?: RunHistorySink;
  runtime?: RunServiceRuntime;
}>;

export class RunServiceBlockedError extends Error {
  readonly runId: string;
  readonly revision: string;

  constructor(runId: string, revision: string) {
    super("The run is waiting for a checkpoint or is not eligible to continue.");
    this.name = "RunServiceBlockedError";
    this.runId = runId;
    this.revision = revision;
  }
}

function snapshotResponse(
  snapshot: WorkflowRunSnapshot,
): z.output<typeof RunSnapshotResponseSchema> {
  return RunSnapshotResponseSchema.parse({
    run: snapshot.run,
    revision: snapshot.revision,
  });
}

function nextTimestamp(now: Date, after: string): string {
  const afterMs = Date.parse(after);
  const candidate = now.getTime();
  return new Date(Math.max(candidate, afterMs + 1)).toISOString();
}

function incrementTimestamp(after: string): string {
  return new Date(Date.parse(after) + 1).toISOString();
}

export function providerJsonSchema(
  input: unknown,
  preserveBounds = false,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("structured output schema must be an object");
  }
  const schema = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of [
    "$schema",
    "$ref",
    "type",
    "title",
    "description",
    "enum",
    "required",
    "additionalProperties",
    ...(preserveBounds
      ? [
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minimum",
          "maximum",
          "pattern",
        ]
      : []),
  ]) {
    if (key in schema) {
      output[key] = structuredClone(schema[key]);
    }
  }
  for (const key of ["properties", "$defs"]) {
    const value = schema[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      output[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          providerJsonSchema(child, preserveBounds),
        ]),
      );
    }
  }
  if (Array.isArray(schema.anyOf)) {
    output.anyOf = schema.anyOf.map((child) =>
      providerJsonSchema(child, preserveBounds),
    );
  }
  if ("items" in schema) {
    output.items = providerJsonSchema(schema.items, preserveBounds);
  }
  return output;
}

function assessmentFromAttempt(
  attemptInput: NodeExecution,
  entailment: z.output<
    typeof EvidenceCardSchema
  >["modelAssessment"]["entailment"],
  rationale: string,
) {
  const attempt = NodeExecutionSchema.parse(attemptInput);
  if (attempt.status !== "succeeded" || attempt.endedAt === null) {
    throw new InvalidExecutionAttemptError(
      "evidence materialization requires the actual succeeded terminal attempt",
    );
  }
  return {
    entailment,
    rationale,
    provider: attempt.requestedProvider,
    requestedModelId: attempt.requestedModelId,
    returnedModelId: attempt.returnedModelId,
    promptId: attempt.promptId,
    promptVersion: attempt.promptVersion,
    executionId: attempt.id,
  };
}

export function materializeEvidenceNodeOutput(
  run: ResearchRun,
  nodeId: "extract-evidence" | "assess-entailment",
  outputInput: unknown,
  terminalAttempt: NodeExecution,
): z.output<typeof EvidenceOutputSchema> {
  const attempt = NodeExecutionSchema.parse(terminalAttempt);
  if (attempt.nodeId !== nodeId && !attempt.nodeId.startsWith(`${nodeId}:`)) {
    throw new InvalidExecutionAttemptError(
      "evidence output and terminal attempt node disagree",
    );
  }

  if (nodeId === "assess-entailment") {
    const { entailmentDeltas } = EntailmentModelOutputSchema.parse(outputInput);
    const deltasById = new Map(
      entailmentDeltas.map((delta) => [delta.evidenceCardId, delta]),
    );
    if (
      deltasById.size !== entailmentDeltas.length ||
      !sameMembers(
        [...deltasById.keys()],
        run.evidenceCards.map(({ id }) => id),
      )
    ) {
      throw new InvalidExecutionAttemptError(
        "entailment output must contain exactly one delta per evidence card",
      );
    }
    return EvidenceOutputSchema.parse({
      evidenceCards: run.evidenceCards.map((card) => {
        const delta = deltasById.get(card.id)!;
        return EvidenceCardSchema.parse({
          ...card,
          relationship: delta.relationship,
          modelAssessment: assessmentFromAttempt(
            attempt,
            delta.entailment,
            delta.rationale,
          ),
          conclusionStrengthWarning: delta.conclusionStrengthWarning,
        });
      }),
    });
  }

  const { evidenceCandidates } =
    EvidenceExtractionModelOutputSchema.parse(outputInput);
  if (run.packet === null) {
    throw new InvalidExecutionAttemptError(
      "evidence extraction requires an approved frozen packet",
    );
  }
  const claims = new Set(run.claims.map(({ id }) => id));
  const sources = new Map(run.sources.map((source) => [source.id, source]));
  const chunks = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
  const ids = new Map<string, string>();
  const evidenceCards = evidenceCandidates.map((candidate) => {
    const chunk = chunks.get(candidate.sourceChunkId);
    const source = chunk === undefined ? undefined : sources.get(chunk.sourceId);
    if (
      !claims.has(candidate.subclaimId) ||
      chunk === undefined ||
      source === undefined ||
      !chunk.text.includes(candidate.excerpt) ||
      !run.packet!.sourceHashes.includes(source.contentHash) ||
      !run.packet!.chunkHashes.includes(chunk.contentHash) ||
      source.rights.mayStore !== "allowed" ||
      source.rights.mayDisplay !== "allowed" ||
      source.rights.maySendToModel !== "allowed" ||
      chunk.displayPermission !== "allowed"
    ) {
      throw new InvalidExecutionAttemptError(
        "evidence candidate failed claim, packet, rights, or literal-passage validation",
      );
    }
    const identityPayload = {
      subclaimId: candidate.subclaimId,
      sourceChunkId: candidate.sourceChunkId,
      excerpt: candidate.excerpt,
    };
    const identity = canonicalSha256(identityPayload);
    const canonicalIdentityPayload = canonicalizeJson(identityPayload);
    const id = `evidence-${identity}`;
    const priorIdentityPayload = ids.get(id);
    if (priorIdentityPayload !== undefined) {
      throw new InvalidExecutionAttemptError(
        priorIdentityPayload === canonicalIdentityPayload
          ? "duplicate evidence candidate"
          : "evidence identifier collision",
      );
    }
    ids.set(id, canonicalIdentityPayload);
    return EvidenceCardSchema.parse({
      ...candidate,
      id,
      relationship: "unresolved",
      deterministicVerification: {
        method: "application packet/reference/right/exact-passage validation v1",
        status: "verified",
        checkedAt: attempt.endedAt,
        details:
          "Claim, chunk, source, frozen-packet hashes, display/storage/model rights, and literal excerpt were validated.",
      },
      modelAssessment: assessmentFromAttempt(
        attempt,
        "unclear",
        "No entailment assessment has occurred; this is an extraction-only sentinel.",
      ),
      conclusionStrengthWarning: null,
      humanReview: {
        status: "unreviewed",
        reason: null,
        reviewedAt: null,
        reviewerId: null,
      },
    });
  });
  return EvidenceOutputSchema.parse({ evidenceCards });
}

export function materializeSynthesisNodeOutput(
  run: ResearchRun,
  outputInput: unknown,
  terminalAttempt: NodeExecution,
): z.output<typeof SynthesisOutputSchema> {
  const attempt = NodeExecutionSchema.parse(terminalAttempt);
  if (
    attempt.nodeId !== "synthesize-conclusions" ||
    attempt.status !== "succeeded" ||
    attempt.endedAt === null
  ) {
    throw new InvalidExecutionAttemptError(
      "synthesis materialization requires the actual succeeded terminal attempt",
    );
  }
  const output = synthesisModelOutputSchema(run).parse(outputInput);
  const evidenceByClaim = new Map<
    string,
    { supporting: string[]; contradicting: string[] }
  >();
  for (const card of run.evidenceCards) {
    const evidence = evidenceByClaim.get(card.subclaimId) ?? {
      supporting: [],
      contradicting: [],
    };
    if (card.relationship === "supports") {
      evidence.supporting.push(card.id);
    } else if (card.relationship === "contradicts") {
      evidence.contradicting.push(card.id);
    }
    evidenceByClaim.set(card.subclaimId, evidence);
  }
  const conclusions = output.conclusions.map((candidate) => {
    const evidence = evidenceByClaim.get(candidate.subclaimId) ?? {
      supporting: [],
      contradicting: [],
    };
    return SubclaimConclusionSchema.parse({
      ...candidate,
      supportingEvidenceCardIds: evidence.supporting,
      contradictingEvidenceCardIds: evidence.contradicting,
      humanReviewStatus: "unreviewed",
    });
  });
  const ids = new Map<string, string>();
  const researchGaps = output.researchGaps.map((candidate, index) => {
    const identityPayload = canonicalizeJson(candidate);
    const id = `gap-${canonicalSha256(candidate)}`;
    const priorIdentityPayload = ids.get(id);
    if (priorIdentityPayload !== undefined) {
      throw new InvalidExecutionAttemptError(
        priorIdentityPayload === identityPayload
          ? "duplicate research-gap candidate"
          : "research-gap identifier collision",
      );
    }
    ids.set(id, identityPayload);
    return ResearchGapSchema.parse({
      ...candidate,
      id,
      rank: index + 1,
      selection:
        index === output.selectedGapIndex ? "selected" : "unselected",
    });
  });
  return SynthesisOutputSchema.parse({
    conclusions,
    researchGaps,
    selectedGapId: researchGaps[output.selectedGapIndex]!.id,
  });
}

function materializeExperimentPlanningNodeOutput(
  runInput: ResearchRun,
  outputInput: unknown,
  terminalAttempt: NodeExecution,
): z.output<typeof ExperimentPlanningOutputSchema> {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  const attempt = NodeExecutionSchema.parse(terminalAttempt);
  if (
    attempt.nodeId !== "plan-experiment" ||
    attempt.status !== "succeeded" ||
    attempt.endedAt === null ||
    attempt.promptHash === undefined
  ) {
    throw new InvalidExecutionAttemptError(
      "experiment materialization requires the actual succeeded terminal attempt",
    );
  }
  const selectedGap = run.researchGaps.find(
    ({ id }) => id === run.selectedGapId,
  );
  if (selectedGap === undefined) {
    throw new InvalidExecutionAttemptError(
      "experiment materialization requires the exact selected gap",
    );
  }
  const compact = experimentPlanningModelOutputSchemaForRun(run).parse(outputInput);
  const planning =
    compact.disposition === "proposed"
      ? {
          disposition: "proposed" as const,
          experiment: {
            ...compact.experiment!,
            selectedGapId: selectedGap.id,
            qualifiedReviewRequired: true,
          },
          abstention: null,
        }
      : {
          disposition: "abstained" as const,
          experiment: null,
          abstention: {
            ...compact.abstention!,
            id: `experiment-abstention-${canonicalSha256({
              schemaVersion: "2.0.0",
              runAuthority: {
                runId: run.id,
                runSchemaVersion: run.schemaVersion,
                packetFingerprint: run.packet?.fingerprint ?? null,
                selectedGapId: selectedGap.id,
              },
              prompt: {
                id: attempt.promptId,
                version: attempt.promptVersion,
                hash: attempt.promptHash,
              },
              model: {
                requestedProvider: attempt.requestedProvider,
                returnedProvider: attempt.returnedProvider,
                requestedModelId: attempt.requestedModelId,
                returnedModelId: attempt.returnedModelId,
                requestedDeveloperFamily: attempt.requestedDeveloperFamily,
                returnedDeveloperFamily: attempt.returnedDeveloperFamily,
                requestedBaseFamily: attempt.requestedBaseFamily,
                returnedBaseFamily: attempt.returnedBaseFamily,
              },
              execution: {
                id: attempt.id,
                attempt: attempt.attempt,
                evidenceMode: attempt.evidenceMode,
                startedAt: attempt.startedAt,
                endedAt: attempt.endedAt,
                requestIds: attempt.requestIds,
                codeVersion: attempt.codeVersion,
              },
              semanticOutput: compact.abstention,
            })}`,
            qualifiedReviewRequired: true as const,
          },
        };
  const output = ExperimentPlanningOutputSchema.parse(planning);
  const ids = new Set([
    run.id,
    ...run.claims.map(({ id }) => id),
    ...run.sources.map(({ id }) => id),
    ...run.chunks.map(({ id }) => id),
    ...run.evidenceCards.map(({ id }) => id),
    ...run.researchGaps.map(({ id }) => id),
    ...run.executions.map(({ id }) => id),
    ...run.errors.map(({ id }) => id),
  ]);
  if (output.abstention !== null && ids.has(output.abstention.id)) {
    throw new InvalidExecutionAttemptError(
      "experiment abstention identifier collision",
    );
  }
  const reparsed = ResearchRunSchema.parse({
    ...run,
    experiment: output.experiment,
    experimentAbstention: output.abstention,
  });
  return ExperimentPlanningOutputSchema.parse({
    disposition: output.disposition,
    experiment: reparsed.experiment,
    abstention: reparsed.experimentAbstention ?? null,
  });
}

function assertPlanningTerminalAttemptIdentity(
  attemptInput: NodeExecution,
  request: StructuredGenerationRequest<z.ZodType>,
  adapter: StructuredGenerationAdapter,
): NodeExecution {
  const attempt = NodeExecutionSchema.parse(attemptInput);
  const identity = adapter.identity;
  const mismatches = [
    ["nodeId", attempt.nodeId, "plan-experiment"],
    ["status", attempt.status, "succeeded"],
    ["promptId", attempt.promptId, request.promptId],
    ["promptVersion", attempt.promptVersion, request.promptVersion],
    ["promptHash", attempt.promptHash, request.promptHash],
    [
      "structuredOutputSchemaVersion",
      attempt.structuredOutputSchemaVersion,
      request.schemaVersion,
    ],
    [
      "inputRefs",
      canonicalizeJson(attempt.inputRefs),
      canonicalizeJson(request.inputRefs),
    ],
    ["codeVersion", attempt.codeVersion, request.codeVersion],
    ["requestedProvider", attempt.requestedProvider, identity.provider],
    ["returnedProvider", attempt.returnedProvider, identity.provider],
    ["requestedModelId", attempt.requestedModelId, identity.modelId],
    ["returnedModelId", attempt.returnedModelId, identity.modelId],
    [
      "requestedDeveloperFamily",
      attempt.requestedDeveloperFamily,
      identity.developerFamily,
    ],
    [
      "returnedDeveloperFamily",
      attempt.returnedDeveloperFamily,
      identity.developerFamily,
    ],
    ["requestedBaseFamily", attempt.requestedBaseFamily, identity.baseFamily],
    ["returnedBaseFamily", attempt.returnedBaseFamily, identity.baseFamily],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    throw new InvalidExecutionAttemptError(
      `planning terminal attempt identity does not match the service request and adapter (${mismatches.map(([field]) => field).join(", ")})`,
    );
  }
  return attempt;
}

function applyNodeOutput(
  run: ResearchRun,
  nodeId: WorkflowNodeId,
  outputInput: NodeOutput,
): ResearchRun {
  switch (nodeId) {
    case "clarify-and-decompose": {
      const output = ClarifyOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({ ...run, claims: output.claims });
    }
    case "collect-sources": {
      const output = SourcesOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({
        ...run,
        sources: output.sources,
        chunks: output.chunks,
      });
    }
    case "extract-evidence":
    case "assess-entailment": {
      const output = EvidenceOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({
        ...run,
        evidenceCards: output.evidenceCards,
      });
    }
    case "synthesize-conclusions": {
      const output = SynthesisOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({
        ...run,
        conclusions: output.conclusions,
        researchGaps: output.researchGaps,
        selectedGapId: output.selectedGapId,
      });
    }
    case "plan-experiment": {
      const output = ExperimentPlanningOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({
        ...run,
        experiment: output.experiment,
        experimentAbstention: output.abstention,
      });
    }
    case "review-experiment": {
      const output = ReviewOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({ ...run, review: output.review });
    }
    case "revise-experiment": {
      const output = RevisionOutputSchema.parse(outputInput);
      return ResearchRunSchema.parse({
        ...run,
        revision: output.revision,
      });
    }
  }
}

function completedOutput(run: ResearchRun, nodeId: WorkflowNodeId): boolean {
  if (nodeId === "extract-evidence" || nodeId === "assess-entailment") {
    return EvidenceOutputSchema.safeParse(nodeOutputFromRun(run, nodeId)).success;
  }
  if (nodeId === "synthesize-conclusions") {
    return SynthesisOutputSchema.safeParse(
      nodeOutputFromRun(run, nodeId),
    ).success;
  }
  if (nodeId === "plan-experiment") {
    return ExperimentPlanningOutputSchema.safeParse(
      nodeOutputFromRun(run, nodeId),
    ).success;
  }
  return nodeOutputSchema(run, nodeId).safeParse(
    nodeOutputFromRun(run, nodeId),
  ).success;
}

function nodeOutputFromRun(
  run: ResearchRun,
  nodeId: WorkflowNodeId,
): NodeOutput {
  switch (nodeId) {
    case "clarify-and-decompose":
      return { claims: run.claims };
    case "collect-sources":
      return { sources: run.sources, chunks: run.chunks };
    case "extract-evidence":
    case "assess-entailment":
      return { evidenceCards: run.evidenceCards };
    case "synthesize-conclusions":
      return {
        conclusions: run.conclusions,
        researchGaps: run.researchGaps,
        selectedGapId: run.selectedGapId ?? "",
      };
    case "plan-experiment":
      return run.experimentAbstention !== null &&
        run.experimentAbstention !== undefined
        ? {
            disposition: "abstained",
            experiment: null,
            abstention: run.experimentAbstention,
          }
        : {
            disposition: "proposed",
            experiment: run.experiment!,
            abstention: null,
          };
    case "review-experiment":
      return { review: run.review! };
    case "revise-experiment":
      return { revision: run.revision! };
  }
}

function nodeInputRefs(
  run: ResearchRun,
  nodeId: WorkflowNodeId,
): string[] {
  switch (nodeId) {
    case "clarify-and-decompose":
      return [`intake:${run.id}`];
    case "collect-sources":
      return [
        ...run.claims.map(({ id }) => id),
        ...(run.scopeDecision === null ? [] : [run.scopeDecision.id]),
      ];
    case "extract-evidence":
      return [
        ...(run.packet === null ? [] : [run.packet.fingerprint]),
        ...run.sources.map(({ id }) => id),
        ...run.chunks.map(({ id }) => id),
      ];
    case "assess-entailment":
      return run.evidenceCards.map(({ id }) => id);
    case "synthesize-conclusions":
      return run.evidenceCards.map(({ id }) => id);
    case "plan-experiment":
      return [
        ...run.researchGaps.map(({ id }) => id),
        ...run.evidenceCards.map(({ id }) => id),
      ];
    case "review-experiment":
      return run.experiment === null
        ? []
        : [`experiment:${run.experiment.selectedGapId}`];
    case "revise-experiment":
      return [
        ...(run.review?.objections.map(({ id }) => id) ?? []),
        ...(run.objectionDispositionDecision === null
          ? []
          : [run.objectionDispositionDecision.id]),
      ];
  }
}

function nodeOutputRefs(
  nodeId: WorkflowNodeId,
  outputInput: NodeOutput,
): string[] {
  switch (nodeId) {
    case "clarify-and-decompose":
      return ClarifyOutputSchema.parse(outputInput).claims.map(
        ({ id }) => id,
      );
    case "collect-sources": {
      const output = SourcesOutputSchema.parse(outputInput);
      return [
        ...output.sources.map(({ id }) => id),
        ...output.chunks.map(({ id }) => id),
      ];
    }
    case "extract-evidence":
    case "assess-entailment":
      return EvidenceOutputSchema.parse(outputInput).evidenceCards.map(
        ({ id }) => id,
      );
    case "synthesize-conclusions": {
      const output = SynthesisOutputSchema.parse(outputInput);
      return [
        ...output.conclusions.map(({ subclaimId }) => subclaimId),
        ...output.researchGaps.map(({ id }) => id),
      ];
    }
    case "plan-experiment": {
      const planning = ExperimentPlanningOutputSchema.parse(outputInput);
      return planning.disposition === "proposed"
        ? [
            `experiment:${
              planning.experiment?.selectedGapId ?? "missing-experiment"
            }`,
          ]
        : [`abstention:${planning.abstention?.id ?? "missing-abstention"}`];
    }
    case "review-experiment":
      return ReviewOutputSchema.parse(outputInput).review.objections.map(
        ({ id }) => id,
      );
    case "revise-experiment":
      return RevisionOutputSchema.parse(outputInput).revision.decisions.map(
        ({ objectionId }) => objectionId,
      );
  }
}

function nextAction(run: ResearchRun): {
  nextAction: z.output<typeof NextActionSchema>;
  currentNode: WorkflowNodeId | null;
  canContinue: boolean;
  checkpoint: z.output<typeof CheckpointNameSchema>;
  terminal: boolean;
} {
  const node = statusNode[run.status as keyof typeof statusNode] ?? null;
  if (node !== null) {
    const prior = run.executions
      .filter((execution) => execution.nodeId === node)
      .at(-1);
    const nonRetryableFailure =
      prior !== undefined &&
      prior.status !== "succeeded" &&
      prior.errorIds
        .map((id) => run.errors.find((error) => error.id === id))
        .some((error) => error === undefined || !error.retryable);
    return {
      nextAction: nonRetryableFailure ? "blocked" : "continue",
      currentNode: node,
      canContinue: !nonRetryableFailure,
      checkpoint: null,
      terminal: false,
    };
  }
  const checkpoints = {
    awaiting_scope_approval: "scope",
    awaiting_packet_approval: "packet_freeze",
    awaiting_objection_dispositions: "objection_dispositions",
    awaiting_final_approval: "final",
  } as const;
  const checkpoint =
    checkpoints[run.status as keyof typeof checkpoints] ?? null;
  if (checkpoint !== null) {
    return {
      nextAction:
        checkpoint === "scope"
          ? "scope_approval"
          : checkpoint === "packet_freeze"
            ? "packet_approval"
            : checkpoint === "objection_dispositions"
              ? "objection_dispositions"
              : "final_decision",
      currentNode: null,
      canContinue: false,
      checkpoint,
      terminal: false,
    };
  }
  return {
    nextAction: run.status === "failed" ? "failed" : "complete",
    currentNode: null,
    canContinue: false,
    checkpoint: null,
    terminal: true,
  };
}

function safeNodeFailure(error: z.output<typeof RunErrorSchema>) {
  return NodeFailureSchema.parse({
    kind: error.kind,
    nodeId: error.nodeId,
    executionId: error.executionId,
    retryable: error.retryable,
    details: error.details,
  });
}

export class RunService {
  readonly #store: InMemoryWorkflowRunStore;
  readonly #primaryAdapter: StructuredGenerationAdapter;
  readonly #reviewerAdapter: StructuredGenerationAdapter;
  readonly #evidenceMode: ResearchRun["evidenceMode"];
  readonly #requestBuilder: RunNodeRequestBuilder;
  readonly #codeVersion: string | null;
  readonly #historySink: RunHistorySink | null;
  readonly #runtime: RunServiceRuntime;
  readonly #inFlightRuns = new Set<string>();

  constructor(options: RunServiceOptions) {
    this.#store = options.store;
    this.#primaryAdapter = options.primaryAdapter;
    this.#reviewerAdapter = options.reviewerAdapter;
    this.#evidenceMode = options.evidenceMode;
    this.#requestBuilder = options.requestBuilder;
    this.#codeVersion = options.codeVersion ?? null;
    this.#historySink = options.historySink ?? null;
    this.#runtime = options.runtime ?? defaultRuntime;
  }

  create(input: { intake: z.input<typeof ResearchIntakeSchema> }) {
    const intake = ResearchIntakeSchema.parse(input.intake);
    const timestamp = this.#runtime.now().toISOString();
    const run = ResearchRunSchema.parse({
      schemaVersion: PREVIOUS_CONTRACT_VERSION,
      id: RunIdSchema.parse(this.#runtime.makeId("run")),
      status: "draft",
      evidenceMode: this.#evidenceMode,
      createdAt: timestamp,
      updatedAt: timestamp,
      intake,
      claims: [],
      scopeDecision: null,
      packet: null,
      sources: [],
      chunks: [],
      evidenceCards: [],
      conclusions: [],
      researchGaps: [],
      selectedGapId: null,
      experiment: null,
      experimentAbstention: null,
      review: null,
      objectionDispositionDecision: null,
      revision: null,
      finalDecision: null,
      executions: [],
      errors: [],
    });
    return snapshotResponse(this.#store.create(run));
  }

  bootstrapFixtureWorkbench() {
    if (this.#evidenceMode !== "fixture") {
      throw new InvalidExecutionAttemptError(
        "fixture workbench bootstrap is available only in fixture mode",
      );
    }
    const createdAt = this.#runtime.now().toISOString();
    const runId = RunIdSchema.parse(this.#runtime.makeId("fixture-workbench"));
    const snapshot = this.#store.createFixtureWorkbenchSession(runId, createdAt);
    return FixtureWorkbenchBootstrapResponseSchema.parse({
      runId: snapshot.run.id,
      revision: snapshot.revision,
      snapshot: snapshot.run,
      disclosure: {
        evidenceMode: "fixture",
        sourceFixtureId: GOLDEN_FIXTURE_ID_V02,
        sourceFixtureSha256: GOLDEN_FIXTURE_SHA256_V02,
        packetFingerprint: GOLDEN_PACKET_FINGERPRINT_V02,
        persistence: this.#store.capabilities,
        resetNotice:
          "This isolated demo session is process-local and resets on server restart or redeploy.",
        actorAuthority:
          "Final-decision actor labels are declared and unverified; authentication is not enabled.",
      },
    });
  }

  bootstrapApprovedGoldenInvocation() {
    if (this.#evidenceMode !== "live" && this.#evidenceMode !== "mocked") {
      throw new InvalidExecutionAttemptError(
        "approved golden invocation bootstrap is available only in live or mocked mode",
      );
    }
    const createdAt = this.#runtime.now().toISOString();
    const runId = RunIdSchema.parse(this.#runtime.makeId("live-golden"));
    return snapshotResponse(
      this.#store.createApprovedGoldenInvocationSession(
        runId,
        createdAt,
        this.#evidenceMode,
      ),
    );
  }

  get(runIdInput: string) {
    const runId = RunIdSchema.parse(runIdInput);
    const snapshot = this.#store.load(runId);
    if (snapshot === null) {
      throw new RunNotFoundError(runId);
    }
    return snapshotResponse(snapshot);
  }

  progress(runIdInput: string) {
    const snapshot = this.#load(runIdInput);
    return RunProgressResponseSchema.parse({
      runId: snapshot.run.id,
      revision: snapshot.revision,
      status: snapshot.run.status,
      ...nextAction(snapshot.run),
      executionCount: snapshot.run.executions.length,
      errorCount: snapshot.run.errors.length,
      lastExecution: snapshot.run.executions.at(-1) ?? null,
      persistence: this.#store.capabilities,
    });
  }

  async continue(input: {
    runId: string;
    expectedRevision: string;
  }): Promise<z.output<typeof ContinueRunResponseSchema>> {
    let snapshot = this.#loadForMutation(
      input.runId,
      input.expectedRevision,
    );
    let nodeId =
      statusNode[snapshot.run.status as keyof typeof statusNode] ?? null;
    if (nodeId === null) {
      throw new RunServiceBlockedError(
        snapshot.run.id,
        snapshot.revision,
      );
    }

    const startsDraft = snapshot.run.status === "draft";
    const executionRun = startsDraft
      ? advanceRun(
          snapshot.run,
          "decomposing",
          incrementTimestamp(snapshot.run.updatedAt),
        )
      : snapshot.run;
    if (startsDraft) {
      nodeId = "clarify-and-decompose";
    }

    if (nodeId === "plan-experiment") {
      const selectedGap = executionRun.researchGaps.find(({ id }) => id === executionRun.selectedGapId);
      if (selectedGap && selectedGap.evidenceCardIds.length === 0) {
        const candidate = ResearchRunSchema.parse({
          ...snapshot.run,
          experiment: null,
          experimentAbstention: {
            id: `experiment-abstention-${canonicalSha256({ runId: snapshot.run.id, gapId: selectedGap.id, reason: "missing-required-evidence" })}`,
            reason: "The selected research gap has no verified evidence cards from which to design a responsible experiment.",
            safetyCategories: ["missing_required_evidence"],
            qualifiedReviewRequired: true,
            missingInputs: ["At least one verified evidence card linked to the selected gap"],
            allowedNextStep: "Add or authorize evidence for this gap, then recompile the research branch.",
          },
        });
        const advanced = advanceRun(
          candidate,
          "awaiting_final_approval",
          incrementTimestamp(candidate.updatedAt),
          snapshot.objectionDispositions,
        );
        snapshot = this.#store.save(
          advanced,
          snapshot.revision,
          snapshot.objectionDispositions,
        );
        return ContinueRunResponseSchema.parse({
          advanced: true,
          snapshot: snapshotResponse(snapshot),
          failure: null,
        });
      }
    }

    const prior = executionRun.executions
      .filter((execution) => execution.nodeId === nodeId)
      .at(-1);
    if (prior?.status === "succeeded") {
      if (!completedOutput(executionRun, nodeId)) {
        throw new InvalidExecutionAttemptError(
          "successful attempt is missing its typed node output",
        );
      }
      snapshot = this.#advanceCompletedNode(snapshot, nodeId);
      return ContinueRunResponseSchema.parse({
        advanced: true,
        snapshot: snapshotResponse(snapshot),
        failure: null,
      });
    }
    if (
      prior !== undefined &&
      prior.errorIds
        .map((id) => snapshot.run.errors.find((error) => error.id === id))
        .some((error) => error === undefined || !error.retryable)
    ) {
      throw new RunServiceBlockedError(
        snapshot.run.id,
        snapshot.revision,
      );
    }

    if (
      promptRegistry.forNode(nodeId).providerCapabilities
        .requiresDifferentBaseFamily &&
      this.#primaryAdapter.identity.baseFamily ===
        this.#reviewerAdapter.identity.baseFamily
    ) {
      throw new RunServiceBlockedError(
        snapshot.run.id,
        snapshot.revision,
      );
    }
    const adapter =
      nodeId === "review-experiment"
        ? this.#reviewerAdapter
        : this.#primaryAdapter;
    const schema = nodeOutputSchema(executionRun, nodeId);
    const priorCount = executionRun.executions.filter(
      (execution) => execution.nodeId === nodeId,
    ).length;
    const inputRefs = nodeInputRefs(executionRun, nodeId);
    let envelope: z.output<typeof RunNodeRequestEnvelopeSchema>;
    try {
      envelope = RunNodeRequestEnvelopeSchema.parse(
        this.#requestBuilder({
          run: ResearchRunSchema.parse(structuredClone(executionRun)),
          nodeId,
          inputRefs,
          objectionDispositions: snapshot.objectionDispositions,
        }),
      );
    } catch (error) {
      if (!process.env.RENDER) {
        console.error("EvidenceForge prompt materialization failed", error);
      }
      throw new RunServiceBlockedError(
        snapshot.run.id,
        snapshot.revision,
      );
    }
    const request: StructuredGenerationRequest<typeof schema> = {
      nodeId,
      inputRefs,
      outputRefs: [],
      promptId: envelope.promptId,
      promptVersion: envelope.promptVersion,
      promptHash: envelope.promptHash,
      schemaVersion: PREVIOUS_CONTRACT_VERSION,
      schemaName: `${nodeId}-output`,
      outputSchema: schema,
      outputJsonSchema: providerJsonSchema(
        z.toJSONSchema(schema),
        (nodeId === "synthesize-conclusions" || nodeId === "plan-experiment") &&
          adapter.identity.provider !== "groq",
      ),
      messages: envelope.messages,
      settings: envelope.settings,
      timeoutMs: envelope.timeoutMs,
      measured: false,
      repairInvalidOutput: envelope.repairInvalidOutput,
      maximumAttempts: envelope.maximumAttempts,
      codeVersion: this.#codeVersion,
      fixtureKey: `${snapshot.run.id}:${nodeId}:${priorCount + 1}`,
    };
    if (this.#inFlightRuns.has(snapshot.run.id)) {
      throw new RevisionConflictError(snapshot.run.id);
    }
    this.#inFlightRuns.add(snapshot.run.id);
    try {
      let generated = await adapter.generate(request);
      const terminalError = generated.ok ? undefined : generated.errors.at(-1);
      const exhaustedStructuredOutput =
        terminalError?.kind === "invalid_model_json" ||
        terminalError?.kind === "invalid_model_output";
      const fallbackEligible =
        (nodeId === "assess-entailment" || nodeId === "synthesize-conclusions") &&
        adapter.identity.baseFamily !== this.#reviewerAdapter.identity.baseFamily &&
        generated.ok === false &&
        (terminalError?.retryable === true ||
          terminalError?.details.providerCode === "rate_limit_exceeded" ||
          exhaustedStructuredOutput);
      if (fallbackEligible) {
        const preservedPrimaryErrors = generated.errors.map((error) =>
          error.details.providerCode === "rate_limit_exceeded" ||
          error.kind === "invalid_model_json" ||
          error.kind === "invalid_model_output"
            ? { ...error, retryable: true }
            : error,
        );
        const fallback = await this.#reviewerAdapter.generate({
          ...request,
          outputJsonSchema: providerJsonSchema(
            z.toJSONSchema(schema),
            nodeId === "synthesize-conclusions" &&
              this.#reviewerAdapter.identity.provider !== "groq",
          ),
          fixtureKey: `${request.fixtureKey ?? `${snapshot.run.id}:${nodeId}`}:fallback`,
        });
        generated = {
          ...fallback,
          attempts: [...generated.attempts, ...fallback.attempts],
          errors: [...preservedPrimaryErrors, ...fallback.errors],
        };
      }
      if (generated.attempts.length === 0) {
        throw new InvalidExecutionAttemptError(
          "node adapter returned no terminal attempt",
        );
      }
      if (generated.ok) {
        const parsedOutput = schema.safeParse(generated.value);
        if (!parsedOutput.success) {
          throw new InvalidExecutionAttemptError(
            "node adapter returned an invalid successful output",
          );
        }
        generated = {
          ...generated,
          value: parsedOutput.data,
        };
      }
    const returnedAttemptIds = generated.attempts.map(({ id }) => id);
    const returnedErrorIds = generated.errors.map(({ id }) => id);
    if (
      new Set(returnedAttemptIds).size !== returnedAttemptIds.length ||
      new Set(returnedErrorIds).size !== returnedErrorIds.length ||
      returnedAttemptIds.some((id) =>
        snapshot.run.executions.some((execution) => execution.id === id),
      ) ||
      returnedErrorIds.some((id) =>
        snapshot.run.errors.some((error) => error.id === id),
      )
    ) {
      throw new InvalidExecutionAttemptError(
        "node adapter returned duplicate history identifiers",
      );
    }
    const returnedAttemptIdSet = new Set(returnedAttemptIds);
    if (
      generated.attempts.some(
        (attempt, index) =>
          attempt.nodeId !== nodeId ||
          attempt.evidenceMode !== executionRun.evidenceMode ||
          attempt.status === "started" ||
          (index < generated.attempts.length - 1 &&
            attempt.status === "succeeded"),
      ) ||
      generated.errors.some(
        (error) =>
          error.executionId === null ||
          !returnedAttemptIdSet.has(error.executionId),
      )
    ) {
      throw new InvalidExecutionAttemptError(
        "node adapter returned an incoherent attempt chain",
      );
    }
    const finalAttempt = generated.attempts.at(-1)!;
    if (
      (generated.ok && finalAttempt.status !== "succeeded") ||
      (!generated.ok && finalAttempt.status === "succeeded")
    ) {
      throw new InvalidExecutionAttemptError(
        "node adapter result disagrees with its terminal attempt",
      );
    }

    const materializedOutput: NodeOutput | null = generated.ok
      ? nodeId === "extract-evidence" || nodeId === "assess-entailment"
        ? materializeEvidenceNodeOutput(
            executionRun,
            nodeId,
            generated.value,
            NodeExecutionSchema.parse(finalAttempt),
          )
        : nodeId === "synthesize-conclusions"
          ? materializeSynthesisNodeOutput(
              executionRun,
              generated.value,
              NodeExecutionSchema.parse(finalAttempt),
            )
          : nodeId === "plan-experiment"
            ? materializeExperimentPlanningNodeOutput(
                executionRun,
                generated.value,
                assertPlanningTerminalAttemptIdentity(
                  finalAttempt,
                  request,
                  adapter,
                ),
              )
        : (generated.value as NodeOutput)
      : null;

    const normalizedAttempts: NodeExecution[] = [];
    let previous = prior;
    for (const [index, rawAttempt] of generated.attempts.entries()) {
      const normalized = NodeExecutionSchema.parse({
        ...rawAttempt,
        attempt: priorCount + index + 1,
        retryOfExecutionId: previous?.id ?? null,
        outputRefs:
          index === generated.attempts.length - 1 && generated.ok
            ? nodeOutputRefs(nodeId, materializedOutput!)
            : [],
      });
      normalizedAttempts.push(normalized);
      previous = normalized;
    }

    let preflightRun = executionRun;
    for (const [index, attempt] of normalizedAttempts.entries()) {
      const errors = generated.errors.filter(
        (error) => error.executionId === attempt.id,
      );
      let candidate = appendExecutionAttempt(
        preflightRun,
        attempt,
        errors,
        incrementTimestamp(preflightRun.updatedAt),
        snapshot.objectionDispositions,
      );
      const isLast = index === normalizedAttempts.length - 1;
      if (isLast && generated.ok) {
        candidate = applyNodeOutput(candidate, nodeId, materializedOutput!);
      }
      validateWorkflowMutation(
        preflightRun,
        candidate,
        snapshot.objectionDispositions,
      );
      preflightRun = candidate;
    }
    if (generated.ok) {
      const destination =
        nodeId === "plan-experiment" &&
        ExperimentPlanningOutputSchema.parse(materializedOutput).disposition ===
          "abstained"
          ? "awaiting_final_approval"
          : nodeDestination[nodeId];
      const advanced = advanceRun(
        preflightRun,
        destination,
        incrementTimestamp(preflightRun.updatedAt),
        snapshot.objectionDispositions,
      );
      validateWorkflowMutation(
        preflightRun,
        advanced,
        snapshot.objectionDispositions,
      );
    }

    if (startsDraft) {
      const started = advanceRun(
        snapshot.run,
        "decomposing",
        this.#updatedAt(snapshot.run),
      );
      snapshot = this.#store.save(started, snapshot.revision);
    }

    for (const [index, attempt] of normalizedAttempts.entries()) {
      const errors = generated.errors.filter(
        (error) => error.executionId === attempt.id,
      );
      let candidate = appendExecutionAttempt(
        snapshot.run,
        attempt,
        errors,
        this.#updatedAt(snapshot.run),
        snapshot.objectionDispositions,
      );
      if (index === normalizedAttempts.length - 1 && generated.ok) {
        candidate = applyNodeOutput(candidate, nodeId, materializedOutput!);
      }
      snapshot = this.#store.save(
        candidate,
        snapshot.revision,
        snapshot.objectionDispositions,
      );
      await this.#historySink?.append({
        runId: snapshot.run.id,
        attempt,
        errors,
      });
    }

    if (!generated.ok) {
      const failure = generated.errors.at(-1);
      if (failure === undefined) {
        throw new InvalidExecutionAttemptError(
          "failed adapter result must include a linked error",
        );
      }
      return ContinueRunResponseSchema.parse({
        advanced: false,
        snapshot: snapshotResponse(snapshot),
        failure: safeNodeFailure(failure),
      });
    }

    snapshot = this.#advanceCompletedNode(snapshot, nodeId);
    return ContinueRunResponseSchema.parse({
      advanced: true,
      snapshot: snapshotResponse(snapshot),
      failure: null,
    });
    } finally {
      this.#inFlightRuns.delete(snapshot.run.id);
    }
  }

  approveScope(input: {
    runId: string;
    expectedRevision: string;
    decision: HumanDecision;
  }) {
    const snapshot = this.#loadForMutation(
      input.runId,
      input.expectedRevision,
    );
    const candidate = persistScopeApproval(
      snapshot.run,
      input.decision,
      this.#updatedAt(snapshot.run),
    );
    return snapshotResponse(
      this.#store.save(candidate, snapshot.revision),
    );
  }

  approvePacket(input: {
    runId: string;
    expectedRevision: string;
    packet: z.input<typeof PacketFreezeSchema>;
  }) {
    const snapshot = this.#loadForMutation(
      input.runId,
      input.expectedRevision,
    );
    const candidate = persistPacketApproval(
      snapshot.run,
      PacketFreezeSchema.parse(input.packet),
      this.#updatedAt(snapshot.run),
    );
    return snapshotResponse(
      this.#store.save(candidate, snapshot.revision),
    );
  }

  submitObjections(input: {
    runId: string;
    expectedRevision: string;
    decision: HumanDecision;
    dispositions: ObjectionDispositionPlan;
  }) {
    const snapshot = this.#loadForMutation(
      input.runId,
      input.expectedRevision,
    );
    const persisted = persistObjectionDispositions(
      snapshot.run,
      input.decision,
      input.dispositions,
      this.#updatedAt(snapshot.run),
    );
    return snapshotResponse(
      this.#store.save(
        persisted.run,
        snapshot.revision,
        persisted.objectionDispositions,
      ),
    );
  }

  decideFinal(input: {
    runId: string;
    expectedRevision: string;
    decision: z.input<typeof FinalDecisionIntentSchema>;
  }) {
    const snapshot = this.#loadForMutation(
      input.runId,
      input.expectedRevision,
    );
    const intent = parseFinalDecisionIntent(input.decision);
    const decidedAt = this.#updatedAt(snapshot.run);
    const unresolvedObjections = (snapshot.run.revision?.decisions ?? [])
      .filter(({ disposition }) => disposition === "unresolved")
      .map(({ objectionId }) => objectionId)
      .sort();
    const decision = HumanDecisionSchema.parse({
      id: this.#runtime.makeId("final-decision"),
      checkpoint: "final",
      optionsShown: ["approve", "reject"],
      decision: intent.choice,
      edits: [],
      decidedAt,
      unresolvedObjections,
      declaredActor: intent.declaredActor,
      rationale: intent.rationale,
    });
    const candidate = decideFinalApproval(snapshot.run, decision, decidedAt);
    return snapshotResponse(
      this.#store.save(
        candidate,
        snapshot.revision,
        snapshot.objectionDispositions,
      ),
    );
  }

  export(runIdInput: string): string {
    const snapshot = this.#load(runIdInput);
    if (
      snapshot.run.status !== "approved" &&
      snapshot.run.status !== "rejected"
    ) {
      throw new RunServiceBlockedError(
        snapshot.run.id,
        snapshot.revision,
      );
    }
    const run = ResearchRunSchema.parse(snapshot.run);
    const canonical = canonicalizeJson(run);
    ResearchRunSchema.parse(JSON.parse(canonical));
    return canonical;
  }

  #load(runIdInput: string): WorkflowRunSnapshot {
    const runId = RunIdSchema.parse(runIdInput);
    const snapshot = this.#store.load(runId);
    if (snapshot === null) {
      throw new RunNotFoundError(runId);
    }
    return snapshot;
  }

  #loadForMutation(
    runIdInput: string,
    expectedRevisionInput: string,
  ): WorkflowRunSnapshot {
    const snapshot = this.#load(runIdInput);
    const expectedRevision = RevisionSchema.parse(expectedRevisionInput);
    if (snapshot.revision !== expectedRevision) {
      throw new RevisionConflictError(snapshot.run.id);
    }
    return snapshot;
  }

  #updatedAt(run: ResearchRun): string {
    return nextTimestamp(this.#runtime.now(), run.updatedAt);
  }

  #advanceCompletedNode(
    snapshot: WorkflowRunSnapshot,
    nodeId: WorkflowNodeId,
  ): WorkflowRunSnapshot {
    const destination =
      nodeId === "plan-experiment" &&
      snapshot.run.experimentAbstention !== null &&
      snapshot.run.experimentAbstention !== undefined
        ? "awaiting_final_approval"
        : nodeDestination[nodeId];
    const candidate = advanceRun(
      snapshot.run,
      destination,
      this.#updatedAt(snapshot.run),
      snapshot.objectionDispositions,
    );
    return this.#store.save(
      candidate,
      snapshot.revision,
      snapshot.objectionDispositions,
    );
  }
}

function publicProblem(
  code: z.output<typeof ApiProblemSchema>["error"]["code"],
  status: number,
  message: string,
  context?: { runId?: string; revision?: string },
): Response {
  const body = ApiProblemSchema.parse({
    error: {
      code,
      message,
      retryable: code === "revision_conflict",
      runId: context?.runId ?? null,
      revision: context?.revision ?? null,
    },
  });
  return Response.json(body, {
    status,
    headers: { "cache-control": PRIVATE_NO_STORE },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return publicProblem(
      "invalid_request",
      422,
      "The request does not match the required schema.",
    );
  }
  if (error instanceof RunNotFoundError) {
    return publicProblem("run_not_found", 404, "The run does not exist.");
  }
  if (error instanceof DuplicateRunError) {
    return publicProblem("duplicate_run", 409, "The run already exists.");
  }
  if (error instanceof RevisionConflictError) {
    return publicProblem(
      "revision_conflict",
      409,
      "The supplied revision is stale.",
    );
  }
  if (error instanceof RunServiceBlockedError) {
    return publicProblem(
      "workflow_blocked",
      409,
      "The run is waiting for a required checkpoint or is terminal.",
      { runId: error.runId, revision: error.revision },
    );
  }
  if (
    error instanceof InvalidTransitionError ||
    error instanceof MissingCheckpointError ||
    error instanceof NodeStartGuardError ||
    error instanceof InvalidExecutionAttemptError
  ) {
    return publicProblem(
      "workflow_conflict",
      409,
      "The requested workflow mutation is not allowed.",
    );
  }
  return publicProblem(
    "internal_error",
    500,
    "The request could not be completed.",
  );
}

class UnsupportedMediaTypeError extends Error {}
class RequestTooLargeError extends Error {}
class InvalidJsonError extends Error {}
class InvalidRunIdError extends Error {}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new UnsupportedMediaTypeError();
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    Number.isFinite(Number(declared)) &&
    Number(declared) > MAXIMUM_JSON_BYTES
  ) {
    await request.body?.cancel();
    throw new RequestTooLargeError();
  }
  if (request.body === null) {
    throw new InvalidJsonError();
  }
  if (request.signal.aborted) {
    await request.body.cancel();
    throw new InvalidJsonError();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      size += read.value.byteLength;
      if (size > MAXIMUM_JSON_BYTES) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      chunks.push(read.value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidJsonError();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}

async function requestBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.output<Schema>> {
  return schema.parse(await readJson(request));
}

type RouteContext = {
  params: Promise<{ runId: string }>;
};

async function routeRunId(context: RouteContext): Promise<string> {
  const { runId } = await context.params;
  const parsed = RunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new InvalidRunIdError();
  }
  return parsed.data;
}

function routeError(error: unknown): Response {
  if (error instanceof UnsupportedMediaTypeError) {
    return publicProblem(
      "unsupported_media_type",
      415,
      "Content-Type must be application/json.",
    );
  }
  if (error instanceof RequestTooLargeError) {
    return publicProblem(
      "request_too_large",
      413,
      "The JSON request body is too large.",
    );
  }
  if (error instanceof InvalidJsonError) {
    return publicProblem("invalid_json", 400, "The JSON body is invalid.");
  }
  if (error instanceof InvalidRunIdError) {
    return publicProblem(
      "invalid_run_id",
      400,
      "The run identifier is invalid.",
    );
  }
  if (
    error instanceof z.ZodError &&
    error.issues.some((issue) => issue.path.length === 0)
  ) {
    return publicProblem(
      "invalid_request",
      422,
      "The request does not match the required schema.",
    );
  }
  return errorResponse(error);
}

export async function handleCreateRun(
  request: Request,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    const body = await requestBody(request, CreateRunRequestSchema);
    const snapshot = service.create({ intake: body.intake });
    return Response.json(snapshot, {
      status: 201,
      headers: {
        "cache-control": PRIVATE_NO_STORE,
        location: `/api/runs/${snapshot.run.id}`,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function handleBootstrapFixtureWorkbench(
  request: Request,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    await requestBody(request, FixtureWorkbenchBootstrapRequestSchema);
    const bootstrap = service.bootstrapFixtureWorkbench();
    return Response.json(bootstrap, {
      status: 201,
      headers: {
        "cache-control": PRIVATE_NO_STORE,
        location: `/api/runs/${bootstrap.runId}`,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function handleGetRun(
  _request: Request,
  context: RouteContext,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    return Response.json(service.get(await routeRunId(context)), {
      headers: { "cache-control": PRIVATE_NO_STORE },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function handleProgressRun(
  _request: Request,
  context: RouteContext,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    return Response.json(service.progress(await routeRunId(context)), {
      headers: { "cache-control": PRIVATE_NO_STORE },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function handleContinueRun(
  request: Request,
  context: RouteContext,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    const [runId, body] = await Promise.all([
      routeRunId(context),
      requestBody(request, ContinueRunRequestSchema),
    ]);
    return Response.json(
      await service.continue({
        runId,
        expectedRevision: body.expectedRevision,
      }),
      { headers: { "cache-control": PRIVATE_NO_STORE } },
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function handleCheckpoint(
  request: Request,
  context: RouteContext,
  service: RunService = defaultRunService,
): Promise<Response> {
  try {
    const [runId, body] = await Promise.all([
      routeRunId(context),
      requestBody(request, CheckpointRequestSchema),
    ]);
    const snapshot =
      body.checkpoint === "scope"
        ? service.approveScope({
            runId,
            expectedRevision: body.expectedRevision,
            decision: body.decision,
          })
        : body.checkpoint === "packet_freeze"
          ? service.approvePacket({
              runId,
              expectedRevision: body.expectedRevision,
              packet: body.packet,
            })
          : body.checkpoint === "objection_dispositions"
            ? service.submitObjections({
                runId,
                expectedRevision: body.expectedRevision,
                decision: body.decision,
                dispositions: body.dispositions,
              })
            : service.decideFinal({
                runId,
                expectedRevision: body.expectedRevision,
                decision: body.decision,
              });
    return Response.json(snapshot, {
      headers: { "cache-control": PRIVATE_NO_STORE },
    });
  } catch (error) {
    return routeError(error);
  }
}

type ExportService = Pick<RunService, "export">;

export async function handleExportRun(
  _request: Request,
  context: RouteContext,
  service: ExportService = defaultRunService,
): Promise<Response> {
  try {
    const runId = await routeRunId(context);
    return new Response(service.export(runId), {
      headers: {
        "cache-control": PRIVATE_NO_STORE,
        "content-disposition": `attachment; filename="${runId}.json"`,
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

type RunServiceGlobal = typeof globalThis & {
  __evidenceForgeRunService?: RunService;
};

export function getDefaultRunService(): RunService {
  const globalState = globalThis as RunServiceGlobal;
  if (globalState.__evidenceForgeRunService === undefined) {
    const adapter = createFixtureAdapter({
      modelId: "fixture-unconfigured",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {},
    });
    globalState.__evidenceForgeRunService = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: createPromptRunNodeRequestBuilder(),
    });
  }
  return globalState.__evidenceForgeRunService;
}

export const defaultRunService = getDefaultRunService();
