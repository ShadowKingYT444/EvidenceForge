import { describe, expect, it } from "vitest";

import { canonicalSha256, type ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import {
  LIVE_EPISTEMIC_CI_SCHEMA_VERSION,
  LiveEpistemicBuildSchema,
  LiveEpistemicGraphSchema,
  compileResearchRun,
  projectResearchRun,
  stableLiveNodeId,
} from "../../src/epistemic-ci";

function arbitraryRun() {
  const run = structuredClone(goldenRunV02) as ResearchRun;
  run.id = "run-arbitrary-live-42";
  run.evidenceMode = "live";
  return run;
}

describe("generic live Epistemic CI projection", () => {
  it("projects detached, versioned graphs with run-derived identities", () => {
    const run = arbitraryRun();
    const before = canonicalSha256(run);
    const graph = projectResearchRun(run);
    expect(LiveEpistemicGraphSchema.parse(graph).schemaVersion).toBe(LIVE_EPISTEMIC_CI_SCHEMA_VERSION);
    expect(graph.runId).toBe(run.id);
    expect(graph.runHash).toBe(before);
    expect(graph.nodes.some((node) => node.id.includes("gf-"))).toBe(false);
    expect(graph.nodes.find((node) => node.kind === "passage")).toMatchObject({
      rights: expect.objectContaining({ mayStore: expect.any(String) }),
      scope: expect.objectContaining({ runId: run.id }),
      trust: expect.objectContaining({ provenance: "research-run" }),
    });
    const snapshot = JSON.stringify(run);
    graph.nodes[0]!.label = "branch-only mutation";
    expect(JSON.stringify(run)).toBe(snapshot);
  });

  it("compiles generic typed operations with deterministic impact and diff", () => {
    const run = arbitraryRun();
    const base = projectResearchRun(run);
    const passage = base.nodes.find((node) => node.kind === "passage" && base.edges.some((edge) => edge.from === node.id && edge.to.startsWith("live-node:")))!;
    const claim = base.nodes.find((node) => node.kind === "claim" && base.edges.some((edge) => edge.from === passage.id && edge.to === node.id))!;
    const first = compileResearchRun({
      run,
      operations: [{
        id: "branch-invalidate-1",
        kind: "invalidate_evidence",
        targetNodeIds: [passage.id],
        reason: "Remove this result for sensitivity analysis.",
      }],
    });
    const second = compileResearchRun({
      run,
      operations: [{
        id: "branch-invalidate-1",
        kind: "invalidate_evidence",
        targetNodeIds: [passage.id],
        reason: "Remove this result for sensitivity analysis.",
      }],
    });
    expect(LiveEpistemicBuildSchema.parse(first).buildId).toBe(second.buildId);
    expect(first.diff.impactedNodeIds).toContain(claim.id);
    expect(first.diff.changedNodes.length).toBeGreaterThanOrEqual(1);
    expect(first.graph.nodes.find((node) => node.id === passage.id)?.state).toBe("obsolete");
  });

  it("accepts the adapter's generic run,operations call shape", () => {
    const run = arbitraryRun();
    const graph = projectResearchRun(run);
    const passage = graph.nodes.find((node) => node.kind === "passage")!;
    const build = compileResearchRun(run, {
      operations: [{ kind: "invalidate_evidence", targetNodeIds: [passage.id], reason: "Sensitivity branch." }],
    }, graph);
    expect(build.appliedOperationIds).toHaveLength(1);
    expect(build.graph.runId).toBe(run.id);
    expect(stableLiveNodeId(run.id, "passage", "new-record")).not.toContain("gf-evidence");
  });

  it("supports scope, assumption, and evidence branch operation kinds", () => {
    const run = arbitraryRun();
    const graph = projectResearchRun(run);
    const scope = graph.nodes.find((node) => node.kind === "scope")!;
    const assumption = graph.nodes.find((node) => node.kind === "assumption");
    const claim = graph.nodes.find((node) => node.kind === "claim")!;
    const scoped = compileResearchRun(run, { operations: [{ kind: "scope_override", targetNodeIds: [scope.id], scope: { match: false }, reason: "Narrow the branch scope." }] });
    expect(scoped.graph.nodes.find((node) => node.id === scope.id)?.scope.overridden).toBe(true);
    if (assumption) {
      const accepted = compileResearchRun(run, { operations: [{ kind: "assumption_decision", targetNodeIds: [assumption.id], decision: "accept", reason: "Assumption accepted for this branch." }] });
      expect(accepted.graph.nodes.find((node) => node.id === assumption.id)?.metadata.accepted).toBe(true);
    }
    const added = compileResearchRun(run, { operations: [{ kind: "add_evidence", nodeId: "branch-evidence-1", targetNodeIds: [claim.id], label: "Branch result", detail: "A branch-only result.", sourceRef: null }] });
    expect(added.diff.addedNodeIds.length).toBe(1);
  });
});
