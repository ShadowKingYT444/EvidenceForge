import {
  getRecoveryService,
  recoveryErrorResponse,
  recoveryResponse,
} from "@/server/epistemic-live";

type Context = { params: Promise<{ runId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  try {
    const { runId } = await context.params;
    return recoveryResponse(await getRecoveryService().exportRun(runId, request));
  } catch (error) {
    return recoveryErrorResponse(error, { request, operation: "export_recovery", durationMs: Date.now() - startedAt });
  }
}
