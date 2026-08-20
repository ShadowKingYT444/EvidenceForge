import {
  compileSafely,
  invalidRequest,
  parseJsonBody,
  RequestBodyError,
  ReviewInputSchema,
  reviewResponse,
  apiError,
} from "../_http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return error instanceof RequestBodyError ? invalidRequest(error.message) : invalidRequest();
  }
  const parsed = ReviewInputSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const compiled = compileSafely({ appliedChangeIds: parsed.data.appliedChangeIds });
  if (!compiled.ok) return compiled.response;
  if (compiled.build.graph.graphHash !== parsed.data.expectedGraphHash) {
    return apiError(409, "STALE_GRAPH", "The graph changed; recompile before reviewing.", {
      expectedGraphHash: parsed.data.expectedGraphHash,
      actualGraphHash: compiled.build.graph.graphHash,
    });
  }
  return reviewResponse(parsed.data, compiled.build);
}
