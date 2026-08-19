import { continueLiveRun } from "@/server/workflow/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return continueLiveRun(request, context);
}
