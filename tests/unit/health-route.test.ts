import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../src/app/api/health/route";

describe("runtime health endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports fixture readiness and the restart boundary without secrets", async () => {
    vi.stubEnv("EVIDENCE_MODE", "fixture");
    vi.stubEnv("RUN_CACHE_TTL_MINUTES", "120");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok", service: "evidenceforge-demo", evidenceMode: "fixture", liveInvestigationsReady: false,
      cache: { scope: "process_local", ttlMinutes: 120, survivesRestart: false },
      providers: { primary: { provider: "featherless", configured: false }, reviewer: { provider: "featherless", configured: false }, openalex: { configured: false } },
    });
    expect(typeof body.version).toBe("string");
    expect(JSON.stringify(body)).not.toMatch(/api.?key|secret|token/iu);
  });

  it("degrades live mode when scholarly search is missing", async () => {
    vi.stubEnv("EVIDENCE_MODE", "live");
    vi.stubEnv("PRIMARY_PROVIDER", "groq");
    vi.stubEnv("PRIMARY_MODEL", "openai/gpt-oss-120b");
    vi.stubEnv("GROQ_API_KEY", "private-primary-key");
    vi.stubEnv("REVIEW_PROVIDER", "nvidia_nim");
    vi.stubEnv("REVIEW_MODEL", "meta/llama-3.1-8b-instruct");
    vi.stubEnv("NVIDIA_API_KEY", "private-review-key");
    vi.stubEnv("OPENALEX_API_KEY", "");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "degraded", reasonCodes: ["openalex_key_missing"], liveInvestigationsReady: false });
  });
});
