import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableRunCoordinator, RunAccessDeniedError } from "../../src/server/workflow/durable-coordinator";
import { AsyncWorkflowRunStoreAdapter, InMemoryWorkflowRunStore, RevisionConflictError } from "../../src/server/workflow/store";

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

describe("private cached run coordinator", () => {
  const priorSecret = process.env.RUN_TOKEN_SECRET;
  afterEach(() => {
    vi.useRealTimers();
    if (priorSecret === undefined) delete process.env.RUN_TOKEN_SECRET;
    else process.env.RUN_TOKEN_SECRET = priorSecret;
  });

  it("expires private cached runs after inactivity", async () => {
    vi.useFakeTimers();
    process.env.RUN_TOKEN_SECRET = "test-run-token-secret";
    const cache = new AsyncWorkflowRunStoreAdapter(
      new InMemoryWorkflowRunStore(),
      { ttlMs: 1_000 },
    );
    const coordinator = new DurableRunCoordinator(cache);
    const created = await coordinator.create(intake);

    vi.advanceTimersByTime(1_001);
    await expect(
      coordinator.authorize(created.snapshot.run.id, created.accessToken),
    ).rejects.toBeInstanceOf(RunAccessDeniedError);
  });

  it("creates and authorizes a private ephemeral investigation", async () => {
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

  it("throws the typed conflict for stale authorized revisions", async () => {
    process.env.RUN_TOKEN_SECRET = "test-run-token-secret";
    const coordinator = new DurableRunCoordinator(new AsyncWorkflowRunStoreAdapter(new InMemoryWorkflowRunStore()));
    const created = await coordinator.create(intake);
    await expect(coordinator.continue(created.snapshot.run.id, "stale-revision", created.accessToken))
      .rejects.toBeInstanceOf(RevisionConflictError);
  });
});
