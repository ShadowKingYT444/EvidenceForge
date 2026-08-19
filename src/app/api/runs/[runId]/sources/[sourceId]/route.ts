import { deleteRunDraftSource } from "@/server/sources/live-http";

type Context = { params: Promise<{ runId: string; sourceId: string }> };

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteRunDraftSource(request, context);
}
