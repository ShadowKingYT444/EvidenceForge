import { describe, expect, it } from "vitest";
import { GET as getDemo } from "../../src/app/api/epistemic-ci/demo/route";
import { POST as compile } from "../../src/app/api/epistemic-ci/compile/route";
import { POST as review } from "../../src/app/api/epistemic-ci/review/route";
import { createOwnerCookie } from "../../src/server/session/research-session";

function request(path: string, body: unknown, contentType = "application/json"): Request {
  return new Request(`http://localhost/api/epistemic-ci/${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Epistemic CI API", () => {
  it("serves the deterministic demo fixture with no-store caching", async () => {
    const priorRunSecret = process.env.RUN_TOKEN_SECRET;
    const priorOwnerSecret = process.env.OWNER_DEMO_SECRET;
    process.env.RUN_TOKEN_SECRET = "unit-test-run-secret";
    process.env.OWNER_DEMO_SECRET = "unit-test-owner-secret";
    const response = await getDemo(new Request("http://localhost/api/epistemic-ci/demo", { headers: { cookie: createOwnerCookie().split(";", 1)[0] } }));
    const body = (await response.json()) as {
      mode: string;
      baseBuild: { graph: { graphHash: string } };
      changes: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.mode).toBe("fixture");
    expect(body.changes).toHaveLength(2);
    expect(body.baseBuild.graph.graphHash).toMatch(/^[a-f0-9]{64}$/u);
    const hidden = await getDemo(new Request("http://localhost/api/epistemic-ci/demo"));
    expect(hidden.status).toBe(404);
    if (priorRunSecret === undefined) delete process.env.RUN_TOKEN_SECRET; else process.env.RUN_TOKEN_SECRET = priorRunSecret;
    if (priorOwnerSecret === undefined) delete process.env.OWNER_DEMO_SECRET; else process.env.OWNER_DEMO_SECRET = priorOwnerSecret;
  });

  it("compiles a change sequence and rejects malformed bodies", async () => {
    const response = await compile(request("compile", {
      appliedChangeIds: ["remove-drying-contradiction"],
    }));
    const body = (await response.json()) as {
      appliedChangeIds: string[];
      diff: { changedNodes: Array<{ nodeId: string; after: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.appliedChangeIds).toEqual(["remove-drying-contradiction"]);
    expect(body.diff.changedNodes).toContainEqual(expect.objectContaining({
      nodeId: "claim:loaded-duration",
      after: "insufficient",
    }));

    const malformed = await compile(request("compile", {
      appliedChangeIds: ["not-a-curated-change"],
      unexpected: true,
    }));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 422 for a duplicate change sequence", async () => {
    const response = await compile(request("compile", {
      appliedChangeIds: ["remove-drying-contradiction", "remove-drying-contradiction"],
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_SEQUENCE" },
    });
  });

  it("rejects stale review hashes and returns a tamper-checkable receipt", async () => {
    const orderedChanges = ["remove-drying-contradiction", "add-direct-loaded-72h"];
    const compiled = await compile(request("compile", { appliedChangeIds: orderedChanges }));
    const build = (await compiled.json()) as { graph: { graphHash: string } };
    const stale = await review(request("review", {
      appliedChangeIds: orderedChanges,
      expectedGraphHash: "0".repeat(64),
      action: "approve_evidence_update",
      declaredActor: "demo judge",
      rationale: "Reviewing the fixture evidence update.",
    }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_GRAPH" } });

    const approved = await review(request("review", {
      appliedChangeIds: orderedChanges,
      expectedGraphHash: build.graph.graphHash,
      action: "approve_evidence_update",
      declaredActor: "demo judge",
      rationale: "The direct loaded result is accepted for this evidence branch.",
    }));
    const body = (await approved.json()) as {
      evidenceUpdateStatus: string;
      scientificDecisionApproved: boolean;
      receipt: { receiptHash: string; graphHash: string };
      canonicalExport: string;
    };
    expect(approved.status).toBe(200);
    expect(body.evidenceUpdateStatus).toBe("merged_with_blockers");
    expect(body.scientificDecisionApproved).toBe(false);
    expect(body.receipt.graphHash).toBe(build.graph.graphHash);
    expect(body.receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.canonicalExport).toContain('"schemaVersion":"epistemic-ci.v1"');
  });

  it("requires JSON for all review fields", async () => {
    const response = await review(request("review", "not json", "text/plain"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});
