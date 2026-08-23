import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { extractRunToken, runTokenCookie } from "../auth/run-token";
import { assertLiveWorkflowReady, EnvironmentValidationError } from "../environment";
import {
  CreateRunRequestSchema,
  ContinueRunRequestSchema,
} from "./run-api";
import {
  getDurableRunCoordinator,
  RunAccessDeniedError,
} from "./durable-coordinator";
import {
  RevisionConflictError,
  RunNotFoundError,
} from "./store";

type Context = { params: Promise<{ runId: string }> };

const checkpointIntentSchema = z.discriminatedUnion("checkpoint", [
  z.object({
    checkpoint: z.literal("scope"),
    expectedRevision: z.string().min(1),
    decision: z.object({
      declaredActor: z.string().min(1).optional(),
      rationale: z.string().min(1).optional(),
    }).passthrough().default({}),
  }).strict(),
  z.object({
    checkpoint: z.literal("packet_freeze"),
    expectedRevision: z.string().min(1),
    decision: z.object({
      declaredActor: z.string().min(1).optional(),
      rationale: z.string().min(1).optional(),
    }).passthrough().default({}),
  }).strict(),
  z.object({
    checkpoint: z.literal("objection_dispositions"),
    expectedRevision: z.string().min(1),
    decision: z.any(),
    dispositions: z.array(z.object({
      objectionId: z.string().min(1),
      disposition: z.enum(["accepted", "rejected", "unresolved"]),
      basis: z.string().min(1),
    }).strict()),
  }).strict(),
  z.object({
    checkpoint: z.literal("final"),
    expectedRevision: z.string().min(1),
    decision: z.object({
      choice: z.enum(["approve", "reject"]),
      declaredActor: z.string().min(1),
      rationale: z.string().min(1),
    }).strict(),
  }).strict(),
]);

async function routeRunId(context: Context): Promise<string> {
  return (await context.params).runId;
}

async function json(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new z.ZodError([{ code: "custom", path: [], message: "Expected an application/json request" }]);
  }
  return request.json();
}

function accessToken(request: Request, runId: string): string {
  const token = extractRunToken(request, runId);
  if (!token) throw new RunAccessDeniedError();
  return token;
}

export class ProviderRateLimitError extends Error {
  readonly code = "provider_rate_limited";
  constructor() { super("The upstream provider is rate limited."); this.name = "ProviderRateLimitError"; }
}

export class UpstreamProviderError extends Error {
  readonly code = "upstream_provider_failure";
  constructor() { super("The upstream provider could not complete the request."); this.name = "UpstreamProviderError"; }
}

export class InvalidRequestError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) { super(message); this.name = "InvalidRequestError"; }
}

export class WorkflowStateConflictError extends Error {
  readonly code = "workflow_state_conflict";
  constructor(message: string) { super(message); this.name = "WorkflowStateConflictError"; }
}

type ErrorContext = { request?: Request; operation?: string; durationMs?: number };

function correlationId(request?: Request): string {
  const supplied = request?.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/u.test(supplied) ? supplied : randomUUID();
}

function hashedRunId(request?: Request): string | undefined {
  if (!request) return undefined;
  try {
    const match = new URL(request.url).pathname.match(/\/api\/runs\/([^/]+)/u);
    return match ? createHash("sha256").update(decodeURIComponent(match[1])).digest("hex").slice(0, 16) : undefined;
  } catch { return undefined; }
}

export function liveRouteError(error: unknown, context: ErrorContext = {}): Response {
  const status =
    error instanceof RunAccessDeniedError ? 404 :
      error instanceof RunNotFoundError ? 404 :
          error instanceof RevisionConflictError ? 409 :
          error instanceof WorkflowStateConflictError ? 409 :
          error instanceof z.ZodError || error instanceof InvalidRequestError ? 400 :
            error instanceof EnvironmentValidationError ? 503 :
              error instanceof ProviderRateLimitError ? 429 :
                error instanceof UpstreamProviderError ? 502 : 500;
  const code =
    status === 404 ? "run_not_found" :
      status === 409 ? error instanceof WorkflowStateConflictError ? "workflow_state_conflict" : "revision_conflict" :
        status === 400 ? "invalid_request" :
          status === 503 ? "runtime_configuration_invalid" :
            status === 429 ? "provider_rate_limited" :
              status === 502 ? "upstream_provider_failure" : "internal_error";
  const message =
    status === 404 ? "This investigation is unavailable. It may have expired or the server may have restarted; use a recovery link or start again." :
      status === 500 ? "The investigation request could not be completed." :
        status === 503 ? "Live investigations are not configured on this server." :
          error instanceof Error ? error.message : "Invalid request";
  const requestId = correlationId(context.request);
  const retryable = status === 409 || status === 429 || status >= 500;
  const errorClass =
    error instanceof RunAccessDeniedError ? "RunAccessDeniedError" :
      error instanceof RunNotFoundError ? "RunNotFoundError" :
        error instanceof RevisionConflictError ? "RevisionConflictError" :
          error instanceof WorkflowStateConflictError ? "WorkflowStateConflictError" :
          error instanceof z.ZodError ? "ZodError" :
            error instanceof InvalidRequestError ? "InvalidRequestError" :
            error instanceof EnvironmentValidationError ? "EnvironmentValidationError" :
              error instanceof ProviderRateLimitError ? "ProviderRateLimitError" :
                error instanceof UpstreamProviderError ? "UpstreamProviderError" : "InternalError";
  console.error(JSON.stringify({
    correlationId: requestId,
    operation: context.operation ?? "workflow_route",
    runIdHash: hashedRunId(context.request),
    errorClass,
    code,
    httpStatus: status,
    retryable,
    ...(context.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(context.durationMs)) }),
  }));
  return Response.json(
    { error: { code, message, retryable, correlationId: requestId } },
    { status, headers: { "cache-control": "private, no-store", "x-correlation-id": requestId } },
  );
}

export async function createLiveRun(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const body = CreateRunRequestSchema.parse(await json(request));
    assertLiveWorkflowReady();
    const created = await getDurableRunCoordinator().create(body.intake);
    const runId = created.snapshot.run.id;
    const recoveryUrl = `/runs/${encodeURIComponent(runId)}/access?token=${encodeURIComponent(created.accessToken)}`;
    return Response.json(
      {
        run: created.snapshot.run,
        revision: created.snapshot.revision,
        recoveryUrl,
      },
      {
        status: 201,
        headers: {
          "cache-control": "private, no-store",
          "set-cookie": runTokenCookie(created.accessToken, { runId }),
          location: `/runs/${encodeURIComponent(runId)}`,
        },
      },
    );
  } catch (error) {
    return liveRouteError(error, { request, operation: "create_run", durationMs: Date.now() - startedAt });
  }
}

export async function getLiveRun(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const snapshot = await getDurableRunCoordinator().authorize(runId, accessToken(request, runId));
    return Response.json(snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error, { request, operation: "get_run", durationMs: Date.now() - startedAt });
  }
}

export async function getLiveProgress(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const progress = await getDurableRunCoordinator().progress(runId, accessToken(request, runId));
    return Response.json(progress, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error, { request, operation: "get_progress", durationMs: Date.now() - startedAt });
  }
}

export async function continueLiveRun(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const body = ContinueRunRequestSchema.parse(await json(request));
    const result = await getDurableRunCoordinator().continue(
      runId,
      body.expectedRevision,
      accessToken(request, runId),
    );
    return Response.json(
      {
        advanced: result.value.advanced,
        snapshot: result.snapshot,
        failure: result.value.failure,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error, { request, operation: "continue_run", durationMs: Date.now() - startedAt });
  }
}

export async function checkpointLiveRun(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const token = accessToken(request, runId);
    const body = checkpointIntentSchema.parse(await json(request));
    const coordinator = getDurableRunCoordinator();
    const result = body.checkpoint === "scope"
      ? await coordinator.approveScope(runId, body.expectedRevision, token, body.decision)
      : body.checkpoint === "packet_freeze"
        ? await coordinator.freezePacket(runId, body.expectedRevision, token, body.decision)
        : body.checkpoint === "objection_dispositions"
          ? await coordinator.submitObjections(runId, body.expectedRevision, token, body.decision, body.dispositions)
          : await coordinator.decideFinal(runId, body.expectedRevision, token, body.decision);
    return Response.json(result.snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error, { request, operation: "checkpoint_run", durationMs: Date.now() - startedAt });
  }
}

export async function exportLiveRun(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const payload = await getDurableRunCoordinator().export(runId, accessToken(request, runId));
    return new Response(payload, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${runId}.json"`,
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return liveRouteError(error, { request, operation: "export_run", durationMs: Date.now() - startedAt });
  }
}

export async function deleteLiveRun(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const body = z.object({ expectedRevision: z.string().min(1) }).strict().parse(await json(request));
    await getDurableRunCoordinator().delete(runId, body.expectedRevision, accessToken(request, runId));
    return new Response(null, { status: 204 });
  } catch (error) {
    return liveRouteError(error, { request, operation: "delete_run", durationMs: Date.now() - startedAt });
  }
}

export async function getLiveTimeline(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const runId = await routeRunId(context);
    const timeline = await getDurableRunCoordinator().timeline(runId, accessToken(request, runId));
    return Response.json(timeline, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error, { request, operation: "get_timeline", durationMs: Date.now() - startedAt });
  }
}
