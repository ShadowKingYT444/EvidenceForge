import { getRunPacketDraft } from "@/server/sources/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return getRunPacketDraft(request, context);
}
