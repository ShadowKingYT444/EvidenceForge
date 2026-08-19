import { describe, expect, it } from "vitest";

import { GET } from "../../src/app/api/health/route";

describe("Render health endpoint", () => {
  it("reports fixture-safe readiness without exposing runtime details", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      service: "evidenceforge-demo",
      evidenceMode: "fixture",
      cache: {
        scope: "process_local",
        ttlMinutes: 120,
        survivesRestart: false,
      },
      providers: {
        featherlessConfigured: false,
        openalexConfigured: false,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/api.?key|secret|token/iu);
  });
});
