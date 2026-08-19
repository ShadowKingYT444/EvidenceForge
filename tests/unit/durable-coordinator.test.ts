import { afterEach, describe, expect, it } from "vitest";

import { DurableRunCoordinator, RunAccessDeniedError } from "../../src/server/workflow/durable-coordinator";
import { AsyncWorkflowRunStoreAdapter, InMemoryWorkflowRunStore } from "../../src/server/workflow/store";

const intake = {
  originalQuestion: "Does retrieval augmentation reduce factual hallucination?",
  intendedApplication: "Choose an architecture for a research assistant.",
  populationOrGeography: "Knowledge-grounded language generation",
  timeHorizon: "2020-present",
  availableMaterialsOrBudget: "Open-access research",
  desiredDepth: "Bounded evidence packet",
  constraints: ["Seed claim: retrieval improves factuality"],
  unansweredClarifications: [],
};

describe("durable run coordinator", () => {
  const priorSecret = process.env.RUN_TOKEN_SECRET;
  afterEach(() => {
    if (priorSecret === undefined) delete process.env.RUN_TOKEN_SECRET;
    else process.env.RUN_TOKEN_SECRET = priorSecret;
  });

  it("creates and authorizes a private durable investigation", async () => {
    process.env.RUN_TOKEN_SECRET = "test-run-token-secret";
    const coordinator = new DurableRunCoordinator(
      new AsyncWorkflowRunStoreAdapter(new InMemoryWorkflowRunStore()),
    );
    const created = await coordinator.create(intake);
    expect(created.snapshot.run.status).toBe("draft");
    await expect(
      coordinator.authorize(created.snapshot.run.id, created.accessToken),
    ).resolves.toMatchObject({ revision: created.snapshot.revision });
    await expect(
      coordinator.authorize(created.snapshot.run.id, "wrong-token"),
    ).rejects.toBeInstanceOf(RunAccessDeniedError);

    const continued = await coordinator.continue(
      created.snapshot.run.id,
      created.snapshot.revision,
      created.accessToken,
    );
    expect(continued.snapshot.run.status).toBe("decomposing");
    expect(continued.snapshot.run.executions).toHaveLength(1);
    expect(continued.snapshot.run.errors).toHaveLength(1);
  });
});
