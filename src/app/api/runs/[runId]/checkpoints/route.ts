import { checkpointLiveRun } from "@/server/workflow/live-http";
import { handleCheckpoint } from "@/server/workflow/run-api";

type Context = { params: Promise<{ runId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  if ((await context.params).runId.startsWith("fixture-workbench")) {
    return handleCheckpoint(request, context);
  }
  return checkpointLiveRun(request, context);
}
