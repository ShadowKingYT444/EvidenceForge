import { createProductionPool } from "../../../server/db/pool";

export async function GET(): Promise<Response> {
  const mode = process.env.EVIDENCE_MODE === "live" ? "live" : "fixture";
  const providerConfigured = Boolean(process.env.FEATHERLESS_API_KEY?.trim());
  const searchConfigured = Boolean(process.env.OPENALEX_API_KEY?.trim());
  let databaseReady = false;
  let pool: Awaited<ReturnType<typeof createProductionPool>> | null = null;
  try {
    if (process.env.DATABASE_URL) {
      pool = createProductionPool();
      await pool.query("SELECT 1");
      databaseReady = true;
    }
  } catch {
    databaseReady = false;
  } finally {
    await pool?.end?.().catch(() => undefined);
  }
  const localFixture = mode === "fixture" && !process.env.DATABASE_URL;
  const healthy = localFixture || (databaseReady && providerConfigured && searchConfigured);
  return Response.json({
    status: healthy ? "ok" : "degraded",
    service: "evidenceforge-demo",
    version: process.env.RENDER_GIT_COMMIT ?? process.env.BUILD_VERSION ?? "dev",
    evidenceMode: mode,
    database: { configured: Boolean(process.env.DATABASE_URL), ready: databaseReady },
    providers: { featherlessConfigured: providerConfigured, openalexConfigured: searchConfigured },
  }, { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
