import { deleteLiveRun, getLiveRun } from "@/server/workflow/live-http";
import { handleGetRun } from "@/server/workflow/run-api";

type Context = { params: Promise<{ runId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  if ((await context.params).runId.startsWith("fixture-workbench")) {
    return handleGetRun(request, context);
  }
  return getLiveRun(request, context);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteLiveRun(request, context);
}
