import { describe, expect, it } from "vitest";

import { resolveWorkbenchProjectionQuery } from "../../src/features/workbench/workbench-query-policy";

describe("workbench projection query policy", () => {
  it.each([
    { dispositions: "awaiting", expectedRevision: "revision-7" },
    { scenario: "approved" },
    { packet: "empty", matrix: "empty" },
    { protocol: "abstention" },
    {
      dispositions: "awaiting",
      expectedRevision: "revision-7",
      scenario: "approved",
      packet: "empty",
      matrix: "empty",
      protocol: "abstention",
    },
  ])("ignores recorded projection overrides for a bound run: %j", (overrides) => {
    expect(
      resolveWorkbenchProjectionQuery({
        runId: "fixture-workbench-7",
        evidence: "gf-card-01",
        ...overrides,
      }),
    ).toEqual({
      runId: "fixture-workbench-7",
      evidence: "gf-card-01",
      scenario: undefined,
      packet: undefined,
      matrix: undefined,
      protocol: undefined,
      dispositions: undefined,
      expectedRevision: undefined,
    });
  });

  it("preserves the explicit simulated awaiting scenario without a run ID", () => {
    const query = {
      dispositions: "awaiting",
      expectedRevision: "simulated-revision",
      protocol: "abstention",
      scenario: "reviewer-decision",
    };

    expect(resolveWorkbenchProjectionQuery(query)).toBe(query);
  });
});
