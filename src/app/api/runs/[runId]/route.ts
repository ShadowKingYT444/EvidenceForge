import { deleteLiveRun, getLiveRun } from "@/server/workflow/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return getLiveRun(request, context);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteLiveRun(request, context);
}
