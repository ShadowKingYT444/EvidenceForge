import { handleCheckpoint } from "@/server/workflow/run-api";

type Context = { params: Promise<{ runId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return handleCheckpoint(request, context);
}
