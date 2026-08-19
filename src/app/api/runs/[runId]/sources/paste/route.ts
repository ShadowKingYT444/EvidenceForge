import { pasteRunSource } from "@/server/sources/live-http";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return pasteRunSource(request, context);
}
