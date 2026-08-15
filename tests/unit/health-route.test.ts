import { describe, expect, it } from "vitest";

import { GET } from "../../src/app/api/health/route";

describe("Render health endpoint", () => {
  it("reports fixture-safe readiness without exposing runtime details", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "evidenceforge-demo",
    });
  });
});
