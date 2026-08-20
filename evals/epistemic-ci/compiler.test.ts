import { describe, expect, it } from "vitest";

import {
  canonicalBuildHash,
  compileEpistemicBuild,
  computeImpactClosure,
  computeMinimalBreakingSets,
  computeMinimalSupportWitnesses,
  projectGoldenRun,
} from "../../src/epistemic-ci";

const REMOVE = "remove-drying-contradiction" as const;
const DIRECT = "add-direct-loaded-72h" as const;

function ids(values: readonly { nodeIds: string[] }[]) {
  return values.map(({ nodeIds }) => [...nodeIds].sort()).sort((a, b) =>
    a.join("|").localeCompare(b.join("|")),
  );
}

function node(build: ReturnType<typeof compileEpistemicBuild>, id: string) {
  return build.graph.nodes.find((candidate) => candidate.id === id);
}

describe("epistemic CI deterministic compiler", () => {
  it("compiles the base fixture as conflicting and failing", () => {
    const build = compileEpistemicBuild([]);

    expect(build.appliedChangeIds).toEqual([]);
    expect(node(build, "claim:loaded-duration")).toMatchObject({
      state: "conflicting",
    });
    expect(build.decision).toMatchObject({ status: "failing" });
    expect(build.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CONFLICTING_EVIDENCE",
          nodeId: "claim:loaded-duration",
          severity: "error",
        }),
        expect.objectContaining({
          code: "BLOCKED_CRITERION",
          nodeId: "criterion:comparator",
        }),
        expect.objectContaining({
          code: "BLOCKED_CRITERION",
          nodeId: "criterion:degradation-safety",
        }),
      ]),
    );
    expect(
      build.errors.some((error) => error.code === "INSUFFICIENT_SUPPORT"),
    ).toBe(false);
    expect(build.witnesses.some((witness) => witness.targetNodeId === "claim:loaded-duration")).toBe(
      false,
    );
  });

  it("turns removing the contradiction into insufficient evidence, not support", () => {
    const build = compileEpistemicBuild([REMOVE]);

    expect(node(build, "passage:gf-evidence-01")).toMatchObject({
      state: "obsolete",
      metadata: { active: false },
    });
    expect(node(build, "claim:loaded-duration")).toMatchObject({
      state: "insufficient",
    });
    expect(build.witnesses.some((witness) => witness.targetNodeId === "claim:loaded-duration")).toBe(
      false,
    );
    expect(build.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INSUFFICIENT_SUPPORT",
          nodeId: "claim:loaded-duration",
        }),
      ]),
    );
    expect(build.diff.changedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "claim:loaded-duration",
          before: "conflicting",
          after: "insufficient",
        }),
      ]),
    );
    expect(build.decision.status).toBe("failing");
  });

  it("upgrades duration only after the direct loaded result and preserves final blockers", () => {
    const build = compileEpistemicBuild([REMOVE, DIRECT]);

    expect(node(build, "claim:loaded-duration")).toMatchObject({
      state: "supported",
    });
    expect(node(build, "criterion:duration")).toMatchObject({
      state: "supported",
    });
    expect(node(build, "gap:loaded-duration")).toMatchObject({
      state: "resolved",
    });
    expect(node(build, "experiment:loaded-comparison")).toMatchObject({
      state: "obsolete",
    });
    expect(node(build, "decision:replacement")).toMatchObject({
      state: "blocked",
      metadata: { status: "failing" },
    });
    expect(build.decision).toMatchObject({
      status: "failing",
      blockerNodeIds: ["criterion:comparator", "criterion:degradation-safety"],
    });
    expect(build.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OBSOLETE_EXPERIMENT",
          severity: "warning",
        }),
        expect.objectContaining({
          code: "BLOCKED_CRITERION",
          nodeId: "criterion:comparator",
        }),
        expect.objectContaining({
          code: "BLOCKED_CRITERION",
          nodeId: "criterion:degradation-safety",
        }),
      ]),
    );
    expect(
      build.errors.some((error) => error.code === "CONFLICTING_EVIDENCE"),
    ).toBe(false);
  });

  it("keeps the unrelated hazard branch stable during duration perturbations", () => {
    const base = compileEpistemicBuild([]);
    const perturbed = compileEpistemicBuild([REMOVE, DIRECT]);
    const stableIds = [
      "passage:gf-evidence-05",
      "criterion:degradation-safety",
      "objection:degradation-safety",
    ];

    for (const id of stableIds) {
      expect(node(perturbed, id)).toMatchObject({
        state: node(base, id)?.state,
        detail: node(base, id)?.detail,
        metadata: node(base, id)?.metadata,
      });
    }
    expect(perturbed.diff.impactedNodeIds).not.toEqual(
      expect.arrayContaining(stableIds),
    );
  });

  it("computes directed impact closure without pulling in unrelated hazard nodes", () => {
    const graph = projectGoldenRun();
    const closure = computeImpactClosure(graph, ["passage:gf-evidence-01"]);

    expect(closure).toEqual(
      expect.arrayContaining([
        "passage:gf-evidence-01",
        "claim:loaded-duration",
        "criterion:duration",
        "gap:loaded-duration",
        "experiment:loaded-comparison",
        "decision:replacement",
      ]),
    );
    expect(closure).not.toEqual(
      expect.arrayContaining([
        "passage:gf-evidence-05",
        "criterion:degradation-safety",
        "objection:degradation-safety",
      ]),
    );
  });

  it("returns exact minimal support witnesses and bounded breaking sets", () => {
    const graph = projectGoldenRun();
    const integrationWitnesses = computeMinimalSupportWitnesses(
      graph,
      "claim:integration",
    );

    expect(ids(integrationWitnesses)).toEqual([
      ["passage:gf-evidence-04"],
      ["passage:gf-evidence-06"],
    ]);
    expect(ids(computeMinimalBreakingSets(graph, "claim:integration"))).toEqual([
      ["passage:gf-evidence-04", "passage:gf-evidence-06"],
    ]);

    const directBuild = compileEpistemicBuild([REMOVE, DIRECT]);
    expect(
      ids(
        computeMinimalSupportWitnesses(
          directBuild.graph,
          "claim:loaded-duration",
        ),
      ),
    ).toEqual([["passage:direct-loaded-72h"]]);
    expect(ids(directBuild.breakingSets)).toEqual([
      ["passage:direct-loaded-72h"],
    ]);
  });

  it("produces stable builds, diffs, and hashes for equivalent inputs", () => {
    const first = compileEpistemicBuild({
      appliedChangeIds: [REMOVE, DIRECT],
      parentBuildId: "epistemic-build-parent",
    });
    const second = compileEpistemicBuild({
      appliedChangeIds: [REMOVE, DIRECT],
      parentBuildId: "epistemic-build-parent",
    });

    expect(second).toEqual(first);
    expect(canonicalBuildHash(second)).toBe(canonicalBuildHash(first));
    expect(JSON.stringify(second.diff)).toBe(JSON.stringify(first.diff));
  });
});
