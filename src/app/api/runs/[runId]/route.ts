import { handleGetRun } from "@/server/workflow/run-api";

type Context = { params: Promise<{ runId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return handleGetRun(request, context);
}
