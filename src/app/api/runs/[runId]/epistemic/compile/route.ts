import {
  epistemicErrorResponse,
  getEpistemicLiveService,
  parseEpistemicJson,
} from "@/server/epistemic-live";

type Context = { params: Promise<{ runId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { runId } = await context.params;
    const body = await parseEpistemicJson(request);
    const result = await getEpistemicLiveService().compile(runId, request, body);
    return Response.json({
      runId,
      revision: result.run.revision,
      projection: result.projection,
      projectionHash: result.projectionHash,
      graphHash: result.graphHash,
      build: result.build,
      buildHash: result.buildHash,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return epistemicErrorResponse(error);
  }
}
