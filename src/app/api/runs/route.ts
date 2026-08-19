import { createLiveRun } from "@/server/workflow/live-http";

export async function POST(request: Request): Promise<Response> {
  return createLiveRun(request);
}
