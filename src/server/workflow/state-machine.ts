import { z } from "zod";

import {
  HumanDecisionSchema,
  NodeExecutionSchema,
  PacketFreezeSchema,
  ResearchRunSchema,
  RunErrorSchema,
  SourceChunkSchema,
  SourceRecordSchema,
  type NodeExecution,
  type PacketFreeze,
  type ResearchRun,
} from "../../contracts";

export type RunStatus = ResearchRun["status"];
export type RunError = ResearchRun["errors"][number];
export type HumanDecision = NonNullable<ResearchRun["scopeDecision"]>;

export const ObjectionDispositionPlanSchema = z
  .array(
    z
      .object({
        objectionId: z.string().min(1),
        disposition: z.enum(["accepted", "rejected", "unresolved"]),
        basis: z.string().min(1),
      })
      .strict(),
  )
  .readonly();

export type ObjectionDispositionPlan = z.infer<
  typeof ObjectionDispositionPlanSchema
>;

const transitionTable = {
  draft: ["decomposing"],
  decomposing: ["awaiting_scope_approval"],
  awaiting_scope_approval: ["collecting_sources"],
  collecting_sources: ["awaiting_packet_approval"],
  awaiting_packet_approval: ["extracting_evidence"],
  extracting_evidence: ["verifying_evidence"],
  verifying_evidence: ["synthesizing"],
  synthesizing: ["planning_experiment"],
  planning_experiment: [
    "reviewing_experiment",
    "awaiting_final_approval",
  ],
  reviewing_experiment: ["awaiting_objection_dispositions"],
  awaiting_objection_dispositions: ["revising_experiment"],
  revising_experiment: ["awaiting_final_approval"],
  awaiting_final_approval: ["approved", "rejected"],
  approved: [],
  rejected: [],
  failed: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

for (const destinations of Object.values(transitionTable)) {
  Object.freeze(destinations);
}

export const LEGAL_TRANSITIONS = Object.freeze(transitionTable);

export const WORKFLOW_NODE_PHASES = Object.freeze({
  "clarify-and-decompose": "decomposing",
  "collect-sources": "collecting_sources",
  "extract-evidence": "extracting_evidence",
  "assess-entailment": "verifying_evidence",
  "synthesize-conclusions": "synthesizing",
  "plan-experiment": "planning_experiment",
  "review-experiment": "reviewing_experiment",
  "revise-experiment": "revising_experiment",
} as const satisfies Record<string, RunStatus>);

export type WorkflowNodeId = keyof typeof WORKFLOW_NODE_PHASES;

const PACKET_DEPENDENT_NODES = new Set<WorkflowNodeId>([
  "extract-evidence",
  "assess-entailment",
  "synthesize-conclusions",
  "plan-experiment",
  "review-experiment",
  "revise-experiment",
]);

export class InvalidTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus, detail?: string) {
    super(
      `Invalid workflow transition ${from} -> ${to}${
        detail === undefined ? "" : `: ${detail}`
      }`,
    );
    this.name = "InvalidTransitionError";
  }
}

export class MissingCheckpointError extends Error {
  constructor(checkpoint: string, detail: string) {
    super(`Checkpoint ${checkpoint} is not satisfied: ${detail}`);
    this.name = "MissingCheckpointError";
  }
}

export class NodeStartGuardError extends Error {
  constructor(nodeId: string, detail: string) {
    super(`Workflow node ${nodeId} cannot start: ${detail}`);
    this.name = "NodeStartGuardError";
  }
}

export class InvalidExecutionAttemptError extends Error {
  constructor(detail: string) {
    super(`Invalid execution attempt: ${detail}`);
    this.name = "InvalidExecutionAttemptError";
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidTransitionError(
      "failed",
      "failed",
      `${label} must be an ISO timestamp`,
    );
  }
  return parsed;
}

function assertLaterTimestamp(run: ResearchRun, updatedAt: string): void {
  if (
    parseTimestamp(updatedAt, "updatedAt") <=
    parseTimestamp(run.updatedAt, "current updatedAt")
  ) {
    throw new InvalidTransitionError(
      run.status,
      run.status,
      "updatedAt must advance monotonically",
    );
  }
}

function isChosenOption(decision: HumanDecision): boolean {
  return decision.optionsShown.includes(decision.decision);
}

function assertDecision(
  decision: HumanDecision,
  checkpoint: HumanDecision["checkpoint"],
  allowedDecisions: readonly string[],
): HumanDecision {
  const parsed = HumanDecisionSchema.parse(structuredClone(decision));
  if (parsed.checkpoint !== checkpoint) {
    throw new MissingCheckpointError(
      checkpoint,
      `received ${parsed.checkpoint} checkpoint`,
    );
  }
  if (!isChosenOption(parsed)) {
    throw new MissingCheckpointError(
      checkpoint,
      "decision must be one of optionsShown",
    );
  }
  if (!allowedDecisions.includes(parsed.decision)) {
    throw new MissingCheckpointError(
      checkpoint,
      `unsupported decision ${parsed.decision}`,
    );
  }
  return parsed;
}

function assertApprovedScope(run: ResearchRun): void {
  if (run.scopeDecision === null) {
    throw new MissingCheckpointError("scope", "approval is missing");
  }
  assertDecision(run.scopeDecision, "scope", ["approve"]);
}

function assertApprovedPacket(run: ResearchRun): void {
  if (run.packet === null) {
    throw new MissingCheckpointError("packet_freeze", "frozen packet is missing");
  }
  const packet = PacketFreezeSchema.parse(structuredClone(run.packet));
  assertDecision(packet.freezeDecision, "packet_freeze", ["approve"]);
  if (packet.sourceHashes.length === 0 || packet.chunkHashes.length === 0) {
    throw new MissingCheckpointError(
      "packet_freeze",
      "packet must contain at least one source and one chunk",
    );
  }
  const sourceHashes = run.sources.map(({ contentHash }) => contentHash).sort();
  const chunkHashes = run.chunks.map(({ contentHash }) => contentHash).sort();
  if (
    !sameUniqueMembers(packet.sourceHashes, sourceHashes) ||
    !sameUniqueMembers(packet.chunkHashes, chunkHashes)
  ) {
    throw new MissingCheckpointError(
      "packet_freeze",
      "packet hashes must exactly match the run sources and chunks",
    );
  }
  const blockedSource = run.sources.find(
    ({ rights }) =>
      rights.mayStore !== "allowed" ||
      rights.mayDisplay !== "allowed" ||
      rights.maySendToModel !== "allowed",
  );
  if (blockedSource !== undefined) {
    throw new MissingCheckpointError(
      "packet_freeze",
      `source ${blockedSource.id} is not approved for storage, display, and model sending`,
    );
  }
  const blockedChunk = run.chunks.find(
    ({ displayPermission }) => displayPermission !== "allowed",
  );
  if (blockedChunk !== undefined) {
    throw new MissingCheckpointError(
      "packet_freeze",
      `chunk ${blockedChunk.id} is not approved for display`,
    );
  }
}

function assertObjectionDispositions(
  run: ResearchRun,
  dispositionsInput: ObjectionDispositionPlan | null | undefined,
): ObjectionDispositionPlan {
  if (run.review === null) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "experiment review is missing",
    );
  }
  if (run.objectionDispositionDecision === null) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "human disposition checkpoint is missing",
    );
  }
  if (dispositionsInput === null || dispositionsInput === undefined) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "typed per-objection dispositions are missing",
    );
  }
  const dispositions = ObjectionDispositionPlanSchema.parse(
    structuredClone(dispositionsInput),
  );
  const decision = assertDecision(
    run.objectionDispositionDecision,
    "objection_dispositions",
    ["approve"],
  );
  const objectionIds = new Set(
    run.review.objections.map((objection) => objection.id),
  );
  const dispositionIds = dispositions.map(
    ({ objectionId }) => objectionId,
  );
  if (
    new Set(dispositionIds).size !== dispositionIds.length ||
    !sameUniqueMembers([...objectionIds], dispositionIds)
  ) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "every review objection requires exactly one typed disposition",
    );
  }
  const unresolvedIds = dispositions
    .filter(({ disposition }) => disposition === "unresolved")
    .map(({ objectionId }) => objectionId);
  if (
    !sameUniqueMembers(decision.unresolvedObjections, unresolvedIds)
  ) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "human checkpoint unresolved IDs must match typed dispositions",
    );
  }
  return dispositions;
}

function assertFinalDecision(run: ResearchRun, to: RunStatus): void {
  if (run.finalDecision === null) {
    throw new MissingCheckpointError("final", "human decision is missing");
  }
  const expectedDecision = to === "approved" ? "approve" : "reject";
  const decision = assertDecision(run.finalDecision, "final", [
    expectedDecision,
  ]);
  if (
    run.experimentAbstention !== null &&
    run.experimentAbstention !== undefined
  ) {
    if (
      run.experiment !== null ||
      run.review !== null ||
      run.revision !== null ||
      decision.unresolvedObjections.length !== 0
    ) {
      throw new MissingCheckpointError(
        "final",
        "typed experiment abstention cannot carry a protocol, review, revision, or unresolved objection",
      );
    }
    return;
  }
  if (run.revision === null) {
    throw new MissingCheckpointError("final", "experiment revision is missing");
  }
  const unresolvedIds = run.revision.decisions
    .filter(({ disposition }) => disposition === "unresolved")
    .map(({ objectionId }) => objectionId);
  if (!sameUniqueMembers(decision.unresolvedObjections, unresolvedIds)) {
    throw new MissingCheckpointError(
      "final",
      "unresolved objections must match the completed revision",
    );
  }
}

function assertRevisionMatchesDispositions(
  run: ResearchRun,
  dispositionsInput: ObjectionDispositionPlan | null | undefined,
): void {
  const dispositions = assertObjectionDispositions(
    run,
    dispositionsInput,
  );
  if (run.revision === null) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "completed revision is missing",
    );
  }
  const revisionById = new Map(
    run.revision.decisions.map((revision) => [
      revision.objectionId,
      revision,
    ]),
  );
  if (
    revisionById.size !== run.revision.decisions.length ||
    !sameUniqueMembers(
      dispositions.map(({ objectionId }) => objectionId),
      [...revisionById.keys()],
    )
  ) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "completed revision must cover every persisted disposition exactly once",
    );
  }
  for (const disposition of dispositions) {
    const revision = revisionById.get(disposition.objectionId);
    if (
      revision === undefined ||
      revision.disposition !== disposition.disposition ||
      revision.basis !== disposition.basis ||
      (revision.disposition === "accepted" &&
        revision.revisedValue === null) ||
      (revision.disposition !== "accepted" &&
        revision.revisedValue !== null)
    ) {
      throw new MissingCheckpointError(
        "objection_dispositions",
        `revision for ${disposition.objectionId} does not match its persisted disposition`,
      );
    }
  }
}

function withStatus(
  run: ResearchRun,
  status: RunStatus,
  updatedAt: string,
): ResearchRun {
  assertLaterTimestamp(run, updatedAt);
  return ResearchRunSchema.parse({
    ...structuredClone(run),
    status,
    updatedAt,
  });
}

export function advanceRun(
  runInput: ResearchRun,
  to: RunStatus,
  updatedAt: string,
  objectionDispositions?: ObjectionDispositionPlan | null,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  const allowed = LEGAL_TRANSITIONS[run.status] as readonly RunStatus[];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(run.status, to);
  }

  if (run.status === "awaiting_scope_approval") {
    assertApprovedScope(run);
  } else if (run.status === "awaiting_packet_approval") {
    assertApprovedPacket(run);
  } else if (run.status === "awaiting_objection_dispositions") {
    assertObjectionDispositions(run, objectionDispositions);
  } else if (
    run.status === "revising_experiment"
  ) {
    assertRevisionMatchesDispositions(run, objectionDispositions);
  } else if (run.status === "awaiting_final_approval") {
    assertFinalDecision(run, to);
  }

  return withStatus(run, to, updatedAt);
}

export function persistScopeApproval(
  runInput: ResearchRun,
  decisionInput: HumanDecision,
  updatedAt: string,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (run.status !== "awaiting_scope_approval") {
    throw new InvalidTransitionError(run.status, "collecting_sources");
  }
  if (run.scopeDecision !== null) {
    throw new MissingCheckpointError("scope", "decision already exists");
  }
  const decision = assertDecision(decisionInput, "scope", ["approve"]);
  return advanceRun(
    ResearchRunSchema.parse({ ...run, scopeDecision: decision }),
    "collecting_sources",
    updatedAt,
  );
}

/**
 * Records the researcher-reviewed source set without asking a model to invent
 * sources. Source and chunk identity remain application-owned and the run does
 * not reach the packet checkpoint until the complete set validates together.
 */
export function persistCollectedSources(
  runInput: ResearchRun,
  sourcesInput: ResearchRun["sources"],
  chunksInput: ResearchRun["chunks"],
  updatedAt: string,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (run.status !== "collecting_sources") {
    throw new InvalidTransitionError(run.status, "awaiting_packet_approval");
  }
  if (run.packet !== null) {
    throw new MissingCheckpointError(
      "packet_freeze",
      "sources cannot be replaced after packet approval",
    );
  }
  const sources = SourceRecordSchema.array().min(2).max(10).parse(
    structuredClone(sourcesInput),
  );
  const chunks = SourceChunkSchema.array().min(2).max(128).parse(
    structuredClone(chunksInput),
  );
  const sourceIds = new Set(sources.map(({ id }) => id));
  if (chunks.some(({ sourceId }) => !sourceIds.has(sourceId))) {
    throw new InvalidExecutionAttemptError(
      "every collected chunk must reference a collected source",
    );
  }
  const candidate = ResearchRunSchema.parse({
    ...run,
    sources,
    chunks,
  });
  return advanceRun(candidate, "awaiting_packet_approval", updatedAt);
}

export function persistPacketApproval(
  runInput: ResearchRun,
  packetInput: PacketFreeze,
  updatedAt: string,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (run.status !== "awaiting_packet_approval") {
    throw new InvalidTransitionError(run.status, "extracting_evidence");
  }
  if (run.packet !== null) {
    throw new MissingCheckpointError(
      "packet_freeze",
      "frozen packet already exists",
    );
  }
  const packet = PacketFreezeSchema.parse(structuredClone(packetInput));
  assertDecision(packet.freezeDecision, "packet_freeze", ["approve"]);
  return advanceRun(
    ResearchRunSchema.parse({ ...run, packet }),
    "extracting_evidence",
    updatedAt,
  );
}

export function persistObjectionDispositions(
  runInput: ResearchRun,
  decisionInput: HumanDecision,
  dispositionsInput: ObjectionDispositionPlan,
  updatedAt: string,
): {
  run: ResearchRun;
  objectionDispositions: ObjectionDispositionPlan;
} {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (run.status !== "awaiting_objection_dispositions") {
    throw new InvalidTransitionError(run.status, "revising_experiment");
  }
  if (
    run.objectionDispositionDecision !== null
  ) {
    throw new MissingCheckpointError(
      "objection_dispositions",
      "decision already exists",
    );
  }
  const decision = assertDecision(
    decisionInput,
    "objection_dispositions",
    ["approve"],
  );
  const dispositions = ObjectionDispositionPlanSchema.parse(
    structuredClone(dispositionsInput),
  );
  const candidate = ResearchRunSchema.parse({
    ...run,
    objectionDispositionDecision: decision,
  });
  assertObjectionDispositions(candidate, dispositions);
  return {
    run: advanceRun(
      candidate,
      "revising_experiment",
      updatedAt,
      dispositions,
    ),
    objectionDispositions: dispositions,
  };
}

export function decideFinalApproval(
  runInput: ResearchRun,
  decisionInput: HumanDecision,
  updatedAt: string,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (run.status !== "awaiting_final_approval") {
    throw new InvalidTransitionError(run.status, "approved");
  }
  if (run.finalDecision !== null) {
    throw new MissingCheckpointError("final", "decision already exists");
  }
  const decision = assertDecision(decisionInput, "final", [
    "approve",
    "reject",
  ]);
  const to = decision.decision === "approve" ? "approved" : "rejected";
  return advanceRun(
    ResearchRunSchema.parse({ ...run, finalDecision: decision }),
    to,
    updatedAt,
  );
}

export function failRun(
  runInput: ResearchRun,
  errorInput: RunError,
  updatedAt: string,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (
    run.status === "approved" ||
    run.status === "rejected" ||
    run.status === "failed"
  ) {
    throw new InvalidTransitionError(run.status, "failed");
  }
  const error = RunErrorSchema.parse(structuredClone(errorInput));
  if (run.errors.some(({ id }) => id === error.id)) {
    throw new InvalidExecutionAttemptError(
      `terminal error ID ${error.id} already exists`,
    );
  }
  if (error.executionId !== null) {
    throw new InvalidExecutionAttemptError(
      "failRun accepts a new run-level error; execution failures use appendExecutionAttempt",
    );
  }
  assertLaterTimestamp(run, updatedAt);
  return ResearchRunSchema.parse({
    ...run,
    status: "failed",
    updatedAt,
    errors: [...run.errors, error],
  });
}

export function assertNodeMayStart(
  runInput: ResearchRun,
  nodeId: WorkflowNodeId | string,
  objectionDispositions?: ObjectionDispositionPlan | null,
): void {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  const registeredNodeId: WorkflowNodeId = nodeId.startsWith("extract-evidence:")
    ? "extract-evidence"
    : nodeId as WorkflowNodeId;
  if (!(registeredNodeId in WORKFLOW_NODE_PHASES)) {
    throw new NodeStartGuardError(String(nodeId), "node ID is not registered");
  }
  const expectedStatus = WORKFLOW_NODE_PHASES[registeredNodeId];
  if (run.status !== expectedStatus) {
    throw new NodeStartGuardError(
      nodeId,
      `requires ${expectedStatus}, received ${run.status}`,
    );
  }
  if (registeredNodeId === "collect-sources") {
    try {
      assertApprovedScope(run);
    } catch (error) {
      throw new NodeStartGuardError(nodeId, (error as Error).message);
    }
  }
  if (PACKET_DEPENDENT_NODES.has(registeredNodeId)) {
    try {
      assertApprovedPacket(run);
    } catch (error) {
      throw new NodeStartGuardError(nodeId, (error as Error).message);
    }
  }
  if (registeredNodeId === "revise-experiment") {
    try {
      assertObjectionDispositions(run, objectionDispositions);
      if (run.revision !== null) {
        throw new MissingCheckpointError(
          "objection_dispositions",
          "revision is already complete",
        );
      }
    } catch (error) {
      throw new NodeStartGuardError(nodeId, (error as Error).message);
    }
  }
}

export function runGuardedNodeEffect<T>(
  run: ResearchRun,
  nodeId: WorkflowNodeId,
  effect: () => T,
  objectionDispositions?: ObjectionDispositionPlan | null,
): T {
  assertNodeMayStart(run, nodeId, objectionDispositions);
  return effect();
}

function sameUniqueMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length
  ) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function isFailedAttempt(execution: NodeExecution): boolean {
  return (
    execution.status === "failed" ||
    execution.status === "refused" ||
    execution.status === "timed_out"
  );
}

function assertOnlyTopLevelChanges(
  stored: ResearchRun,
  candidate: ResearchRun,
  allowedFields: readonly (keyof ResearchRun)[],
): void {
  const allowed = new Set<keyof ResearchRun>(allowedFields);
  for (const field of Object.keys(stored) as (keyof ResearchRun)[]) {
    if (
      !allowed.has(field) &&
      JSON.stringify(stored[field]) !== JSON.stringify(candidate[field])
    ) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        `field ${field} cannot change on this lifecycle edge`,
      );
    }
  }
}

export function appendExecutionAttempt(
  runInput: ResearchRun,
  executionInput: NodeExecution,
  errorInputs: readonly RunError[],
  updatedAt: string,
  objectionDispositions?: ObjectionDispositionPlan | null,
): ResearchRun {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  const execution = NodeExecutionSchema.parse(structuredClone(executionInput));
  const errors = errorInputs.map((error) =>
    RunErrorSchema.parse(structuredClone(error)),
  );

  validateExecutionHistory(run);
  assertNodeMayStart(
    run,
    execution.nodeId as WorkflowNodeId,
    objectionDispositions,
  );
  assertLaterTimestamp(run, updatedAt);

  if (execution.status === "started") {
    throw new InvalidExecutionAttemptError(
      "this first adapter appends only terminal attempts; streaming finalization belongs to provider orchestration",
    );
  }
  if (run.executions.some(({ id }) => id === execution.id)) {
    throw new InvalidExecutionAttemptError(
      `execution ID ${execution.id} already exists`,
    );
  }
  const newErrorIds = errors.map(({ id }) => id);
  if (new Set(newErrorIds).size !== newErrorIds.length) {
    throw new InvalidExecutionAttemptError("new error IDs must be unique");
  }
  if (
    errors.some((error) => run.errors.some(({ id }) => id === error.id))
  ) {
    throw new InvalidExecutionAttemptError("error ID already exists");
  }

  const priorAttempts = run.executions.filter(
    ({ nodeId }) => nodeId === execution.nodeId,
  );
  const prior = priorAttempts.at(-1);
  const expectedAttempt = (prior?.attempt ?? 0) + 1;
  if (execution.attempt !== expectedAttempt) {
    throw new InvalidExecutionAttemptError(
      `attempt ${execution.attempt} must be contiguous attempt ${expectedAttempt}`,
    );
  }
  if (prior === undefined) {
    if (execution.retryOfExecutionId !== null) {
      throw new InvalidExecutionAttemptError(
        "first attempt must not reference a retry parent",
      );
    }
  } else {
    if (!isFailedAttempt(prior)) {
      throw new InvalidExecutionAttemptError(
        `attempt ${prior.attempt} did not fail and cannot be retried`,
      );
    }
    if (execution.retryOfExecutionId !== prior.id) {
      throw new InvalidExecutionAttemptError(
        "retry must reference the immediate preserved prior attempt",
      );
    }
    const priorErrors = prior.errorIds.map((errorId) =>
      run.errors.find(({ id }) => id === errorId),
    );
    if (
      priorErrors.some((error) => error === undefined) ||
      !priorErrors.some((error) => error?.retryable === true)
    ) {
      throw new InvalidExecutionAttemptError(
        "retry parent must retain a linked retryable error",
      );
    }
  }

  if (isFailedAttempt(execution)) {
    if (
      errors.length === 0 ||
      execution.validation.valid ||
      execution.outputRefs.length !== 0 ||
      !sameUniqueMembers(execution.errorIds, newErrorIds)
    ) {
      throw new InvalidExecutionAttemptError(
        "failed attempt requires its exact linked errors, invalid validation, and no success output",
      );
    }
  } else if (
    execution.status === "succeeded" &&
    (errors.length !== 0 ||
      execution.errorIds.length !== 0 ||
      !execution.validation.valid)
  ) {
    throw new InvalidExecutionAttemptError(
      "successful attempt cannot carry errors or invalid validation",
    );
  }

  for (const error of errors) {
    if (
      error.executionId !== execution.id ||
      error.nodeId !== execution.nodeId
    ) {
      throw new InvalidExecutionAttemptError(
        `error ${error.id} must link bidirectionally to ${execution.id}`,
      );
    }
  }

  const candidate = ResearchRunSchema.parse({
    ...run,
    updatedAt,
    executions: [...run.executions, execution],
    errors: [...run.errors, ...errors],
  });
  validateExecutionHistory(candidate);
  return candidate;
}

export function validateExecutionHistory(runInput: ResearchRun): void {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  const executionIds = run.executions.map(({ id }) => id);
  const errorIds = run.errors.map(({ id }) => id);
  if (new Set(executionIds).size !== executionIds.length) {
    throw new InvalidExecutionAttemptError("execution IDs must be unique");
  }
  if (new Set(errorIds).size !== errorIds.length) {
    throw new InvalidExecutionAttemptError("error IDs must be unique");
  }

  const executionById = new Map(
    run.executions.map((execution) => [execution.id, execution]),
  );
  const errorById = new Map(run.errors.map((error) => [error.id, error]));
  const previousByNode = new Map<string, NodeExecution>();

  for (const execution of run.executions) {
    if (execution.status === "started") {
      throw new InvalidExecutionAttemptError(
        "this first adapter persists only terminal attempts",
      );
    }
    const previous = previousByNode.get(execution.nodeId);
    const expectedAttempt = (previous?.attempt ?? 0) + 1;
    if (execution.attempt !== expectedAttempt) {
      throw new InvalidExecutionAttemptError(
        `${execution.nodeId} attempt history must be ordered and contiguous`,
      );
    }
    if (previous === undefined) {
      if (execution.retryOfExecutionId !== null) {
        throw new InvalidExecutionAttemptError(
          "first attempt must not reference a retry parent",
        );
      }
    } else {
      if (
        !isFailedAttempt(previous) ||
        execution.retryOfExecutionId !== previous.id
      ) {
        throw new InvalidExecutionAttemptError(
          "retry must reference the immediate failed prior attempt",
        );
      }
      const previousErrors = previous.errorIds.map((errorId) =>
        errorById.get(errorId),
      );
      if (
        previousErrors.length === 0 ||
        previousErrors.some(
          (error) => error === undefined || !error.retryable,
        )
      ) {
        throw new InvalidExecutionAttemptError(
          "every terminal cause on the retry parent must be retryable",
        );
      }
    }

    const linkedErrors = run.errors.filter(
      ({ executionId }) => executionId === execution.id,
    );
    const linkedErrorIds = linkedErrors.map(({ id }) => id);
    if (!sameUniqueMembers(execution.errorIds, linkedErrorIds)) {
      throw new InvalidExecutionAttemptError(
        `execution ${execution.id} must link every error exactly once`,
      );
    }
    if (
      linkedErrors.some(({ nodeId }) => nodeId !== execution.nodeId)
    ) {
      throw new InvalidExecutionAttemptError(
        `execution ${execution.id} has an error linked to another node`,
      );
    }
    if (isFailedAttempt(execution)) {
      if (
        linkedErrors.length === 0 ||
        execution.validation.valid ||
        execution.outputRefs.length !== 0
      ) {
        throw new InvalidExecutionAttemptError(
          `failed execution ${execution.id} has an incoherent terminal record`,
        );
      }
    } else if (
      execution.errorIds.length !== 0 ||
      !execution.validation.valid
    ) {
      throw new InvalidExecutionAttemptError(
        `successful execution ${execution.id} has errors or invalid validation`,
      );
    }
    previousByNode.set(execution.nodeId, execution);
  }

  for (const error of run.errors) {
    if (error.executionId === null) {
      continue;
    }
    const execution = executionById.get(error.executionId);
    if (
      execution === undefined ||
      execution.nodeId !== error.nodeId ||
      !execution.errorIds.includes(error.id)
    ) {
      throw new InvalidExecutionAttemptError(
        `error ${error.id} must link bidirectionally to an execution`,
      );
    }
  }
}

export function validateWorkflowMutation(
  storedInput: ResearchRun,
  candidateInput: ResearchRun,
  objectionDispositions?: ObjectionDispositionPlan | null,
): void {
  const stored = ResearchRunSchema.parse(structuredClone(storedInput));
  const candidate = ResearchRunSchema.parse(structuredClone(candidateInput));
  if (stored.id !== candidate.id) {
    throw new InvalidTransitionError(
      stored.status,
      candidate.status,
      "run ID cannot change",
    );
  }
  assertLaterTimestamp(stored, candidate.updatedAt);
  validateExecutionHistory(stored);
  validateExecutionHistory(candidate);
  const appendedExecutions = candidate.executions.slice(
    stored.executions.length,
  );
  if (appendedExecutions.length > 1) {
    throw new InvalidExecutionAttemptError(
      "one store mutation may append at most one execution attempt",
    );
  }
  if (appendedExecutions.length === 1) {
    if (stored.status !== candidate.status) {
      throw new InvalidExecutionAttemptError(
        "execution append and lifecycle transition must be separate mutations",
      );
    }
    assertNodeMayStart(
      stored,
      appendedExecutions[0].nodeId as WorkflowNodeId,
      objectionDispositions,
    );
    if (appendedExecutions[0].nodeId === "revise-experiment") {
      if (appendedExecutions[0].status === "succeeded") {
        assertRevisionMatchesDispositions(
          candidate,
          objectionDispositions,
        );
      } else if (candidate.revision !== stored.revision) {
        throw new InvalidExecutionAttemptError(
          "failed revision attempt cannot persist a revision",
        );
      }
    } else if (
      JSON.stringify(stored.revision) !==
      JSON.stringify(candidate.revision)
    ) {
      throw new InvalidExecutionAttemptError(
        "only a successful revise-experiment attempt may create revision",
      );
    }
  }

  const checkpointFields = [
    "scopeDecision",
    "packet",
    "objectionDispositionDecision",
    "finalDecision",
  ] as const;
  const additions = checkpointFields.filter(
    (field) => stored[field] === null && candidate[field] !== null,
  );
  const expectedCheckpointsByEdge: Partial<
    Record<string, readonly (typeof checkpointFields)[number][]>
  > = {
    "awaiting_scope_approval->collecting_sources": ["scopeDecision"],
    "awaiting_packet_approval->extracting_evidence": ["packet"],
    "awaiting_objection_dispositions->revising_experiment": [
      "objectionDispositionDecision",
    ],
    "awaiting_final_approval->approved": ["finalDecision"],
    "awaiting_final_approval->rejected": ["finalDecision"],
  };
  const expectedDataFieldsByEdge: Partial<
    Record<string, readonly (keyof ResearchRun)[]>
  > = {
    "collecting_sources->awaiting_packet_approval": ["sources", "chunks"],
    "planning_experiment->awaiting_final_approval": ["experimentAbstention"],
  };
  const edge = `${stored.status}->${candidate.status}`;

  if (stored.status === candidate.status) {
    if (
      stored.status === "approved" ||
      stored.status === "rejected" ||
      stored.status === "failed"
    ) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        "terminal runs are immutable",
      );
    }
    if (appendedExecutions.length !== 1) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        "same-phase persistence requires one validated terminal execution",
      );
    }
    if (additions.length !== 0) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        "checkpoint recording must use its declared lifecycle edge",
      );
    }
    const newRunLevelError = candidate.errors
      .slice(stored.errors.length)
      .some(({ executionId }) => executionId === null);
    if (newRunLevelError) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        "run-level terminal errors require failRun",
      );
    }
    return;
  }

  if (candidate.status === "failed") {
    if (
      stored.status === "approved" ||
      stored.status === "rejected" ||
      stored.status === "failed" ||
      candidate.executions.length !== stored.executions.length ||
      candidate.errors.length !== stored.errors.length + 1 ||
      candidate.errors.at(-1)?.executionId !== null ||
      additions.length !== 0
    ) {
      throw new InvalidTransitionError(
        stored.status,
        candidate.status,
        "failed transition requires exactly one new run-level error",
      );
    }
    assertOnlyTopLevelChanges(stored, candidate, [
      "status",
      "updatedAt",
      "errors",
    ]);
    return;
  }

  const allowed = LEGAL_TRANSITIONS[stored.status] as readonly RunStatus[];
  if (!allowed.includes(candidate.status)) {
    throw new InvalidTransitionError(stored.status, candidate.status);
  }
  const expectedCheckpoints = expectedCheckpointsByEdge[edge] ?? [];
  if (
    !sameUniqueMembers(expectedCheckpoints, additions)
  ) {
    throw new InvalidTransitionError(
      stored.status,
      candidate.status,
      "checkpoint delta does not match the lifecycle edge",
    );
  }
  assertOnlyTopLevelChanges(stored, candidate, [
    "status",
    "updatedAt",
    ...(expectedDataFieldsByEdge[edge] ?? []),
    ...expectedCheckpoints,
  ]);

  if (stored.status === "awaiting_scope_approval") {
    assertApprovedScope(candidate);
  } else if (stored.status === "awaiting_packet_approval") {
    assertApprovedPacket(candidate);
  } else if (stored.status === "awaiting_objection_dispositions") {
    assertObjectionDispositions(candidate, objectionDispositions);
  } else if (stored.status === "revising_experiment") {
    assertRevisionMatchesDispositions(
      candidate,
      objectionDispositions,
    );
  } else if (stored.status === "awaiting_final_approval") {
    assertFinalDecision(candidate, candidate.status);
  }
}
