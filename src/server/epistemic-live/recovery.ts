import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ResearchRunSchema, canonicalSha256, canonicalizeJson, type ResearchRun } from "../../contracts";
import { extractRunToken } from "../auth/run-token";
import { getDurableRunCoordinator } from "../workflow/durable-coordinator";
import type { WorkflowRunSnapshot } from "../workflow/store";

export const RECOVERY_SCHEMA_VERSION = "evidenceforge.recovery.v1" as const;
export const MAX_RECOVERY_BYTES = 1_024 * 1_024;

type RecoveryPayload = {
  run: ResearchRun;
  revision: string;
  objectionDispositions: unknown;
};

export type RecoveryEnvelope = {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  runId: string;
  revision: string;
  issuedAt: string;
  payloadHash: string;
  payload: RecoveryPayload;
  signature: string;
};

export const RecoveryEnvelopeSchema = z.object({
  schemaVersion: z.literal(RECOVERY_SCHEMA_VERSION),
  runId: z.string().min(1).max(256),
  revision: z.string().min(1).max(256),
  issuedAt: z.string().datetime({ offset: true }),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  payload: z.object({ run: z.unknown(), revision: z.string().min(1).max(256), objectionDispositions: z.unknown() }).strict(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export interface RecoveryCoordinatorAdapter {
  authorize(runId: string, accessToken: string): Promise<WorkflowRunSnapshot>;
}

export interface RecoveryImportAdapter {
  importSnapshot?(snapshot: WorkflowRunSnapshot): Promise<unknown> | unknown;
}

export class RecoveryError extends Error {
  constructor(
    readonly code: "invalid_request" | "unauthorized" | "run_not_found" | "request_too_large" | "tampered_recovery" | "internal_error",
    message: string,
    readonly status = code === "request_too_large" ? 413 : code === "unauthorized" || code === "run_not_found" ? 404 : code === "tampered_recovery" ? 422 : code === "invalid_request" ? 400 : 500,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

function recoverySecret(): string {
  const configured = process.env.RECOVERY_HMAC_SECRET?.trim() || process.env.RUN_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" && process.env.RENDER) throw new RecoveryError("internal_error", "RECOVERY_HMAC_SECRET is required in production.");
  return "evidenceforge-local-development-recovery-secret";
}

function signingPayload(envelope: Pick<RecoveryEnvelope, "schemaVersion" | "runId" | "revision" | "issuedAt" | "payloadHash">) {
  return {
    schemaVersion: envelope.schemaVersion,
    runId: envelope.runId,
    revision: envelope.revision,
    issuedAt: envelope.issuedAt,
    payloadHash: envelope.payloadHash,
  };
}

function signatureFor(envelope: Pick<RecoveryEnvelope, "schemaVersion" | "runId" | "revision" | "issuedAt" | "payloadHash">, secret: string): string {
  return createHmac("sha256", secret).update(canonicalizeJson(signingPayload(envelope)), "utf8").digest("hex");
}

function validSignature(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRecoveryEnvelope(snapshot: WorkflowRunSnapshot, options: { issuedAt?: string; secret?: string } = {}): RecoveryEnvelope {
  const payload: RecoveryPayload = {
    run: ResearchRunSchema.parse(structuredClone(snapshot.run)),
    revision: snapshot.revision,
    objectionDispositions: structuredClone(snapshot.objectionDispositions),
  };
  const unsigned = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    runId: payload.run.id,
    revision: snapshot.revision,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    payloadHash: canonicalSha256(payload),
    payload,
  };
  return { ...unsigned, signature: signatureFor(unsigned, options.secret ?? recoverySecret()) };
}
export const signRecoveryEnvelope = createRecoveryEnvelope;
export function exportRecoveryEnvelope(envelope: RecoveryEnvelope): string { return canonicalizeJson(envelope); }

export function verifyRecoveryEnvelope(value: unknown, options: { secret?: string } = {}): RecoveryEnvelope {
  // parseEnvelope performs the public schema and run checks; this local re-check permits deterministic tests with an injected key.
  const candidate = parseEnvelopeWithoutSignature(value);
  const secret = options.secret ?? recoverySecret();
  if (!validSignature(signatureFor(candidate, secret), candidate.signature)) throw new RecoveryError("tampered_recovery", "Recovery signature is invalid.");
  return candidate;
}
export const importRecoveryEnvelope = verifyRecoveryEnvelope;

function parseEnvelopeWithoutSignature(value: unknown): RecoveryEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RecoveryError("invalid_request", "Recovery envelope must be a JSON object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== RECOVERY_SCHEMA_VERSION || typeof candidate.runId !== "string" || typeof candidate.revision !== "string" || typeof candidate.issuedAt !== "string" || typeof candidate.payloadHash !== "string" || typeof candidate.signature !== "string" || typeof candidate.payload !== "object" || candidate.payload === null || Array.isArray(candidate.payload)) throw new RecoveryError("invalid_request", "Recovery envelope schema is invalid.");
  if (!Number.isFinite(Date.parse(candidate.issuedAt))) throw new RecoveryError("invalid_request", "Recovery issuedAt must be an ISO timestamp.");
  const payload = candidate.payload as Record<string, unknown>;
  if (!Object.hasOwn(payload, "objectionDispositions")) throw new RecoveryError("invalid_request", "Recovery payload schema is invalid.");
  let run: ResearchRun;
  try { run = ResearchRunSchema.parse(payload.run); } catch { throw new RecoveryError("tampered_recovery", "Recovery run failed contract validation."); }
  const typed: RecoveryEnvelope = { schemaVersion: RECOVERY_SCHEMA_VERSION, runId: candidate.runId, revision: candidate.revision, issuedAt: candidate.issuedAt, payloadHash: candidate.payloadHash, payload: { run, revision: typeof payload.revision === "string" ? payload.revision : "", objectionDispositions: structuredClone(payload.objectionDispositions) }, signature: candidate.signature };
  if (typed.payload.run.id !== typed.runId || typed.payload.revision !== typed.revision || typed.payload.revision === "") throw new RecoveryError("tampered_recovery", "Recovery identifiers do not match the signed payload.");
  if (!/^[a-f0-9]{64}$/u.test(typed.payloadHash) || canonicalSha256(typed.payload) !== typed.payloadHash) throw new RecoveryError("tampered_recovery", "Recovery payload hash does not match.");
  return typed;
}

export function recoverySnapshot(envelope: RecoveryEnvelope): WorkflowRunSnapshot {
  return { run: structuredClone(envelope.payload.run), revision: envelope.payload.revision, objectionDispositions: structuredClone(envelope.payload.objectionDispositions) as WorkflowRunSnapshot["objectionDispositions"] };
}

export class RecoveryService {
  constructor(
    private readonly coordinator: RecoveryCoordinatorAdapter,
    private readonly importer: RecoveryImportAdapter = {},
  ) {}

  async exportRun(runId: string, request: Request): Promise<RecoveryEnvelope> {
    const token = extractRunToken(request, runId);
    if (!token) throw new RecoveryError("unauthorized", "A valid run token is required.");
    let snapshot: WorkflowRunSnapshot;
    try { snapshot = await this.coordinator.authorize(runId, token); } catch { throw new RecoveryError("run_not_found", "Run not found."); }
    return createRecoveryEnvelope(snapshot);
  }

  async importBytes(bytes: Uint8Array | string): Promise<unknown> {
    const size = typeof bytes === "string" ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength;
    if (size > MAX_RECOVERY_BYTES) throw new RecoveryError("request_too_large", "Recovery import exceeds the maximum size.");
    let body: unknown;
    try { body = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)); } catch { throw new RecoveryError("invalid_request", "Recovery import must be valid JSON."); }
    const envelope = verifyRecoveryEnvelope(body);
    const snapshot = recoverySnapshot(envelope);
    const imported = await this.importer.importSnapshot?.(snapshot);
    return imported === undefined ? { imported: true, run: snapshot.run, revision: snapshot.revision, payloadHash: envelope.payloadHash } : imported;
  }
}

let defaultRecoveryService: RecoveryService | undefined;
export function getRecoveryService(): RecoveryService {
  const coordinator = getDurableRunCoordinator();
  return defaultRecoveryService ??= new RecoveryService(coordinator, {
    importSnapshot: (snapshot) => coordinator.importSnapshot(snapshot),
  });
}

type RecoveryErrorContext = { request?: Request; operation?: string; durationMs?: number };

export function recoveryErrorResponse(error: unknown, context: RecoveryErrorContext = {}): Response {
  const known = error instanceof RecoveryError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "internal_error";
  const supplied = context.request?.headers.get("x-request-id")?.trim();
  const correlationId = supplied && /^[A-Za-z0-9._:-]{8,128}$/u.test(supplied) ? supplied : randomUUID();
  let runIdHash: string | undefined;
  try {
    const match = context.request ? new URL(context.request.url).pathname.match(/\/api\/runs\/([^/]+)/u) : null;
    runIdHash = match ? canonicalSha256(decodeURIComponent(match[1])).slice(0, 16) : undefined;
  } catch {
    runIdHash = undefined;
  }
  console.error(JSON.stringify({
    correlationId,
    operation: context.operation ?? "recovery_route",
    runIdHash,
    errorClass: error instanceof Error ? error.name : "UnknownError",
    code,
    httpStatus: status,
    retryable: status >= 500,
    ...(context.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(context.durationMs)) }),
  }));
  return Response.json(
    { error: { code, message: status >= 500 ? "Recovery request could not be completed." : error instanceof Error ? error.message : "Invalid recovery request.", retryable: status >= 500, correlationId } },
    { status, headers: { "cache-control": "private, no-store", "x-correlation-id": correlationId } },
  );
}

export function recoveryResponse(envelope: RecoveryEnvelope): Response {
  const body = canonicalizeJson(envelope);
  return new Response(body, { headers: { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${envelope.runId}.recovery.json"`, "x-content-type-options": "nosniff" } });
}
