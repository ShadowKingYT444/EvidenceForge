import { z } from "zod";

import { extractRunToken, runTokenCookie } from "../auth/run-token";
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

export function liveRouteError(error: unknown): Response {
  if (!process.env.RENDER) {
    console.error("EvidenceForge local route error", error);
  }
  const status =
    error instanceof RunAccessDeniedError ? 404 :
      error instanceof RunNotFoundError ? 404 :
        error instanceof RevisionConflictError ? 409 :
          error instanceof z.ZodError ? 400 : 500;
  const code =
    status === 404 ? "run_not_found" :
      status === 409 ? "revision_conflict" :
        status === 400 ? "invalid_request" : "internal_error";
  const message =
    status === 500
      ? "The investigation request could not be completed."
      : error instanceof Error ? error.message : "Invalid request";
  return Response.json(
    { error: { code, message, retryable: status >= 500 || status === 409 } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

export async function createLiveRun(request: Request): Promise<Response> {
  try {
    const body = CreateRunRequestSchema.parse(await json(request));
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
    return liveRouteError(error);
  }
}

export async function getLiveRun(request: Request, context: Context): Promise<Response> {
  try {
    const runId = await routeRunId(context);
    const snapshot = await getDurableRunCoordinator().authorize(runId, accessToken(request, runId));
    return Response.json(snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function getLiveProgress(request: Request, context: Context): Promise<Response> {
  try {
    const runId = await routeRunId(context);
    const progress = await getDurableRunCoordinator().progress(runId, accessToken(request, runId));
    return Response.json(progress, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function continueLiveRun(request: Request, context: Context): Promise<Response> {
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
    return liveRouteError(error);
  }
}

export async function checkpointLiveRun(request: Request, context: Context): Promise<Response> {
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
    return liveRouteError(error);
  }
}

export async function exportLiveRun(request: Request, context: Context): Promise<Response> {
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
    return liveRouteError(error);
  }
}

export async function deleteLiveRun(request: Request, context: Context): Promise<Response> {
  try {
    const runId = await routeRunId(context);
    const body = z.object({ expectedRevision: z.string().min(1) }).strict().parse(await json(request));
    await getDurableRunCoordinator().delete(runId, body.expectedRevision, accessToken(request, runId));
    return new Response(null, { status: 204 });
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function getLiveTimeline(request: Request, context: Context): Promise<Response> {
  try {
    const runId = await routeRunId(context);
    const timeline = await getDurableRunCoordinator().timeline(runId, accessToken(request, runId));
    return Response.json(timeline, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error);
  }
}
