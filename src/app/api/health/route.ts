import { evaluateLiveReadiness } from "../../../server/environment";

export async function GET(): Promise<Response> {
  const readiness = evaluateLiveReadiness();
  return Response.json({
    status: readiness.ready ? "ok" : "degraded",
    service: "evidenceforge-demo",
    version: process.env.RENDER_GIT_COMMIT?.trim() || process.env.BUILD_VERSION?.trim() || "dev",
    evidenceMode: readiness.evidenceMode,
    liveInvestigationsReady: readiness.liveInvestigationsReady,
    reasonCodes: readiness.reasons,
    cache: readiness.cache,
    providers: { primary: readiness.primary, reviewer: readiness.reviewer, openalex: readiness.openalex },
  }, { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
