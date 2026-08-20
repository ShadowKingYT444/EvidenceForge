import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import {
  EPISTEMIC_CI_SCHEMA_VERSION,
  EpistemicGraphSchema,
} from "../../src/epistemic-ci/contracts";
import {
  getGoldenFixtureIdentity,
  goldenEpistemicGraph,
  projectGoldenRun,
} from "../../src/epistemic-ci/fixture";

describe("epistemic CI golden projection", () => {
  it("projects the reviewed v0.2 fixture without changing its identity", () => {
    const identity = getGoldenFixtureIdentity();

    expect(identity).toEqual({
      id: goldenRunV02.id,
      hash: canonicalSha256(goldenRunV02),
    });
    expect(goldenEpistemicGraph).toMatchObject({
      schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
      fixtureId: goldenRunV02.id,
      fixtureHash: canonicalSha256(goldenRunV02),
    });
    expect(EpistemicGraphSchema.parse(projectGoldenRun())).toEqual(
      projectGoldenRun(),
    );
  });

  it("has a deterministic graph hash over sorted nodes and edges", () => {
    const graph = projectGoldenRun();
    const { graphHash, ...payload } = graph;

    expect(graphHash).toBe(canonicalSha256(payload));
    expect(graph.nodes.map(({ id }) => id)).toEqual(
      [...graph.nodes.map(({ id }) => id)].sort((a, b) => a.localeCompare(b)),
    );
    expect(graph.edges.map(({ id }) => id)).toEqual(
      [...graph.edges.map(({ id }) => id)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("keeps the canonical fixture and exported projection immutable across branches", () => {
    const beforeFixture = JSON.stringify(goldenRunV02);
    const beforeGraph = JSON.stringify(goldenEpistemicGraph);
    const branch = projectGoldenRun() as {
      nodes: Array<{ id: string; state: string }>;
    };

    branch.nodes[0]!.state = "obsolete";

    expect(JSON.stringify(goldenRunV02)).toBe(beforeFixture);
    expect(JSON.stringify(goldenEpistemicGraph)).toBe(beforeGraph);
  });

  it("starts with the contradictory duration evidence and preserves unaffected hazard evidence", () => {
    const graph = projectGoldenRun();
    const duration = graph.nodes.find((node) => node.id === "claim:loaded-duration");
    const hazardPassage = graph.nodes.find(
      (node) => node.id === "passage:gf-evidence-05",
    );
    const hazardCriterion = graph.nodes.find(
      (node) => node.id === "criterion:degradation-safety",
    );

    expect(duration).toMatchObject({ state: "conflicting" });
    expect(hazardPassage).toMatchObject({ state: "supported" });
    expect(hazardCriterion).toMatchObject({ state: "blocked" });
  });
});
