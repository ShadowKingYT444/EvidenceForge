import { describe, expect, it, vi } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import {
  GOLDEN_FIXTURE_ID_V02,
  GOLDEN_FIXTURE_SHA256_V02,
  GOLDEN_PACKET_FINGERPRINT_V02,
  goldenRunV02,
} from "../../src/fixtures/golden-run-v0.2";
import {
  startFixtureWorkbenchSession,
  submitFinalDecision,
} from "../../src/features/workbench/final-decision-actions";

const resetNotice =
  "This isolated demo session is process-local and resets on server restart or redeploy.";
const actorAuthority =
  "Final-decision actor labels are declared and unverified; authentication is not enabled.";

function awaitingRun(runId = "fixture-workbench-1"): ResearchRun {
  const run = structuredClone(goldenRunV02) as ResearchRun;
  run.id = runId;
  run.status = "awaiting_final_approval";
  run.createdAt = "2026-08-08T20:00:00.000Z";
  run.updatedAt = "2026-08-08T20:00:00.001Z";
  run.finalDecision = null;
  run.executions = run.executions.map((execution) => ({
    ...execution,
    inputRefs: execution.inputRefs.map((reference) =>
      reference === GOLDEN_FIXTURE_ID_V02 ? runId : reference,
    ),
    outputRefs: execution.outputRefs.map((reference) =>
      reference === GOLDEN_FIXTURE_ID_V02 ? runId : reference,
    ),
  }));
  return run;
}

function disclosure() {
  return {
    evidenceMode: "fixture",
    sourceFixtureId: GOLDEN_FIXTURE_ID_V02,
    sourceFixtureSha256: GOLDEN_FIXTURE_SHA256_V02,
    packetFingerprint: GOLDEN_PACKET_FINGERPRINT_V02,
    persistence: {
      scope: "process_local",
      survivesCallsWithinProcess: true,
      survivesProcessRestart: false,
      diskDurable: false,
      multiProcessSafe: false,
    },
    resetNotice,
    actorAuthority,
  };
}

function terminalRun(
  prior: ResearchRun,
  choice: "approve" | "reject" = "approve",
  declaredActor = "Fixture reviewer",
  rationale = "Approve only the bounded educational pilot.",
): ResearchRun {
  const decidedAt = "2026-08-08T20:01:00.000Z";
  const unresolvedObjections = (prior.revision?.decisions ?? [])
    .filter(({ disposition }) => disposition === "unresolved")
    .map(({ objectionId }) => objectionId)
    .sort();
  return {
    ...structuredClone(prior),
    status: choice === "approve" ? "approved" : "rejected",
    updatedAt: decidedAt,
    finalDecision: {
      id: "final-decision-2",
      checkpoint: "final",
      optionsShown: ["approve", "reject"],
      decision: choice,
      edits: [],
      decidedAt,
      unresolvedObjections,
      declaredActor,
      rationale,
    },
  };
}

describe("fixture final-decision actions", () => {
  it("bootstraps with strict empty JSON and accepts only the exact 0.2 fixture envelope", async () => {
    const snapshot = awaitingRun();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return new Response(
        JSON.stringify({
          runId: snapshot.id,
          revision: "memory-revision-1",
          snapshot,
          disclosure: disclosure(),
        }),
        { status: 201 },
      );
    });

    const result = await startFixtureWorkbenchSession(fetcher);

    expect(result).toMatchObject({
      ok: true,
      session: {
        runId: snapshot.id,
        revision: "memory-revision-1",
        snapshot: {
          id: snapshot.id,
          schemaVersion: "0.2",
          status: "awaiting_final_approval",
          evidenceMode: "fixture",
          finalDecision: null,
        },
        disclosure: {
          packetFingerprint: GOLDEN_PACKET_FINGERPRINT_V02,
          resetNotice,
          actorAuthority,
        },
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/runs/fixture-workbench",
      expect.any(Object),
    );

    const mismatched = await startFixtureWorkbenchSession(async () =>
      new Response(
        JSON.stringify({
          runId: snapshot.id,
          revision: "memory-revision-1",
          snapshot: { ...snapshot, schemaVersion: "0.1" },
          disclosure: disclosure(),
        }),
        { status: 201 },
      ),
    );
    expect(mismatched).toMatchObject({ ok: false, code: "invalid_response" });
  });

  it("proves an exact server-authored approve receipt and otherwise-unchanged snapshot", async () => {
    const prior = awaitingRun();
    const terminal = terminalRun(prior);
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        checkpoint: "final",
        expectedRevision: "memory-revision-1",
        decision: {
          choice: "approve",
          declaredActor: "Fixture reviewer",
          rationale: "Approve only the bounded educational pilot.",
        },
      });
      return new Response(
        JSON.stringify({ run: terminal, revision: "memory-revision-2" }),
        { status: 200 },
      );
    });

    const result = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: "approve",
        declaredActor: " Fixture reviewer ",
        rationale: " Approve only the bounded educational pilot. ",
      },
      fetcher,
    );

    expect(result).toMatchObject({
      ok: true,
      source: "submitted",
      revision: "memory-revision-2",
      run: { id: prior.id, status: "approved" },
      receipt: {
        id: "final-decision-2",
        decision: "approve",
        declaredActor: "Fixture reviewer",
        unresolvedObjections: ["gf-objection-degradation"],
      },
    });
  });

  it("rejects contradictory 200 receipts and any mutation outside final status, timestamp, and receipt", async () => {
    const prior = awaitingRun();
    const exact = terminalRun(prior);
    const mutations: Array<[string, (run: ResearchRun) => void, string]> = [
      ["same revision", () => undefined, "memory-revision-1"],
      ["choice/status mismatch", (run) => { run.status = "rejected"; }, "memory-revision-2"],
      ["actor mismatch", (run) => { run.finalDecision!.declaredActor = "Other actor"; }, "memory-revision-2"],
      ["options mismatch", (run) => { run.finalDecision!.optionsShown = ["approve"]; }, "memory-revision-2"],
      ["edits injected", (run) => { run.finalDecision!.edits = ["spoofed"]; }, "memory-revision-2"],
      ["unresolved mismatch", (run) => { run.finalDecision!.unresolvedObjections = []; }, "memory-revision-2"],
      ["timestamp mismatch", (run) => { run.updatedAt = "2026-08-08T20:02:00.000Z"; }, "memory-revision-2"],
      ["packet mutation", (run) => { run.packet!.fingerprint = "0".repeat(64); }, "memory-revision-2"],
      ["execution mutation", (run) => { run.executions = run.executions.slice(1); }, "memory-revision-2"],
    ];

    for (const [name, mutate, revision] of mutations) {
      const responseRun = structuredClone(exact) as ResearchRun;
      mutate(responseRun);
      const result = await submitFinalDecision(
        {
          runId: prior.id,
          expectedRevision: "memory-revision-1",
          priorSnapshot: prior,
          choice: "approve",
          declaredActor: "Fixture reviewer",
          rationale: "Approve only the bounded educational pilot.",
        },
        async () =>
          new Response(JSON.stringify({ run: responseRun, revision }), {
            status: 200,
          }),
      );
      expect(result, name).toMatchObject({
        ok: false,
        code: "invalid_response",
      });
    }
  });

  it("recovers a stale revision through canonical GET without converting it to success", async () => {
    const prior = awaitingRun();
    const latest = structuredClone(prior) as ResearchRun;
    latest.updatedAt = "2026-08-08T20:00:30.000Z";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "revision_conflict", message: "private raw detail" } }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ run: latest, revision: "memory-revision-2" }),
          { status: 200 },
        ),
      );

    const result = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: "reject",
        declaredActor: "Independent reviewer",
        rationale: "Reject while the unresolved risk remains.",
      },
      fetcher,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "revision_conflict",
      latest: { revision: "memory-revision-2", run: { status: "awaiting_final_approval" } },
    });
    expect(JSON.stringify(result)).not.toContain("private raw detail");
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/runs/${prior.id}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("renders a valid competing terminal receipt after a stale conflict and discloses a reset on 404", async () => {
    const prior = awaitingRun();
    const competing = terminalRun(
      prior,
      "reject",
      "Competing reviewer",
      "Reject until the residual risk is resolved.",
    );
    const stale = new Response(
      JSON.stringify({ error: { code: "revision_conflict" } }),
      { status: 409 },
    );
    const decided = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: "approve",
        declaredActor: "Fixture reviewer",
        rationale: "Approve only the bounded educational pilot.",
      },
      vi
        .fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ run: competing, revision: "memory-revision-2" }),
            { status: 200 },
          ),
        ),
    );
    expect(decided).toMatchObject({
      ok: false,
      code: "already_decided",
      terminal: {
        revision: "memory-revision-2",
        run: { status: "rejected" },
        receipt: { declaredActor: "Competing reviewer", decision: "reject" },
      },
    });

    const reset = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: "approve",
        declaredActor: "Fixture reviewer",
        rationale: "Approve only the bounded educational pilot.",
      },
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: "revision_conflict" } }), {
            status: 409,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: "run_not_found" } }), {
            status: 404,
          }),
        ),
    );
    expect(reset).toMatchObject({ ok: false, code: "session_reset" });
    expect(reset.message).toContain("restart or redeploy");
  });

  it("sanitizes server and network failures and validates required inert input before fetch", async () => {
    const prior = awaitingRun();
    const fetcher = vi.fn();
    const missing = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: null,
        declaredActor: "",
        rationale: "",
      },
      fetcher,
    );
    expect(missing).toMatchObject({ ok: false, code: "input_required" });
    expect(fetcher).not.toHaveBeenCalled();

    const failed = await submitFinalDecision(
      {
        runId: prior.id,
        expectedRevision: "memory-revision-1",
        priorSnapshot: prior,
        choice: "approve",
        declaredActor: "Fixture reviewer",
        rationale: "Approve only the bounded educational pilot.",
      },
      async () =>
        new Response("private-sentinel server failure", { status: 500 }),
    );
    expect(failed).toMatchObject({ ok: false, code: "request_failed" });
    expect(JSON.stringify(failed)).not.toContain("private-sentinel");
  });
});
