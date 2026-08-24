import { handleBootstrapFixtureWorkbench } from "@/server/workflow/run-api";
import { isOwnerRequest } from "@/server/session/research-session";

export async function POST(request: Request): Promise<Response> {
  if (!isOwnerRequest(request)) return Response.json({ error: { code: "run_not_found", message: "Not found." } }, { status: 404, headers: { "cache-control": "no-store" } });
  return handleBootstrapFixtureWorkbench(request);
}
