import { expect, test } from "@playwright/test";

import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";

test("bootstraps an isolated fixture run, persists a final receipt, and exports canonical history", async ({
  request,
}) => {
  const bootstrapResponse = await request.post(
    "/api/runs/fixture-workbench",
    { data: {} },
  );
  expect(bootstrapResponse.status()).toBe(201);
  expect(bootstrapResponse.headers()["cache-control"]).toBe(
    "private, no-store, max-age=0",
  );
  const bootstrap = (await bootstrapResponse.json()) as {
    runId: string;
    revision: string;
    snapshot: typeof goldenRunV02;
    disclosure: {
      evidenceMode: string;
      resetNotice: string;
      actorAuthority: string;
    };
  };
  expect(bootstrap.snapshot).toMatchObject({
    id: bootstrap.runId,
    schemaVersion: "0.2",
    evidenceMode: "fixture",
    status: "awaiting_final_approval",
    finalDecision: null,
  });
  expect(bootstrap.disclosure).toMatchObject({
    evidenceMode: "fixture",
    resetNotice: expect.stringContaining("restart or redeploy"),
    actorAuthority: expect.stringContaining("declared and unverified"),
  });

  const readResponse = await request.get(`/api/runs/${bootstrap.runId}`);
  expect(readResponse.status()).toBe(200);
  expect(await readResponse.json()).toEqual({
    run: bootstrap.snapshot,
    revision: bootstrap.revision,
  });

  const preterminalExport = await request.get(
    `/api/runs/${bootstrap.runId}/export`,
  );
  expect(preterminalExport.status()).toBe(409);

  const finalResponse = await request.post(
    `/api/runs/${bootstrap.runId}/checkpoints`,
    {
      data: {
        checkpoint: "final",
        expectedRevision: bootstrap.revision,
        decision: {
          choice: "approve",
          declaredActor: "Browser fixture reviewer",
          rationale: "Approve only the bounded educational pilot.",
        },
      },
    },
  );
  expect(finalResponse.status()).toBe(200);
  expect(finalResponse.headers()["cache-control"]).toBe(
    "private, no-store, max-age=0",
  );
  const terminal = (await finalResponse.json()) as {
    run: typeof goldenRunV02;
    revision: string;
  };
  expect(terminal.run).toMatchObject({
    status: "approved",
    finalDecision: {
      checkpoint: "final",
      optionsShown: ["approve", "reject"],
      decision: "approve",
      declaredActor: "Browser fixture reviewer",
      rationale: "Approve only the bounded educational pilot.",
      unresolvedObjections: ["gf-objection-degradation"],
    },
  });
  expect(terminal.run.finalDecision!.id).not.toBe(
    goldenRunV02.finalDecision!.id,
  );
  expect(terminal.run.finalDecision!.decidedAt).not.toBe(
    goldenRunV02.finalDecision!.decidedAt,
  );

  const firstExport = await request.get(
    `/api/runs/${bootstrap.runId}/export`,
  );
  const secondExport = await request.get(
    `/api/runs/${bootstrap.runId}/export`,
  );
  expect(firstExport.status()).toBe(200);
  expect(firstExport.headers()["cache-control"]).toBe(
    "private, no-store, max-age=0",
  );
  expect(firstExport.headers()["x-content-type-options"]).toBe("nosniff");
  const firstBytes = await firstExport.body();
  expect(await secondExport.body()).toEqual(firstBytes);
  const exported = JSON.parse(firstBytes.toString("utf8")) as typeof goldenRunV02;
  expect(exported.packet?.fingerprint).toBe(
    goldenRunV02.packet?.fingerprint,
  );
  expect(exported.executions.map(({ id }) => id)).toEqual(
    goldenRunV02.executions.map(({ id }) => id),
  );
  expect(exported.errors.map(({ id }) => id)).toEqual(
    goldenRunV02.errors.map(({ id }) => id),
  );
  expect(
    exported.executions.every(({ evidenceMode }) => evidenceMode === "fixture"),
  ).toBe(true);
});

test("separate fixture sessions do not share terminal state", async ({ request }) => {
  const first = await (
    await request.post("/api/runs/fixture-workbench", { data: {} })
  ).json();
  const second = await (
    await request.post("/api/runs/fixture-workbench", { data: {} })
  ).json();
  expect(first.runId).not.toBe(second.runId);

  const rejection = await request.post(`/api/runs/${first.runId}/checkpoints`, {
    data: {
      checkpoint: "final",
      expectedRevision: first.revision,
      decision: {
        choice: "reject",
        declaredActor: "Independent browser reviewer",
        rationale: "Reject while the recorded residual risk remains unresolved.",
      },
    },
  });
  expect(rejection.status()).toBe(200);
  expect((await rejection.json()).run.status).toBe("rejected");

  const untouched = await (
    await request.get(`/api/runs/${second.runId}`)
  ).json();
  expect(untouched).toMatchObject({
    revision: second.revision,
    run: { status: "awaiting_final_approval", finalDecision: null },
  });
});
