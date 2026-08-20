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
    return Response.json(await getEpistemicLiveService().review(runId, request, body), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return epistemicErrorResponse(error);
  }
}
