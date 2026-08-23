import { exportLiveRun } from "@/server/workflow/live-http";
import { handleExportRun } from "@/server/workflow/run-api";

type Context = { params: Promise<{ runId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  if ((await context.params).runId.startsWith("fixture-workbench")) {
    return handleExportRun(request, context);
  }
  return exportLiveRun(request, context);
}
