import { getLiveTimeline } from "@/server/workflow/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return getLiveTimeline(request, context);
}
