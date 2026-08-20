import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import { createFixtureAdapter } from "../../src/server/models";
import { createPromptRunNodeRequestBuilder } from "../../src/server/prompts/render";
import { RunService } from "../../src/server/workflow/run-api";
import { InMemoryWorkflowRunStore } from "../../src/server/workflow/store";

describe("deterministic missing-evidence planning boundary", () => {
  it("records a typed abstention without invoking a model", async () => {
    const run = structuredClone(goldenRunV02) as ResearchRun;
    const selected = structuredClone(run.researchGaps[0]!);
    selected.evidenceCardIds = [];
    selected.selection = "selected";
    run.status = "planning_experiment";
    run.researchGaps = [selected];
    run.selectedGapId = selected.id;
    run.experiment = null;
    run.experimentAbstention = null;
    run.review = null;
    run.objectionDispositionDecision = null;
    run.revision = null;
    run.finalDecision = null;
    run.executions = run.executions.filter(({ nodeId }) => ["clarify-and-decompose", "extract-evidence", "assess-entailment", "synthesize-conclusions"].includes(nodeId));
    const executionIds = new Set(run.executions.map(({ id }) => id));
    run.errors = run.errors.filter(({ executionId }) => executionId === null || executionIds.has(executionId));
    const store = new InMemoryWorkflowRunStore();
    store.hydrate({ run, revision: "planning-abstention", objectionDispositions: null });
    const adapter = createFixtureAdapter({ modelId: "unused", developerFamily: "fixture", baseFamily: "fixture", fixtures: {} });
    const service = new RunService({
      store,
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: createPromptRunNodeRequestBuilder(),
    });
    const result = await service.continue({ runId: run.id, expectedRevision: "planning-abstention" });
    expect(result.advanced).toBe(true);
    expect(result.snapshot.run.status).toBe("awaiting_final_approval");
    expect(result.snapshot.run.experimentAbstention).toMatchObject({
      safetyCategories: ["missing_required_evidence"],
      qualifiedReviewRequired: true,
    });
    expect(result.snapshot.run.executions).toHaveLength(run.executions.length);
  });
});
