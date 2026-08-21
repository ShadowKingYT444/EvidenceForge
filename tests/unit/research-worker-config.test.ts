import { describe, expect, it } from "vitest";

import { parseResearchConfig, researchConfigSchema } from "@/server/research/config";

describe("research worker config", () => {
  it("uses the bounded defaults", () => {
    expect(parseResearchConfig()).toEqual({
      target: 10,
      minimum: 5,
      candidateCap: 30,
      sourceDeadlineMs: 180_000,
      perItemTimeoutMs: 45_000,
      deadlineMs: 300_000,
      maxConcurrency: 6,
    });
  });

  it("rejects unknown keys and invalid relationships", () => {
    expect(researchConfigSchema.safeParse({ extra: true }).success).toBe(false);
    expect(researchConfigSchema.safeParse({ target: 4, minimum: 5 }).success).toBe(false);
    expect(researchConfigSchema.safeParse({ maxConcurrency: 7 }).success).toBe(false);
  });
});
