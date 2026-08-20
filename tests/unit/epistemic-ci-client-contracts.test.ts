import { describe, expect, it } from "vitest";

import { compileEpistemicBuild, getEpistemicDemo } from "../../src/epistemic-ci";
import {
  compileResponseSchema,
  demoResponseSchema,
} from "../../src/features/epistemic-ci/contracts";

describe("Epistemic CI client response contracts", () => {
  it("accepts the deterministic demo and compiler projections", () => {
    const demo = getEpistemicDemo();
    expect(demoResponseSchema.parse({
      schemaVersion: "epistemic-ci.v1",
      mode: "fixture",
      disclosure: "Deterministic fixture replay; no live model, retrieval, or database dependency.",
      ...demo,
    }).baseBuild.decision.status).toBe("failing");
    expect(compileResponseSchema.parse(compileEpistemicBuild({
      appliedChangeIds: ["remove-drying-contradiction"],
    })).graph.nodes.find((node) => node.id === "claim:loaded-duration")?.state).toBe("insufficient");
  });

  it("fails closed on unknown schema versions and partial builds", () => {
    const demo = getEpistemicDemo();
    expect(demoResponseSchema.safeParse({ schemaVersion: "future", ...demo }).success).toBe(false);
    expect(compileResponseSchema.safeParse({
      schemaVersion: "epistemic-ci.v1",
      buildId: "partial",
    }).success).toBe(false);
  });
});
