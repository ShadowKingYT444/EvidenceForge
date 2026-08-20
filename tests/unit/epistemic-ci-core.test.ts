import { describe, expect, it } from "vitest";

import {
  canonicalBuildHash,
  compileEpistemicBuild,
  computeImpactClosure,
  computeMinimalBreakingSets,
  computeMinimalSupportWitnesses,
  EpistemicBuildSchema,
  projectGoldenRun,
} from "../../src/epistemic-ci";

describe("Epistemic CI deterministic core", () => {
  it("projects the golden run without mutating it", () => {
    const first = projectGoldenRun();
    const originalHash = first.graphHash;
    first.nodes[0]!.label = "branch-only mutation";
    const second = projectGoldenRun();
    expect(second.graphHash).toBe(originalHash);
    expect(second.nodes[0]!.label).not.toBe("branch-only mutation");
  });

  it("compiles the counterintuitive remove-then-add interaction", () => {
    const base = compileEpistemicBuild({ appliedChangeIds: [] });
    const removed = compileEpistemicBuild({ appliedChangeIds: ["remove-drying-contradiction"] });
    const supported = compileEpistemicBuild({
      appliedChangeIds: ["remove-drying-contradiction", "add-direct-loaded-72h"],
    });
    expect(base.graph.nodes.find((node) => node.id === "claim:loaded-duration")?.state).toBe("conflicting");
    expect(removed.graph.nodes.find((node) => node.id === "claim:loaded-duration")?.state).toBe("insufficient");
    expect(supported.graph.nodes.find((node) => node.id === "claim:loaded-duration")?.state).toBe("supported");
    expect(supported.graph.nodes.find((node) => node.id === "gap:loaded-duration")?.state).toBe("resolved");
    expect(supported.graph.nodes.find((node) => node.id === "experiment:loaded-comparison")?.state).toBe("obsolete");
    expect(supported.decision.status).toBe("failing");
    expect(supported.decision.blockerNodeIds).toEqual(["criterion:comparator", "criterion:degradation-safety"]);
  });

  it("computes stable impact closure and witnesses", () => {
    const build = compileEpistemicBuild({
      appliedChangeIds: ["remove-drying-contradiction", "add-direct-loaded-72h"],
    });
    const impacted = computeImpactClosure(build.graph, ["passage:direct-loaded-72h"]);
    expect(impacted).toContain("claim:loaded-duration");
    expect(impacted).toContain("decision:replacement");
    expect(computeMinimalSupportWitnesses(build.graph, "claim:loaded-duration")).toHaveLength(1);
    expect(computeMinimalSupportWitnesses(build.graph, "claim:loaded-duration")[0]?.nodeIds).toEqual([
      "passage:direct-loaded-72h",
    ]);
    expect(computeMinimalBreakingSets(build.graph, "claim:loaded-duration")).toEqual([
      expect.objectContaining({ nodeIds: ["passage:direct-loaded-72h"] }),
    ]);
  });

  it("is byte-stable and schema strict", () => {
    const first = compileEpistemicBuild({
      appliedChangeIds: ["remove-drying-contradiction", "add-direct-loaded-72h"],
    });
    const second = compileEpistemicBuild({
      appliedChangeIds: ["remove-drying-contradiction", "add-direct-loaded-72h"],
    });
    expect(first.buildId).toBe(second.buildId);
    expect(canonicalBuildHash(first)).toBe(canonicalBuildHash(second));
    expect(EpistemicBuildSchema.safeParse(first).success).toBe(true);
    expect(EpistemicBuildSchema.safeParse({ ...first, unexpected: true }).success).toBe(false);
  });
});
