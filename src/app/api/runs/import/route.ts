import {
  getRecoveryService,
  RecoveryError,
  recoveryErrorResponse,
} from "@/server/epistemic-live";
import { runTokenCookie } from "@/server/auth/run-token";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 1_024 * 1_024) {
      return recoveryErrorResponse(new RecoveryError("request_too_large", "Recovery import exceeds the maximum size."));
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const imported = await getRecoveryService().importBytes(bytes);
    if (typeof imported === "object" && imported !== null && "snapshot" in imported && "accessToken" in imported) {
      const value = imported as { snapshot: { run: { id: string } }; accessToken: string; recoveryUrl: string };
      return Response.json({ run: value.snapshot.run, recoveryUrl: value.recoveryUrl }, {
        status: 201,
        headers: {
          "cache-control": "private, no-store",
          "set-cookie": runTokenCookie(value.accessToken, { runId: value.snapshot.run.id }),
          location: `/runs/${encodeURIComponent(value.snapshot.run.id)}`,
        },
      });
    }
    return Response.json(imported, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return recoveryErrorResponse(error);
  }
}
