import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import {
  createEpistemicLiveService,
  createRecoveryEnvelope,
  verifyRecoveryEnvelope,
  type EpistemicCompileRequest,
} from "../../src/server/epistemic-live";
import type { WorkflowRunSnapshot } from "../../src/server/workflow/store";
import { AsyncWorkflowRunStoreAdapter, InMemoryWorkflowRunStore } from "../../src/server/workflow/store";
import { DurableRunCoordinator } from "../../src/server/workflow/durable-coordinator";

const snapshot: WorkflowRunSnapshot = {
  run: structuredClone(goldenRunV02),
  revision: "revision-1",
  objectionDispositions: null,
};
const token = "private-run-token";
const request = (body?: unknown, headers: Record<string, string> = {}) => new Request("https://example.test", {
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
});

function service() {
  return createEpistemicLiveService({
    coordinator: { authorize: async () => structuredClone(snapshot) },
    project: async (run) => ({ runId: run.id, graphHash: canonicalSha256(run), nodes: [] }),
    compile: async (_run, input, projection) => ({ graphHash: (projection as { graphHash: string }).graphHash, input }),
  });
}

describe("live epistemic API foundations", () => {
  it("authorizes a run token and returns a canonical projection hash", async () => {
    const response = await service().project(snapshot.run.id, request());
    expect(response.runId).toBe(snapshot.run.id);
    expect(response.projectionHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects stale compile branches and creates idempotent, non-scientific review receipts", async () => {
    const live = service();
    const base = await live.project(snapshot.run.id, request());
    const input: EpistemicCompileRequest = {
      operations: [{ kind: "invalidate_evidence", targetNodeIds: ["evidence-1"], reason: "Contradictory source." }],
      expectedProjectionHash: base.projectionHash,
    };
    await expect(live.compile(snapshot.run.id, request(input), { ...input, expectedProjectionHash: "0".repeat(64) })).rejects.toMatchObject({ code: "stale_projection" });
    const review = {
      ...input,
      action: "approve_evidence_update" as const,
      declaredActor: "A declared reviewer",
      rationale: "Accept this bounded evidence update for review.",
      idempotencyKey: "review-1",
    };
    const first = await live.review(snapshot.run.id, request(review), review);
    const second = await live.review(snapshot.run.id, request(review), review);
    expect(second).toEqual(first);
    expect(first.scientificDecisionApproved).toBe(false);
    expect((first as { receipt: { receiptHash: string } }).receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects recovery tampering after verifying the signed payload", () => {
    const envelope = createRecoveryEnvelope(snapshot, { secret: "test-recovery-secret", issuedAt: "2026-08-19T00:00:00.000Z" });
    expect(verifyRecoveryEnvelope(envelope, { secret: "test-recovery-secret" }).payloadHash).toBe(envelope.payloadHash);
    expect(() => verifyRecoveryEnvelope({ ...envelope, runId: "other" }, { secret: "test-recovery-secret" })).toThrow(/identifiers|signature/i);
  });

  it("restores a signed snapshot as a new private process-local session", async () => {
    const coordinator = new DurableRunCoordinator(
      new AsyncWorkflowRunStoreAdapter(new InMemoryWorkflowRunStore()),
    );
    const imported = await coordinator.importSnapshot(snapshot);
    expect(imported.snapshot.run.id).toMatch(/^recovered-/u);
    expect(imported.snapshot.run.id).not.toBe(snapshot.run.id);
    expect(imported.recoveryUrl).toContain(imported.snapshot.run.id);
    await expect(coordinator.authorize(imported.snapshot.run.id, imported.accessToken)).resolves.toMatchObject({
      run: { id: imported.snapshot.run.id },
    });
  });
});
