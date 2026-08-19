export async function GET(): Promise<Response> {
  const mode = process.env.EVIDENCE_MODE === "live" ? "live" : "fixture";
  const primaryProvider = process.env.PRIMARY_PROVIDER?.trim() || "featherless";
  const reviewerProvider = process.env.REVIEW_PROVIDER?.trim() || "featherless";
  const keyFor = (provider: string) =>
    provider === "groq"
      ? process.env.GROQ_API_KEY?.trim()
      : provider === "nvidia_nim"
        ? process.env.NVIDIA_API_KEY?.trim()
        : process.env.FEATHERLESS_API_KEY?.trim();
  const primaryConfigured = Boolean(keyFor(primaryProvider));
  const reviewerConfigured = Boolean(keyFor(reviewerProvider));
  const searchConfigured = Boolean(process.env.OPENALEX_API_KEY?.trim());
  const ttlMinutes = Math.max(5, Number(process.env.RUN_CACHE_TTL_MINUTES ?? 120));
  const healthy = mode === "fixture" || (primaryConfigured && reviewerConfigured);

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
      primary: { provider: primaryProvider, configured: primaryConfigured },
      reviewer: { provider: reviewerProvider, configured: reviewerConfigured },
      openalexConfigured: searchConfigured,
    },
  }, { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
