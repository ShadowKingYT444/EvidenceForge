export async function GET(): Promise<Response> {
  const mode = process.env.EVIDENCE_MODE === "live" ? "live" : "fixture";
  const providerConfigured = Boolean(process.env.FEATHERLESS_API_KEY?.trim());
  const searchConfigured = Boolean(process.env.OPENALEX_API_KEY?.trim());
  const ttlMinutes = Math.max(5, Number(process.env.RUN_CACHE_TTL_MINUTES ?? 120));
  const healthy = mode === "fixture" || providerConfigured;

  return Response.json({
    status: healthy ? "ok" : "degraded",
    service: "evidenceforge-demo",
    version: process.env.RENDER_GIT_COMMIT ?? process.env.BUILD_VERSION ?? "dev",
    evidenceMode: mode,
    cache: {
      scope: "process_local",
      ttlMinutes,
      survivesRestart: false,
    },
    providers: {
      featherlessConfigured: providerConfigured,
      openalexConfigured: searchConfigured,
    },
  }, { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
