import { describe, expect, it, vi } from "vitest";

import { submitObjectionDispositions } from "../../src/features/workbench/objection-disposition-actions";
import { CheckpointRequestSchema } from "../../src/server/workflow/run-api";

const dispositions = [
  {
    objectionId: "objection-1",
    disposition: "accepted" as const,
    basis: "Require independent calibration evidence.",
  },
  {
    objectionId: "objection-2",
    disposition: "unresolved" as const,
    basis: "Qualified safety evidence is still missing.",
  },
  {
    objectionId: "objection-3",
    disposition: "rejected" as const,
    basis: "The objection does not target the approved packet.",
  },
];

describe("objection disposition checkpoint interaction", () => {
  it("posts the existing checkpoint contract and verifies process-local persistence", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        checkpoint: "objection_dispositions",
        expectedRevision: "revision-7",
        dispositions,
        decision: {
          checkpoint: "objection_dispositions",
          optionsShown: ["approve", "request revision", "reject"],
          decision: "approve",
          unresolvedObjections: ["objection-2"],
        },
      });
      expect(body.decision.edits).toEqual(
        dispositions.map(({ objectionId, disposition, basis }) =>
          JSON.stringify({ objectionId, disposition, basis }),
        ),
      );
      expect(CheckpointRequestSchema.safeParse(body).success).toBe(true);
      return new Response(
        JSON.stringify({
          revision: "revision-8",
          run: {
            id: "run-1",
            status: "revising_experiment",
            objectionDispositionDecision: body.decision,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      submitObjectionDispositions(
        {
          runId: "run-1",
          expectedRevision: "revision-7",
          decidedAt: "2026-08-08T19:10:00.000Z",
          dispositions,
        },
        fetcher,
      ),
    ).resolves.toEqual({
      ok: true,
      revision: "revision-8",
      status: "revising_experiment",
      message:
        "Dispositions saved to this process-local run. Selective revision is pending.",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/runs/run-1/checkpoints",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refuses a missing basis before making a request", async () => {
    const fetcher = vi.fn();
    const result = await submitObjectionDispositions(
      {
        runId: "run-1",
        expectedRevision: "revision-7",
        decidedAt: "2026-08-08T19:10:00.000Z",
        dispositions: [{ ...dispositions[0]!, basis: "   " }],
      },
      fetcher,
    );

    expect(result).toEqual({
      ok: false,
      code: "basis_required",
      message: "Every objection disposition requires a human basis.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a same-run checkpoint receipt that contradicts the submitted dispositions", async () => {
    const result = await submitObjectionDispositions(
      {
        runId: "run-1",
        expectedRevision: "revision-7",
        decidedAt: "2026-08-08T19:10:00.000Z",
        dispositions,
      },
      async () =>
        new Response(
          JSON.stringify({
            revision: "revision-8",
            run: {
              id: "run-1",
              status: "revising_experiment",
              objectionDispositionDecision: {
                id: "objection-dispositions-2026-08-08T19:10:00.000Z",
                checkpoint: "objection_dispositions",
                optionsShown: ["approve", "request revision", "reject"],
                decision: "approve",
                edits: ["different-objection: rejected"],
                decidedAt: "2026-08-08T19:10:00.000Z",
                unresolvedObjections: ["different-objection"],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    expect(result).toEqual({
      ok: false,
      code: "invalid_response",
      message:
        "The checkpoint response could not prove that dispositions were persisted.",
    });
  });

  it("rejects missing, duplicate, extra, and basis-mismatched disposition receipts", async () => {
    const mutations: Array<{
      name: string;
      mutate: (decision: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        name: "missing",
        mutate: (decision) => ({
          ...decision,
          edits: (decision.edits as string[]).slice(0, 1),
        }),
      },
      {
        name: "duplicate",
        mutate: (decision) => ({
          ...decision,
          edits: [
            (decision.edits as string[])[0],
            (decision.edits as string[])[0],
          ],
        }),
      },
      {
        name: "extra",
        mutate: (decision) => ({
          ...decision,
          edits: [...(decision.edits as string[]), "extra receipt"],
        }),
      },
      {
        name: "basis mismatch",
        mutate: (decision) => ({
          ...decision,
          edits: (decision.edits as string[]).map((edit, index) =>
            index === 0
              ? JSON.stringify({
                  objectionId: "objection-1",
                  disposition: "accepted",
                  basis: "A different basis.",
                })
              : edit,
          ),
        }),
      },
      {
        name: "duplicate unresolved ID",
        mutate: (decision) => ({
          ...decision,
          unresolvedObjections: ["objection-2", "objection-2"],
        }),
      },
      {
        name: "decision ID mismatch",
        mutate: (decision) => ({ ...decision, id: "different-decision" }),
      },
      {
        name: "options mismatch",
        mutate: (decision) => ({
          ...decision,
          optionsShown: ["approve", "reject"],
        }),
      },
      {
        name: "approval mismatch",
        mutate: (decision) => ({
          ...decision,
          decision: "request revision",
        }),
      },
      {
        name: "timestamp mismatch",
        mutate: (decision) => ({
          ...decision,
          decidedAt: "2026-08-08T19:11:00.000Z",
        }),
      },
      {
        name: "extra decision field",
        mutate: (decision) => ({ ...decision, unexpected: true }),
      },
    ];

    for (const { name, mutate } of mutations) {
      const result = await submitObjectionDispositions(
        {
          runId: "run-1",
          expectedRevision: "revision-7",
          decidedAt: "2026-08-08T19:10:00.000Z",
          dispositions,
        },
        async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              revision: "revision-8",
              run: {
                id: "run-1",
                status: "revising_experiment",
                objectionDispositionDecision: mutate(body.decision),
              },
            }),
            { status: 200 },
          );
        },
      );

      expect(result, name).toMatchObject({
        ok: false,
        code: "invalid_response",
      });
    }
  });

  it("maps stale and malformed responses without leaking raw API text or claiming success", async () => {
    const stale = await submitObjectionDispositions(
      {
        runId: "run-1",
        expectedRevision: "stale-revision",
        decidedAt: "2026-08-08T19:10:00.000Z",
        dispositions,
      },
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "revision_conflict",
              message: "private-sentinel raw server detail",
            },
          }),
          { status: 409 },
        ),
    );
    expect(stale).toEqual({
      ok: false,
      code: "revision_conflict",
      message:
        "This run changed before the checkpoint was saved. Review the latest run before retrying.",
    });
    expect(JSON.stringify(stale)).not.toContain("private-sentinel");

    const malformed = await submitObjectionDispositions(
      {
        runId: "run-1",
        expectedRevision: "revision-7",
        decidedAt: "2026-08-08T19:10:00.000Z",
        dispositions,
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(malformed).toEqual({
      ok: false,
      code: "invalid_response",
      message:
        "The checkpoint response could not prove that dispositions were persisted.",
    });
  });
});
