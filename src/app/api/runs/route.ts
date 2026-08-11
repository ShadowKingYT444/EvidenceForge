import { handleCreateRun } from "@/server/workflow/run-api";

export async function POST(request: Request): Promise<Response> {
  return handleCreateRun(request);
}
