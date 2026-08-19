import { ResearchRunSchema, type ResearchRun } from "../../contracts";
import {
  InvalidExecutionAttemptError,
  ObjectionDispositionPlanSchema,
  validateExecutionHistory,
  validateWorkflowMutation,
  type ObjectionDispositionPlan,
} from "./state-machine";
import {
  DuplicateRunError,
  RevisionConflictError,
  RunNotFoundError,
  type WorkflowRunSnapshot,
  type WorkflowRunStore,
} from "./store";

/** Minimal pg Pool shape, kept structural so the core package remains usable
 * in tests without installing or connecting a database. `pg.Pool` satisfies it. */
export interface PgPoolLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

type Row = {
  run_id: string;
  snapshot: unknown;
  revision: string | number;
  objection_dispositions: unknown;
  packet_draft?: unknown;
};

function cloneRun(input: ResearchRun): ResearchRun {
  return ResearchRunSchema.parse(structuredClone(input));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function decode(row: Row): WorkflowRunSnapshot {
  const run = ResearchRunSchema.parse(row.snapshot);
  validateExecutionHistory(run);
  return {
    run,
    revision: String(row.revision),
    objectionDispositions:
      row.objection_dispositions === null
        ? null
        : ObjectionDispositionPlanSchema.parse(structuredClone(row.objection_dispositions)),
  };
}

function prefix<T>(before: readonly T[], after: readonly T[]): boolean {
  return after.length >= before.length && before.every((v, i) => JSON.stringify(v) === JSON.stringify(after[i]));
}

function assertMutation(stored: ResearchRun, candidate: ResearchRun): void {
  if (!prefix(stored.executions, candidate.executions) || !prefix(stored.errors, candidate.errors)) {
    throw new InvalidExecutionAttemptError("stored execution and error history cannot be edited, reordered, or erased");
  }
  for (const field of ["scopeDecision", "packet", "objectionDispositionDecision", "revision", "finalDecision"] as const) {
    if (stored[field] !== null && JSON.stringify(stored[field]) !== JSON.stringify(candidate[field])) {
      throw new InvalidExecutionAttemptError(`persisted ${field} checkpoint cannot be replaced or erased`);
    }
  }
  if (stored.packet !== null && (JSON.stringify(stored.sources) !== JSON.stringify(candidate.sources) || JSON.stringify(stored.chunks) !== JSON.stringify(candidate.chunks))) {
    throw new InvalidExecutionAttemptError("frozen packet sources and chunks cannot be edited after approval");
  }
}

/** Postgres JSONB aggregate store. The migration creates a bigint CAS revision;
 * snapshots are validated on both write and read to fail closed on corruption. */
export class PostgresWorkflowRunStore implements WorkflowRunStore {
  readonly capabilities = Object.freeze({ scope: "postgres" as const, diskDurable: true, multiProcessSafe: true });
  constructor(private readonly pool: PgPoolLike) {}

  async createWithOptions(input: ResearchRun, options?: { accessTokenDigest?: string }): Promise<WorkflowRunSnapshot> {
    const run = cloneRun(input);
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO workflow_runs (run_id, snapshot, objection_dispositions, access_token_digest) VALUES ($1, $2::jsonb, NULL, $3) RETURNING run_id, snapshot, revision, objection_dispositions`,
        [run.id, JSON.stringify(run), options?.accessTokenDigest ?? null],
      );
      if (!result.rows[0]) throw new DuplicateRunError(run.id);
      return decode(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateRunError(run.id);
      throw error;
    }
  }

  async create(input: ResearchRun, options?: { accessTokenDigest?: string }): Promise<WorkflowRunSnapshot> {
    const run = cloneRun(input);
    if (run.status !== "draft" || run.claims.length || run.sources.length || run.chunks.length || run.executions.length || run.errors.length || run.scopeDecision !== null || run.packet !== null || run.evidenceCards.length || run.conclusions.length || run.researchGaps.length || run.selectedGapId !== null || run.experiment !== null || run.review !== null || run.objectionDispositionDecision !== null || run.revision !== null || run.finalDecision !== null) {
      throw new InvalidExecutionAttemptError("new durable records must start as a history-free draft");
    }
    validateExecutionHistory(run);
    return this.createWithOptions(run, options);
  }

  async authorize(runId: string, accessTokenDigest: string): Promise<WorkflowRunSnapshot | null> {
    const result = await this.pool.query<Row>(`SELECT run_id, snapshot, revision, objection_dispositions FROM workflow_runs WHERE run_id = $1 AND access_token_digest = $2`, [runId, accessTokenDigest]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async delete(runId: string, expectedRevision: string, accessTokenDigest?: string): Promise<void> {
    const predicate = accessTokenDigest === undefined ? "" : " AND access_token_digest = $3";
    const values = accessTokenDigest === undefined ? [runId, expectedRevision] : [runId, expectedRevision, accessTokenDigest];
    const result = await this.pool.query(`DELETE FROM workflow_runs WHERE run_id = $1 AND revision::text = $2${predicate}`, values);
    if (result.rowCount === 1) return;
    const existing = await this.load(runId);
    if (!existing) throw new RunNotFoundError(runId);
    throw new RevisionConflictError(runId);
  }

  async getPacketDraft(runId: string): Promise<unknown | null> {
    const result = await this.pool.query<{ packet_draft: unknown }>(`SELECT packet_draft FROM workflow_runs WHERE run_id = $1`, [runId]);
    return result.rows[0] ? structuredClone(result.rows[0].packet_draft) : null;
  }

  async savePacketDraft(runId: string, expectedRevision: string, draft: unknown): Promise<{ revision: string; draft: unknown }> {
    const result = await this.pool.query<{ revision: string; packet_draft: unknown }>(`UPDATE workflow_runs SET packet_draft = $3::jsonb, revision = revision + 1, updated_at = now() WHERE run_id = $1 AND revision::text = $2 RETURNING revision, packet_draft`, [runId, expectedRevision, JSON.stringify(draft)]);
    if (!result.rows[0]) {
      const existing = await this.load(runId);
      if (!existing) throw new RunNotFoundError(runId);
      throw new RevisionConflictError(runId);
    }
    return { revision: String(result.rows[0].revision), draft: structuredClone(result.rows[0].packet_draft) };
  }

  async load(runId: string): Promise<WorkflowRunSnapshot | null> {
    const result = await this.pool.query<Row>(`SELECT run_id, snapshot, revision, objection_dispositions FROM workflow_runs WHERE run_id = $1`, [runId]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async save(input: ResearchRun, expectedRevision: string, dispositionsInput?: ObjectionDispositionPlan | null): Promise<WorkflowRunSnapshot> {
    const run = cloneRun(input);
    const prior = await this.load(run.id);
    if (!prior) throw new RunNotFoundError(run.id);
    if (prior.revision !== expectedRevision) throw new RevisionConflictError(run.id);
    const dispositions = dispositionsInput === undefined ? prior.objectionDispositions : dispositionsInput === null ? null : ObjectionDispositionPlanSchema.parse(structuredClone(dispositionsInput));
    if (prior.objectionDispositions !== null && JSON.stringify(prior.objectionDispositions) !== JSON.stringify(dispositions)) throw new InvalidExecutionAttemptError("persisted objection dispositions cannot be replaced or erased");
    if (prior.objectionDispositions === null && dispositions !== null && !(prior.run.status === "awaiting_objection_dispositions" && run.status === "revising_experiment")) throw new InvalidExecutionAttemptError("objection dispositions may be added only at their checkpoint edge");
    assertMutation(prior.run, run);
    validateWorkflowMutation(prior.run, run, dispositions);
    const result = await this.pool.query<Row>(`UPDATE workflow_runs SET snapshot = $2::jsonb, objection_dispositions = $3::jsonb, revision = revision + 1, updated_at = now() WHERE run_id = $1 AND revision::text = $4 RETURNING run_id, snapshot, revision, objection_dispositions`, [run.id, JSON.stringify(run), dispositions === null ? null : JSON.stringify(dispositions), expectedRevision]);
    if (!result.rows[0]) throw new RevisionConflictError(run.id);
    return decode(result.rows[0]);
  }

  async saveComposite(input: ResearchRun, expectedRevision: string, dispositionsInput?: ObjectionDispositionPlan | null): Promise<WorkflowRunSnapshot> {
    const run = cloneRun(input);
    const prior = await this.load(run.id);
    if (!prior) throw new RunNotFoundError(run.id);
    if (prior.revision !== expectedRevision) throw new RevisionConflictError(run.id);
    const dispositions = dispositionsInput === undefined ? prior.objectionDispositions : dispositionsInput === null ? null : ObjectionDispositionPlanSchema.parse(structuredClone(dispositionsInput));
    assertMutation(prior.run, run);
    validateExecutionHistory(run);
    const result = await this.pool.query<Row>(`UPDATE workflow_runs SET snapshot = $2::jsonb, objection_dispositions = $3::jsonb, revision = revision + 1, updated_at = now() WHERE run_id = $1 AND revision::text = $4 RETURNING run_id, snapshot, revision, objection_dispositions`, [run.id, JSON.stringify(run), dispositions === null ? null : JSON.stringify(dispositions), expectedRevision]);
    if (!result.rows[0]) throw new RevisionConflictError(run.id);
    return decode(result.rows[0]);
  }
}
