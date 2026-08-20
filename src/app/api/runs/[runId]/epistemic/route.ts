import {
  epistemicErrorResponse,
  getEpistemicLiveService,
} from "@/server/epistemic-live";

type Context = { params: Promise<{ runId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { runId } = await context.params;
    return Response.json(await getEpistemicLiveService().project(runId, request), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return epistemicErrorResponse(error);
  }
}
