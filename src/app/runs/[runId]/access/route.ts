import { runTokenCookie } from "@/server/auth/run-token";
import { getDurableRunCoordinator } from "@/server/workflow/durable-coordinator";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const runId = (await context.params).runId;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  try {
    await getDurableRunCoordinator().authorize(runId, token);
  } catch {
    return Response.redirect(new URL("/intake?access=invalid", url), 303);
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: `/runs/${encodeURIComponent(runId)}`,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": runTokenCookie(token, { runId }),
    },
  });
}
