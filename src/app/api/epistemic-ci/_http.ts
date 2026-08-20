import { canonicalSha256 } from "@/contracts";
import {
  CompileInputSchema,
  EpistemicChangeSchema,
  EPISTEMIC_CI_SCHEMA_VERSION,
  canonicalBuildHash,
  compileEpistemicBuild,
  exportEpistemicBuild,
  type EpistemicBuild,
} from "@/epistemic-ci";
import { z } from "zod";

const NO_STORE_HEADERS = { "cache-control": "no-store" };

export const ReviewInputSchema = z
  .object({
    appliedChangeIds: z.array(EpistemicChangeSchema.shape.id),
    expectedGraphHash: z.string().regex(/^[a-f0-9]{64}$/u),
    action: z.enum(["approve_evidence_update", "reject_evidence_update"]),
    declaredActor: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(4000),
  })
  .strict();

export type ReviewInput = z.infer<typeof ReviewInputSchema>;

type ErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_SEQUENCE"
  | "STALE_GRAPH"
  | "INTERNAL_ERROR";

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}
export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json({ error: { code, message, ...details } }, status);
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new RequestBodyError("Expected an application/json request.");
  }
  try {
    return await request.json();
  } catch {
    throw new RequestBodyError("Request body must be valid JSON.");
  }
}

export class RequestBodyError extends Error {
  readonly kind = "request-body" as const;
}

export function invalidRequest(message = "Request body is invalid."): Response {
  return apiError(400, "INVALID_REQUEST", message);
}

export function compileInput(value: unknown):
  | { ok: true; value: z.infer<typeof CompileInputSchema> }
  | { ok: false; response: Response } {
  const parsed = CompileInputSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: invalidRequest() };
}

export function invalidSequence(error: unknown): Response {
  const message = error instanceof Error && error.message.includes("duplicate")
    ? "Duplicate epistemic changes are not allowed."
    : "The requested epistemic change sequence is invalid.";
  return apiError(422, "INVALID_SEQUENCE", message);
}

export function compileSafely(
  input: z.infer<typeof CompileInputSchema>,
): { ok: true; build: EpistemicBuild } | { ok: false; response: Response } {
  try {
    return { ok: true, build: compileEpistemicBuild(input) };
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && error.message.includes("unknown epistemic change"))) {
      return { ok: false, response: invalidRequest() };
    }
    if (error instanceof Error && error.message.includes("duplicate")) {
      return { ok: false, response: invalidSequence(error) };
    }
    return { ok: false, response: apiError(500, "INTERNAL_ERROR", "Epistemic compilation failed.") };
  }
}

export function reviewResponse(input: ReviewInput, build: EpistemicBuild): Response {
  const evidenceUpdateStatus = input.action === "approve_evidence_update"
    ? "merged_with_blockers"
    : "rejected";
  const receiptPayload = {
    schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
    receiptVersion: "epistemic-ci.receipt.v1",
    action: input.action,
    declaredActor: input.declaredActor,
    rationale: input.rationale,
    buildId: build.buildId,
    buildHash: canonicalBuildHash(build),
    graphHash: build.graph.graphHash,
    appliedChangeIds: build.appliedChangeIds,
    evidenceUpdateStatus,
    scientificDecisionApproved: false,
    decision: build.decision,
  } as const;
  const receipt = {
    ...receiptPayload,
    receiptHash: canonicalSha256(receiptPayload),
  };
  return json({
    build,
    receipt,
    canonicalExport: exportEpistemicBuild(build),
    evidenceUpdateStatus,
    scientificDecisionApproved: false,
  });
}
