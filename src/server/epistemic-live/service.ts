import { randomUUID } from "node:crypto";

import { canonicalSha256 } from "../../contracts";
import { extractRunToken } from "../auth/run-token";
import { getDurableRunCoordinator, RunAccessDeniedError } from "../workflow/durable-coordinator";
import type { WorkflowRunSnapshot } from "../workflow/store";
import {
  EpistemicCompileRequestSchema,
  EpistemicProjectionEnvelopeSchema,
  EpistemicReceiptSchema,
  EpistemicReviewRequestSchema,
  EpistemicLiveSchemaVersion,
  type EpistemicCompileRequest,
  type EpistemicReceipt,
  type EpistemicReviewRequest,
} from "./contracts";
import {
  createDefaultCompileAdapter,
  createDefaultProjectionAdapter,
  snapshotRun,
  type EpistemicCompileAdapter,
  type EpistemicCoordinatorAdapter,
  type EpistemicProjectionAdapter,
} from "./adapters";

export type EpistemicLiveDependencies = {
  coordinator: EpistemicCoordinatorAdapter;
  project: EpistemicProjectionAdapter;
  compile: EpistemicCompileAdapter;
  now?: () => string;
};

export class EpistemicLiveError extends Error {
  constructor(
    readonly code: "invalid_request" | "unauthorized" | "run_not_found" | "stale_projection" | "idempotency_conflict" | "internal_error",
    message: string,
    readonly status: number = code === "unauthorized" || code === "run_not_found" ? 404 : code === "stale_projection" || code === "idempotency_conflict" ? 409 : code === "invalid_request" ? 400 : 500,
  ) {
    super(message);
    this.name = "EpistemicLiveError";
  }
}

type CompileResult = {
  run: WorkflowRunSnapshot;
  projection: unknown;
  projectionHash: string;
  graphHash: string | null;
  build: unknown;
  buildHash: string;
  input: EpistemicCompileRequest;
};

function hash(value: unknown): string {
  try {
    return canonicalSha256(value);
  } catch {
    throw new EpistemicLiveError("internal_error", "The epistemic adapter returned non-canonical data.");
  }
}

function graphHashOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.graphHash === "string" && /^[a-f0-9]{64}$/u.test(record.graphHash)) return record.graphHash;
  if (typeof record.graph === "object" && record.graph !== null) {
    const graph = record.graph as Record<string, unknown>;
    if (typeof graph.graphHash === "string" && /^[a-f0-9]{64}$/u.test(graph.graphHash)) return graph.graphHash;
  }
  return null;
}

function operationInput(input: EpistemicCompileRequest | EpistemicReviewRequest): EpistemicCompileRequest {
  const output: EpistemicCompileRequest = {};
  if (input.appliedChangeIds !== undefined) output.appliedChangeIds = input.appliedChangeIds;
  if (input.operations !== undefined) output.operations = input.operations;
  if (input.branchOperations !== undefined) output.branchOperations = input.branchOperations;
  if (input.expectedProjectionHash !== undefined) output.expectedProjectionHash = input.expectedProjectionHash;
  if (input.expectedGraphHash !== undefined) output.expectedGraphHash = input.expectedGraphHash;
  if (input.idempotencyKey !== undefined) output.idempotencyKey = input.idempotencyKey;
  return output;
}

function idempotencyKey(request: Request, supplied: string | undefined, body: unknown): string {
  const header = request.headers.get("idempotency-key")?.trim();
  const key = header || supplied?.trim();
  // A deterministic fallback keeps retries safe for clients that cannot set headers.
  return key || `body-${hash(body)}`;
}

export class EpistemicLiveService {
  readonly #dependencies: EpistemicLiveDependencies;
  readonly #reviews = new Map<string, { fingerprint: string; response: Record<string, unknown> }>();

  constructor(dependencies: Partial<EpistemicLiveDependencies> = {}) {
    this.#dependencies = {
      coordinator: dependencies.coordinator ?? getDurableRunCoordinator(),
      project: dependencies.project ?? createDefaultProjectionAdapter(),
      compile: dependencies.compile ?? createDefaultCompileAdapter(),
      now: dependencies.now ?? (() => new Date().toISOString()),
    };
  }

  async authorize(runId: string, request: Request): Promise<WorkflowRunSnapshot> {
    if (!runId.trim()) throw new EpistemicLiveError("invalid_request", "runId is required.");
    const token = extractRunToken(request, runId);
    if (!token) throw new EpistemicLiveError("unauthorized", "A valid run token is required.");
    try {
      const snapshot = await this.#dependencies.coordinator.authorize(runId, token);
      if (snapshot.run.id !== runId) throw new EpistemicLiveError("run_not_found", "Run not found.");
      return snapshot;
    } catch (error) {
      if (error instanceof EpistemicLiveError) throw error;
      if (error instanceof RunAccessDeniedError) throw new EpistemicLiveError("unauthorized", "Run not found.");
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("not found") || message.includes("unavailable") || message.includes("invalid")) {
        throw new EpistemicLiveError("run_not_found", "Run not found.");
      }
      throw error;
    }
  }

  async project(runId: string, request: Request) {
    const snapshot = await this.authorize(runId, request);
    const projection = await this.#dependencies.project(snapshotRun(snapshot));
    const projectionHash = hash(projection);
    return EpistemicProjectionEnvelopeSchema.parse({
      schemaVersion: EpistemicLiveSchemaVersion,
      runId,
      revision: snapshot.revision,
      projection,
      projectionHash,
    });
  }

  async compile(runId: string, request: Request, body: unknown): Promise<CompileResult> {
    const input = EpistemicCompileRequestSchema.parse(body);
    const snapshot = await this.authorize(runId, request);
    const run = snapshotRun(snapshot);
    const projection = await this.#dependencies.project(run);
    const projectionHash = hash(projection);
    this.checkStale(input.expectedProjectionHash, projectionHash, undefined, null);
    const build = await this.#dependencies.compile(run, input, projection);
    const compiledGraphHash = graphHashOf(build) ?? graphHashOf(projection);
    if (input.expectedGraphHash && input.expectedGraphHash !== (compiledGraphHash ?? projectionHash)) {
      throw new EpistemicLiveError("stale_projection", "The epistemic graph changed; recompile before continuing.");
    }
    return {
      run: snapshot,
      projection,
      projectionHash,
      graphHash: compiledGraphHash,
      build,
      buildHash: hash(build),
      input,
    };
  }

  async review(runId: string, request: Request, body: unknown) {
    const parsed = EpistemicReviewRequestSchema.parse(body);
    // Authenticate before consulting the idempotency cache; a key must never
    // become a side channel for a private review receipt.
    await this.authorize(runId, request);
    const key = idempotencyKey(request, parsed.idempotencyKey, body);
    const fingerprint = hash({ runId, key, body: parsed });
    const prior = this.#reviews.get(`${runId}:${key}`);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new EpistemicLiveError("idempotency_conflict", "Idempotency key was already used for a different review.");
      return structuredClone(prior.response);
    }
    const compiled = await this.compile(runId, request, operationInput(parsed));
    const expected = parsed.expectedGraphHash ?? parsed.expectedProjectionHash;
    const actual = parsed.expectedGraphHash ? (compiled.graphHash ?? compiled.projectionHash) : compiled.projectionHash;
    if (expected !== actual) {
      throw new EpistemicLiveError("stale_projection", "The epistemic projection changed; recompile before reviewing.");
    }
    const payload = {
      schemaVersion: EpistemicLiveSchemaVersion,
      receiptVersion: "epistemic-live.receipt.v1" as const,
      runId,
      revision: compiled.run.revision,
      action: parsed.action,
      declaredActor: parsed.declaredActor,
      rationale: parsed.rationale,
      idempotencyKey: key,
      projectionHash: compiled.projectionHash,
      buildHash: compiled.buildHash,
      graphHash: compiled.graphHash,
      evidenceUpdateStatus: parsed.action === "approve_evidence_update" ? "merged_with_blockers" as const : "rejected" as const,
      scientificDecisionApproved: false as const,
    };
    const receipt = EpistemicReceiptSchema.parse({ ...payload, receiptHash: hash(payload) }) as EpistemicReceipt;
    const response = {
      runId,
      revision: compiled.run.revision,
      projection: compiled.projection,
      projectionHash: compiled.projectionHash,
      build: compiled.build,
      buildHash: compiled.buildHash,
      receipt,
      evidenceUpdateStatus: receipt.evidenceUpdateStatus,
      scientificDecisionApproved: false as const,
    };
    this.#reviews.set(`${runId}:${key}`, { fingerprint, response });
    return structuredClone(response);
  }

  private checkStale(expectedProjectionHash: string | undefined, projectionHash: string, expectedGraphHash: string | undefined, graphHash: string | null) {
    if (expectedProjectionHash && expectedProjectionHash !== projectionHash) throw new EpistemicLiveError("stale_projection", "The epistemic projection changed; recompile before continuing.");
    if (expectedGraphHash && expectedGraphHash !== (graphHash ?? projectionHash)) throw new EpistemicLiveError("stale_projection", "The epistemic graph changed; recompile before continuing.");
  }
}

let defaultService: EpistemicLiveService | undefined;
export function getEpistemicLiveService(): EpistemicLiveService {
  return defaultService ??= new EpistemicLiveService();
}

export function createEpistemicLiveService(dependencies: Partial<EpistemicLiveDependencies> = {}): EpistemicLiveService {
  return new EpistemicLiveService(dependencies);
}

type EpistemicErrorContext = { request?: Request; operation?: string; durationMs?: number };

export function epistemicErrorResponse(error: unknown, context: EpistemicErrorContext = {}): Response {
  const known = error instanceof EpistemicLiveError;
  const status = known ? error.status : error instanceof Error && error.name === "ZodError" ? 400 : 500;
  const code = known ? error.code : status === 400 ? "invalid_request" : "internal_error";
  const message = status >= 500 ? "The epistemic request could not be completed." : error instanceof Error ? error.message : "Invalid request.";
  const supplied = context.request?.headers.get("x-request-id")?.trim();
  const correlationId = supplied && /^[A-Za-z0-9._:-]{8,128}$/u.test(supplied) ? supplied : randomUUID();
  let runIdHash: string | undefined;
  try {
    const match = context.request ? new URL(context.request.url).pathname.match(/\/api\/runs\/([^/]+)/u) : null;
    runIdHash = match ? canonicalSha256(decodeURIComponent(match[1])).slice(0, 16) : undefined;
  } catch {
    runIdHash = undefined;
  }
  const retryable = status === 409 || status >= 500;
  console.error(JSON.stringify({
    correlationId,
    operation: context.operation ?? "epistemic_route",
    runIdHash,
    errorClass: error instanceof Error ? error.name : "UnknownError",
    code,
    httpStatus: status,
    retryable,
    ...(context.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(context.durationMs)) }),
  }));
  return Response.json(
    { error: { code, message, retryable, correlationId } },
    { status, headers: { "cache-control": "private, no-store", "x-correlation-id": correlationId } },
  );
}

export async function parseEpistemicJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!mediaType.includes("application/json")) throw new EpistemicLiveError("invalid_request", "Expected an application/json request.");
  try { return await request.json(); } catch { throw new EpistemicLiveError("invalid_request", "Request body must be valid JSON."); }
}
