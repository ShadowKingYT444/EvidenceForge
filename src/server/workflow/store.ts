import { ResearchRunSchema, type ResearchRun } from "../../contracts";
import { goldenRunV01 } from "../../fixtures/golden-run-v0.1";
import {
  GOLDEN_FIXTURE_ID_V02,
  goldenRunV02,
} from "../../fixtures/golden-run-v0.2";

import {
  InvalidExecutionAttemptError,
  InvalidTransitionError,
  ObjectionDispositionPlanSchema,
  validateExecutionHistory,
  validateWorkflowMutation,
  type ObjectionDispositionPlan,
} from "./state-machine";

export type WorkflowRunSnapshot = {
  run: ResearchRun;
  revision: string;
  objectionDispositions: ObjectionDispositionPlan | null;
};

/** Private run-cache boundary. Implementations must clone/validate values and
 * use compare-and-swap semantics on save. */
export interface WorkflowRunStore {
  create(runInput: ResearchRun, options?: { accessTokenDigest?: string }): Promise<WorkflowRunSnapshot>;
  importSnapshot?(snapshot: WorkflowRunSnapshot, options?: { accessTokenDigest?: string }): Promise<WorkflowRunSnapshot>;
  load(runId: string): Promise<WorkflowRunSnapshot | null>;
  authorize?(runId: string, accessTokenDigest: string): Promise<WorkflowRunSnapshot | null>;
  save(
    runInput: ResearchRun,
    expectedRevision: string,
    objectionDispositionsInput?: ObjectionDispositionPlan | null,
  ): Promise<WorkflowRunSnapshot>;
  saveComposite?(
    runInput: ResearchRun,
    expectedRevision: string,
    objectionDispositionsInput?: ObjectionDispositionPlan | null,
  ): Promise<WorkflowRunSnapshot>;
  delete?(runId: string, expectedRevision: string, accessTokenDigest?: string): Promise<void>;
  getPacketDraft?(runId: string): Promise<unknown | null>;
  savePacketDraft?(runId: string, expectedRevision: string, draft: unknown): Promise<{ revision: string; draft: unknown }>;
  scheduleExpiry?(runId: string, delayMs: number): void;
}

/** Private process-local cache with sliding inactivity expiration. */
export class AsyncWorkflowRunStoreAdapter implements WorkflowRunStore {
  readonly #accessTokenDigests = new Map<string, string>();
  readonly #packetDrafts = new Map<string, unknown>();
  readonly #lastAccess = new Map<string, number>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #ttlMs: number;

  constructor(
    private readonly delegate: InMemoryWorkflowRunStore,
    options: { ttlMs?: number } = {},
  ) {
    this.#ttlMs = options.ttlMs ?? 120 * 60 * 1_000;
  }

  #remove(runId: string) {
    try { this.delegate.remove(runId); } catch { /* already absent */ }
    this.#accessTokenDigests.delete(runId);
    this.#packetDrafts.delete(runId);
    this.#lastAccess.delete(runId);
    const timer = this.#expiryTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(runId);
  }

  #sweep(now = Date.now()) {
    for (const [runId, lastAccess] of this.#lastAccess) {
      if (now - lastAccess >= this.#ttlMs) this.#remove(runId);
    }
  }

  #touch(runId: string) {
    this.#sweep();
    this.#lastAccess.set(runId, Date.now());
  }

  async create(input: ResearchRun, options?: { accessTokenDigest?: string }) {
    this.#sweep();
    const snapshot = this.delegate.create(input);
    if (options?.accessTokenDigest) {
      this.#accessTokenDigests.set(snapshot.run.id, options.accessTokenDigest);
    }
    this.#packetDrafts.set(snapshot.run.id, { sources: [] });
    this.#touch(snapshot.run.id);
    return snapshot;
  }
  async importSnapshot(snapshotInput: WorkflowRunSnapshot, options?: { accessTokenDigest?: string }) {
    this.#sweep();
    this.delegate.hydrate(snapshotInput);
    const snapshot = this.delegate.load(snapshotInput.run.id);
    if (!snapshot) throw new RunNotFoundError(snapshotInput.run.id);
    if (options?.accessTokenDigest) this.#accessTokenDigests.set(snapshot.run.id, options.accessTokenDigest);
    this.#packetDrafts.set(snapshot.run.id, { sources: [] });
    this.#touch(snapshot.run.id);
    return snapshot;
  }
  async load(runId: string) {
    this.#sweep();
    const snapshot = this.delegate.load(runId);
    if (snapshot) this.#touch(runId);
    return snapshot;
  }
  async authorize(runId: string, accessTokenDigest: string) {
    this.#sweep();
    if (this.#accessTokenDigests.get(runId) !== accessTokenDigest) return null;
    const snapshot = this.delegate.load(runId);
    if (snapshot) this.#touch(runId);
    return snapshot;
  }
  async save(input: ResearchRun, revision: string, dispositions?: ObjectionDispositionPlan | null) {
    const snapshot = this.delegate.save(input, revision, dispositions);
    this.#touch(input.id);
    return snapshot;
  }
  async saveComposite(input: ResearchRun, revision: string, dispositions?: ObjectionDispositionPlan | null) {
    const snapshot = this.delegate.saveComposite(input, revision, dispositions);
    this.#touch(input.id);
    return snapshot;
  }
  async delete(runId: string, expectedRevision: string) {
    const current = this.delegate.load(runId);
    if (!current) throw new RunNotFoundError(runId);
    if (current.revision !== expectedRevision) throw new RevisionConflictError(runId);
    this.#remove(runId);
  }
  async getPacketDraft(runId: string) {
    this.#sweep();
    if (this.delegate.load(runId)) this.#touch(runId);
    return this.#packetDrafts.has(runId)
      ? structuredClone(this.#packetDrafts.get(runId))
      : null;
  }
  async savePacketDraft(runId: string, expectedRevision: string, draft: unknown) {
    const current = this.delegate.load(runId);
    if (!current) throw new RunNotFoundError(runId);
    if (current.revision !== expectedRevision) throw new RevisionConflictError(runId);
    this.#packetDrafts.set(runId, structuredClone(draft));
    this.#touch(runId);
    return { revision: current.revision, draft: structuredClone(draft) };
  }

  scheduleExpiry(runId: string, delayMs: number) {
    const prior = this.#expiryTimers.get(runId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => this.#remove(runId), delayMs);
    timer.unref?.();
    this.#expiryTimers.set(runId, timer);
  }
}

export class DuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} already exists`);
    this.name = "DuplicateRunError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} does not exist`);
    this.name = "RunNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} has a stale revision`);
    this.name = "RevisionConflictError";
  }
}

function cloneRun(run: ResearchRun): ResearchRun {
  return ResearchRunSchema.parse(structuredClone(run));
}

function exactPrefix<T>(before: readonly T[], after: readonly T[]): boolean {
  return (
    after.length >= before.length &&
    before.every(
      (value, index) =>
        JSON.stringify(value) === JSON.stringify(after[index]),
    )
  );
}

function assertAppendOnlyHistory(
  stored: ResearchRun,
  candidate: ResearchRun,
): void {
  if (!exactPrefix(stored.executions, candidate.executions)) {
    throw new InvalidExecutionAttemptError(
      "stored execution history cannot be edited, reordered, or erased",
    );
  }
  if (!exactPrefix(stored.errors, candidate.errors)) {
    throw new InvalidExecutionAttemptError(
      "stored error history cannot be edited, reordered, or erased",
    );
  }
}

function assertPersistedCheckpoints(
  stored: ResearchRun,
  candidate: ResearchRun,
): void {
  for (const field of [
    "scopeDecision",
    "packet",
    "objectionDispositionDecision",
    "revision",
    "finalDecision",
  ] as const) {
    if (
      stored[field] !== null &&
      JSON.stringify(stored[field]) !== JSON.stringify(candidate[field])
    ) {
      throw new InvalidExecutionAttemptError(
        `persisted ${field} checkpoint cannot be replaced or erased`,
      );
    }
  }
  if (
    stored.packet !== null &&
    (JSON.stringify(stored.sources) !== JSON.stringify(candidate.sources) ||
      JSON.stringify(stored.chunks) !== JSON.stringify(candidate.chunks))
  ) {
    throw new InvalidExecutionAttemptError(
      "frozen packet sources and chunks cannot be edited after approval",
    );
  }
}

/**
 * First persistence adapter for the fixture slice.
 *
 * Records live only inside this adapter instance and are lost on process
 * restart, hot reload, or creation of a new instance. There is no disk,
 * browser, network, multi-process/serverless coordination, backup, migration,
 * retention, or authentication. Compare-and-swap atomicity applies only to
 * synchronous calls on this one instance. reset() is destructive and local.
 */
export class InMemoryWorkflowRunStore {
  readonly capabilities = Object.freeze({
    scope: "process_local" as const,
    survivesCallsWithinProcess: true,
    survivesProcessRestart: false,
    diskDurable: false,
    multiProcessSafe: false,
  });

  readonly #records = new Map<string, WorkflowRunSnapshot>();
  #revisionSequence = 0;

  #nextRevision(): string {
    this.#revisionSequence += 1;
    return `memory-revision-${this.#revisionSequence}`;
  }

  create(runInput: ResearchRun): WorkflowRunSnapshot {
    const run = cloneRun(runInput);
    if (
      run.status !== "draft" ||
      run.scopeDecision !== null ||
      run.packet !== null ||
      run.claims.length !== 0 ||
      run.sources.length !== 0 ||
      run.chunks.length !== 0 ||
      run.evidenceCards.length !== 0 ||
      run.conclusions.length !== 0 ||
      run.researchGaps.length !== 0 ||
      run.selectedGapId !== null ||
      run.experiment !== null ||
      run.review !== null ||
      run.objectionDispositionDecision !== null ||
      run.revision !== null ||
      run.finalDecision !== null ||
      run.executions.length !== 0 ||
      run.errors.length !== 0
    ) {
      throw new InvalidTransitionError(
        run.status,
        run.status,
        "new process-local records must start as a history-free draft",
      );
    }
    validateExecutionHistory(run);
    if (this.#records.has(run.id)) {
      throw new DuplicateRunError(run.id);
    }
    const snapshot = {
      run,
      revision: this.#nextRevision(),
      objectionDispositions: null,
    };
    this.#records.set(run.id, snapshot);
    return this.#cloneSnapshot(snapshot);
  }

  createFixtureWorkbenchSession(
    runId: string,
    createdAt: string,
  ): WorkflowRunSnapshot {
    const reviewed = structuredClone(goldenRunV02);
    const updatedAt = new Date(
      Math.max(Date.parse(createdAt), Date.parse(reviewed.updatedAt) + 1),
    ).toISOString();
    const run = cloneRun({
      ...reviewed,
      id: runId,
      status: "awaiting_final_approval",
      createdAt,
      updatedAt,
      finalDecision: null,
      executions: reviewed.executions.map((execution) => ({
        ...execution,
        inputRefs: execution.inputRefs.map((reference) =>
          reference === GOLDEN_FIXTURE_ID_V02 ? runId : reference,
        ),
        outputRefs: execution.outputRefs.map((reference) =>
          reference === GOLDEN_FIXTURE_ID_V02 ? runId : reference,
        ),
      })),
    });
    if (this.#records.has(run.id)) {
      throw new DuplicateRunError(run.id);
    }
    validateExecutionHistory(run);
    const snapshot = {
      run,
      revision: this.#nextRevision(),
      objectionDispositions: null,
    };
    this.#records.set(run.id, snapshot);
    return this.#cloneSnapshot(snapshot);
  }

  /**
   * Server-only bootstrap for the single rights-reviewed live golden packet.
   *
   * This is intentionally not a general packet injection surface. It retains
   * the reviewed scope and frozen packet while clearing all model-authored
   * outputs/history so the live invocation must rebuild them append-only.
   */
  createApprovedGoldenInvocationSession(
    runId: string,
    createdAt: string,
    evidenceMode: "live" | "mocked",
  ): WorkflowRunSnapshot {
    const reviewed = structuredClone(goldenRunV01);
    const updatedAt = new Date(
      Math.max(Date.parse(createdAt), Date.parse(reviewed.updatedAt) + 1),
    ).toISOString();
    const run = cloneRun({
      ...reviewed,
      id: runId,
      status: "extracting_evidence",
      evidenceMode,
      createdAt,
      updatedAt,
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
      scopeDecision: reviewed.scopeDecision,
    });
    if (this.#records.has(run.id)) {
      throw new DuplicateRunError(run.id);
    }
    validateExecutionHistory(run);
    const snapshot = {
      run,
      revision: this.#nextRevision(),
      objectionDispositions: null,
    };
    this.#records.set(run.id, snapshot);
    return this.#cloneSnapshot(snapshot);
  }

  load(runId: string): WorkflowRunSnapshot | null {
    const snapshot = this.#records.get(runId);
    return snapshot === undefined ? null : this.#cloneSnapshot(snapshot);
  }

  save(
    runInput: ResearchRun,
    expectedRevision: string,
    objectionDispositionsInput?: ObjectionDispositionPlan | null,
  ): WorkflowRunSnapshot {
    const run = cloneRun(runInput);
    const stored = this.#records.get(run.id);
    if (stored === undefined) {
      throw new RunNotFoundError(run.id);
    }
    if (stored.revision !== expectedRevision) {
      throw new RevisionConflictError(run.id);
    }
    const objectionDispositions =
      objectionDispositionsInput === undefined
        ? stored.objectionDispositions
        : objectionDispositionsInput === null
          ? null
          : ObjectionDispositionPlanSchema.parse(
              structuredClone(objectionDispositionsInput),
            );
    if (
      stored.objectionDispositions !== null &&
      JSON.stringify(stored.objectionDispositions) !==
        JSON.stringify(objectionDispositions)
    ) {
      throw new InvalidExecutionAttemptError(
        "persisted objection dispositions cannot be replaced or erased",
      );
    }
    if (
      stored.objectionDispositions === null &&
      objectionDispositions !== null &&
      !(
        stored.run.status === "awaiting_objection_dispositions" &&
        run.status === "revising_experiment"
      )
    ) {
      throw new InvalidExecutionAttemptError(
        "objection dispositions may be added only at their checkpoint edge",
      );
    }
    assertAppendOnlyHistory(stored.run, run);
    assertPersistedCheckpoints(stored.run, run);
    validateWorkflowMutation(
      stored.run,
      run,
      objectionDispositions,
    );
    const snapshot = {
      run,
      revision: this.#nextRevision(),
      objectionDispositions,
    };
    this.#records.set(run.id, snapshot);
    return this.#cloneSnapshot(snapshot);
  }

  /** Persists the final result of several already-validated in-memory workflow
   * mutations performed by one coordinator request. */
  saveComposite(
    runInput: ResearchRun,
    expectedRevision: string,
    objectionDispositionsInput?: ObjectionDispositionPlan | null,
  ): WorkflowRunSnapshot {
    const run = cloneRun(runInput);
    const stored = this.#records.get(run.id);
    if (!stored) throw new RunNotFoundError(run.id);
    if (stored.revision !== expectedRevision) throw new RevisionConflictError(run.id);
    const objectionDispositions = objectionDispositionsInput === undefined
      ? stored.objectionDispositions
      : objectionDispositionsInput === null
        ? null
        : ObjectionDispositionPlanSchema.parse(structuredClone(objectionDispositionsInput));
    assertAppendOnlyHistory(stored.run, run);
    assertPersistedCheckpoints(stored.run, run);
    validateExecutionHistory(run);
    const snapshot = { run, revision: this.#nextRevision(), objectionDispositions };
    this.#records.set(run.id, snapshot);
    return this.#cloneSnapshot(snapshot);
  }

  reset(): void {
    this.#records.clear();
  }

  /**
   * Hydrates one already-validated snapshot for a short-lived coordinator.
   * This is intentionally separate from create(): durable records are allowed
   * to resume at any legal workflow state, while new records are still forced
   * to begin as empty drafts.
   */
  hydrate(snapshotInput: WorkflowRunSnapshot): void {
    const snapshot: WorkflowRunSnapshot = {
      run: cloneRun(snapshotInput.run),
      revision: snapshotInput.revision,
      objectionDispositions:
        snapshotInput.objectionDispositions === null
          ? null
          : ObjectionDispositionPlanSchema.parse(
              structuredClone(snapshotInput.objectionDispositions),
            ),
    };
    validateExecutionHistory(snapshot.run);
    if (this.#records.has(snapshot.run.id)) {
      throw new DuplicateRunError(snapshot.run.id);
    }
    this.#records.set(snapshot.run.id, snapshot);
  }

  remove(runId: string): void {
    if (!this.#records.delete(runId)) throw new RunNotFoundError(runId);
  }

  #cloneSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
    return {
      run: cloneRun(snapshot.run),
      revision: snapshot.revision,
      objectionDispositions:
        snapshot.objectionDispositions === null
          ? null
          : ObjectionDispositionPlanSchema.parse(
              structuredClone(snapshot.objectionDispositions),
            ),
    };
  }
}
