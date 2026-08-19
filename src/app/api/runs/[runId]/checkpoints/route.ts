import { checkpointLiveRun } from "@/server/workflow/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return checkpointLiveRun(request, context);
}
