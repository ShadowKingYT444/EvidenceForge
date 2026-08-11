import { createHmac } from "node:crypto";

import { canonicalSha256, type ResearchRun } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { describe, expect, it, vi } from "vitest";
import {
  buildPacketReviewModel,
  bindPacketReviewDecisionSession,
  createPacketReviewDecisionSession,
  decidePacketReviewSession,
  preparePacketReview,
} from "../../src/features/workbench/packet-review-state";
import { submitPacketReviewDecision } from "../../src/features/workbench/packet-review-actions";

function runCopy(): ResearchRun {
  return structuredClone(goldenRunV01) as ResearchRun;
}

function recomputePacketFingerprint(run: ReturnType<typeof runCopy>) {
  const packet = run.packet!;
  packet.fingerprint = canonicalSha256({
    schemaVersion: packet.schemaVersion,
    packetVersion: packet.packetVersion,
    sourceHashes: packet.sourceHashes,
    chunkHashes: packet.chunkHashes,
    frozenAt: packet.frozenAt,
    freezeDecision: packet.freezeDecision,
  });
}

function expectBoundaryCode(input: unknown, code: string) {
  const prepared = preparePacketReview(input);
  expect(prepared.run).toBeNull();
  expect(prepared.model).toMatchObject({
    state: "error",
    canAccept: false,
    canReject: false,
    sources: [],
    boundaryError: { code },
  });
  return prepared.model;
}

function rejectedLegacyV1Accepts(token: string, now: number) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const key = process.env.EVIDENCEFORGE_PACKET_DECISION_KEY;
  if (!key) return false;
  const expected = createHmac("sha256", key)
    .update(payload, "utf8")
    .digest("base64url");
  if (signature !== expected) return false;
  const parsed = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { version?: unknown; expiresAt?: unknown };
  return (
    parsed.version === 1 &&
    typeof parsed.expiresAt === "number" &&
    now <= parsed.expiresAt
  );
}

function resignWithRejectedLegacyKey(payload: string) {
  process.env.EVIDENCEFORGE_PACKET_DECISION_KEY ??= "legacy-verifier-test-key";
  return `${payload}.${createHmac(
    "sha256",
    process.env.EVIDENCEFORGE_PACKET_DECISION_KEY,
  )
    .update(payload, "utf8")
    .digest("base64url")}`;
}

describe("passive packet review trust boundary", () => {
  it("fails closed when the run has no packet or no packet contents", () => {
    const missing = runCopy();
    missing.packet = null;
    expectBoundaryCode(missing, "packet_missing");

    const empty = runCopy();
    empty.sources = [];
    empty.chunks = [];
    empty.packet!.sourceHashes = [];
    empty.packet!.chunkHashes = [];
    recomputePacketFingerprint(empty);
    expectBoundaryCode(empty, "packet_empty");
  });

  it("rejects source, chunk, membership, and fingerprint tampering even when outer hashes are recomputed", () => {
    const chunkText = runCopy();
    chunkText.chunks[0]!.text = "tampered source passage";
    expectBoundaryCode(chunkText, "chunk_content_hash_mismatch");

    const sourceHash = runCopy();
    const forgedHash = "0".repeat(64);
    const originalHash = sourceHash.sources[0]!.contentHash;
    sourceHash.sources[0]!.contentHash = forgedHash;
    sourceHash.packet!.sourceHashes = sourceHash.packet!.sourceHashes
      .map((hash) => (hash === originalHash ? forgedHash : hash))
      .sort();
    recomputePacketFingerprint(sourceHash);
    expectBoundaryCode(sourceHash, "source_content_hash_mismatch");

    const membership = runCopy();
    membership.packet!.sourceHashes = [
      ...membership.packet!.sourceHashes.slice(1),
      "1".repeat(64),
    ].sort();
    recomputePacketFingerprint(membership);
    expectBoundaryCode(membership, "packet_source_hashes_mismatch");

    const fingerprint = runCopy();
    fingerprint.packet!.fingerprint = "2".repeat(64);
    expectBoundaryCode(fingerprint, "packet_fingerprint_mismatch");
  });

  it.each([
    ["source", (run: ReturnType<typeof runCopy>) => {
      run.sources[1]!.id = run.sources[0]!.id;
    }, "duplicate_source_id"],
    ["chunk", (run: ReturnType<typeof runCopy>) => {
      run.chunks[1]!.id = run.chunks[0]!.id;
    }, "duplicate_chunk_id"],
    ["claim", (run: ReturnType<typeof runCopy>) => {
      run.claims[1]!.id = run.claims[0]!.id;
    }, "duplicate_claim_id"],
  ] as const)("rejects duplicate %s identities", (_label, mutate, code) => {
    const run = runCopy();
    mutate(run);
    expectBoundaryCode(run, code);
  });

  it("rejects identities aliased across object classes", () => {
    const run = runCopy();
    run.chunks[0]!.id = run.sources[0]!.id;
    expectBoundaryCode(run, "duplicate_object_id");
  });

  it("rejects broken source, chunk, claim, evidence, gap, objection, execution, and error links", () => {
    const cases: Array<[string, (run: ReturnType<typeof runCopy>) => void]> = [
      ["chunk_source_missing", (run) => { run.chunks[0]!.sourceId = "missing-source"; }],
      ["claim_parent_missing", (run) => { run.claims[0]!.parentClaimId = "missing-claim"; }],
      ["evidence_chunk_missing", (run) => { run.evidenceCards[0]!.sourceChunkId = "missing-chunk"; }],
      ["evidence_claim_missing", (run) => { run.evidenceCards[0]!.subclaimId = "missing-claim"; }],
      ["evidence_execution_missing", (run) => { run.evidenceCards[0]!.modelAssessment.executionId = "missing-execution"; }],
      ["selected_gap_missing", (run) => { run.selectedGapId = "missing-gap"; }],
      ["review_execution_missing", (run) => { run.review!.reviewerExecutionId = "missing-execution"; }],
      ["revision_objection_missing", (run) => { run.revision!.decisions[0]!.objectionId = "missing-objection"; }],
      ["execution_retry_missing", (run) => { run.executions[0]!.retryOfExecutionId = "missing-execution"; }],
      ["error_execution_missing", (run) => { run.errors[0]!.executionId = "missing-execution"; }],
      ["execution_object_missing", (run) => { run.executions[0]!.inputRefs = ["missing-object"]; }],
      ["decision_objection_missing", (run) => { run.finalDecision!.unresolvedObjections = ["missing-objection"]; }],
    ];

    for (const [code, mutate] of cases) {
      const run = runCopy();
      mutate(run);
      expectBoundaryCode(run, code);
    }
  });

  it("rejects accessors without evaluating them", () => {
    const run = runCopy();
    let calls = 0;
    Object.defineProperty(run.sources[0]!.rights, "mayDisplay", {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return "allowed";
      },
    });

    expectBoundaryCode(run, "accessor_input");
    expect(calls).toBe(0);
  });

  it("rejects proxies without invoking any proxy trap", () => {
    let traps = 0;
    const proxy = new Proxy(runCopy(), {
      get() { traps += 1; throw new Error("get trap must stay untouched"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap must stay untouched"); },
      getPrototypeOf() { traps += 1; throw new Error("prototype trap must stay untouched"); },
      ownKeys() { traps += 1; throw new Error("ownKeys trap must stay untouched"); },
    });

    expectBoundaryCode(proxy, "proxy_input");
    expect(traps).toBe(0);
  });

  it("owns and freezes a synchronous snapshot before caller mutation or returned-alias mutation", () => {
    const run = runCopy();
    const originalTitle = run.sources[0]!.bibliographicMetadata.title;
    const prepared = preparePacketReview(run, "review");
    run.sources[0]!.bibliographicMetadata.title = "caller mutation";
    run.chunks[0]!.text = "caller mutation";

    expect(prepared.run?.sources[0]?.bibliographicMetadata.title).toBe(originalTitle);
    expect(prepared.model.sources[0]?.title).toBe(originalTitle);
    expect(JSON.stringify(prepared)).not.toContain("caller mutation");
    expect(Object.isFrozen(prepared.run)).toBe(true);
    expect(Object.isFrozen(prepared.model)).toBe(true);
    expect(Object.isFrozen(prepared.model.sources[0])).toBe(true);
  });

  it("mints a private single-use decision session and rejects fakes, clones, stale use, and double decisions", () => {
    const callerRun = runCopy();
    const expectedFingerprint = callerRun.packet!.fingerprint;
    const prepared = preparePacketReview(callerRun, "review");
    const session = createPacketReviewDecisionSession(prepared.model, {
      now: 100,
      ttlMs: 100,
    });
    expect(session).toMatchObject({ ok: true });
    if (!session.ok) throw new Error("expected decision session");

    callerRun.packet!.fingerprint = "f".repeat(64);

    expect(
      decidePacketReviewSession(session.sessionId, "accept", { now: 150 }),
    ).toMatchObject({
      ok: true,
      decision: "accept",
      packetFingerprint: expectedFingerprint,
    });
    expect(
      decidePacketReviewSession(session.sessionId, "reject", { now: 151 }),
    ).toMatchObject({ ok: false, error: { code: "decision_already_recorded" } });
    expect(
      decidePacketReviewSession("structural-fake", "accept", { now: 150 }),
    ).toMatchObject({ ok: false, error: { code: "invalid_session" } });
    const tokenParts = session.sessionId.split(".");
    const payload = tokenParts.at(-2)!;
    const signature = tokenParts.at(-1)!;
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
        canReject: true,
        packetFingerprint: "e".repeat(64),
      }),
      "utf8",
    ).toString("base64url");
    expect(
      decidePacketReviewSession(
        `${tokenParts[0]}.${tokenParts[1]}.${tamperedPayload}.${signature}`,
        "reject",
        { now: 150 },
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_session" } });

    const staleModel = buildPacketReviewModel(runCopy(), "review");
    const stale = createPacketReviewDecisionSession(staleModel, {
      now: 200,
      ttlMs: 10,
    });
    if (!stale.ok) throw new Error("expected stale session setup");
    expect(
      decidePacketReviewSession(stale.sessionId, "accept", { now: 211 }),
    ).toMatchObject({ ok: false, error: { code: "session_stale" } });

    const clone = structuredClone(buildPacketReviewModel(runCopy(), "review"));
    expect(createPacketReviewDecisionSession(clone)).toMatchObject({
      ok: false,
      error: { code: "invalid_packet_capability" },
    });
  });

  it("never revives signed authority at capacity and treats expiry as an exclusive bound", () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const now = 10_000;
    const ttlMs = 1_000;
    const spent = createPacketReviewDecisionSession(model, { now, ttlMs });
    if (!spent.ok) throw new Error("expected spent-session setup");
    expect(
      decidePacketReviewSession(spent.sessionId, "accept", { now: now + 1 }),
    ).toMatchObject({ ok: true, decision: "accept" });

    const active: string[] = [];
    for (let index = 0; index < 255; index += 1) {
      const session = createPacketReviewDecisionSession(model, { now, ttlMs });
      if (!session.ok) throw new Error(`expected active session ${index}`);
      active.push(session.sessionId);
    }

    expect(createPacketReviewDecisionSession(model, { now, ttlMs })).toMatchObject({
      ok: false,
      error: { code: "session_capacity_reached" },
    });
    expect(bindPacketReviewDecisionSession(model, { now, ttlMs })).toMatchObject({
      decisionSessionId: null,
      decisionSessionError: { code: "session_capacity_reached" },
      canAccept: false,
      canReject: false,
    });
    expect(
      decidePacketReviewSession(spent.sessionId, "reject", { now: now + 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "decision_already_recorded" },
    });

    expect(
      decidePacketReviewSession(active[0]!, "reject", { now: now + 2 }),
    ).toMatchObject({ ok: true, decision: "reject" });
    expect(createPacketReviewDecisionSession(model, { now, ttlMs })).toMatchObject({
      ok: false,
      error: { code: "session_capacity_reached" },
    });

    expect(
      decidePacketReviewSession(active[1]!, "accept", { now: now + ttlMs - 1 }),
    ).toMatchObject({ ok: true, decision: "accept" });
    expect(
      decidePacketReviewSession(active[2]!, "accept", { now: now + ttlMs }),
    ).toMatchObject({ ok: false, error: { code: "session_stale" } });

    const afterExpiry = createPacketReviewDecisionSession(model, {
      now: now + ttlMs,
      ttlMs,
    });
    expect(afterExpiry).toMatchObject({ ok: true });
    expect(
      decidePacketReviewSession(spent.sessionId, "reject", {
        now: now + ttlMs - 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_session" } });
  });

  it("fails closed across clock rollback, forward expiry, and opposite duplicate decisions", () => {
    const model = preparePacketReview(runCopy(), "review").model;
    expect(
      createPacketReviewDecisionSession(model, {
        now: Number.MAX_VALUE,
        ttlMs: Number.MAX_VALUE,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_session_options" },
    });
    const rollback = createPacketReviewDecisionSession(model, {
      now: 20_000,
      ttlMs: 100,
    });
    if (!rollback.ok) throw new Error("expected rollback-session setup");
    expect(
      decidePacketReviewSession(rollback.sessionId, "accept", { now: 19_999 }),
    ).toMatchObject({
      ok: false,
      error: { code: "session_clock_rollback" },
    });
    expect(
      decidePacketReviewSession(rollback.sessionId, "accept", { now: 20_000 }),
    ).toMatchObject({ ok: true, decision: "accept" });
    expect(
      decidePacketReviewSession(rollback.sessionId, "reject", { now: 20_001 }),
    ).toMatchObject({
      ok: false,
      error: { code: "decision_already_recorded" },
    });

    const forward = createPacketReviewDecisionSession(model, {
      now: 30_000,
      ttlMs: 10,
    });
    if (!forward.ok) throw new Error("expected forward-session setup");
    expect(
      decidePacketReviewSession(forward.sessionId, "accept", { now: 30_011 }),
    ).toMatchObject({ ok: false, error: { code: "session_stale" } });
    expect(
      decidePacketReviewSession(forward.sessionId, "accept", { now: 30_005 }),
    ).toMatchObject({ ok: false, error: { code: "invalid_session" } });
  });

  it("allows exactly one of two concurrent opposite server decisions", async () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const session = createPacketReviewDecisionSession(model);
    if (!session.ok) throw new Error("expected concurrent-session setup");

    const results = await Promise.all([
      submitPacketReviewDecision(session.sessionId, "accept"),
      submitPacketReviewDecision(session.sessionId, "reject"),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "decision_already_recorded" }),
      }),
    ]);
  });

  it("makes current capabilities unrecognizable to the rejected legacy v1 verifier", () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const session = createPacketReviewDecisionSession(model, {
      now: 40_000,
      ttlMs: 50,
    });
    if (!session.ok) throw new Error("expected version-bound session setup");
    expect(
      decidePacketReviewSession(session.sessionId, "accept", { now: 40_050 }),
    ).toMatchObject({ ok: false, error: { code: "session_stale" } });
    const currentKey = process.env.EVIDENCEFORGE_PACKET_DECISION_KEY_V2;
    if (!currentKey) throw new Error("expected current decision key");
    process.env.EVIDENCEFORGE_PACKET_DECISION_KEY = currentKey;
    expect(rejectedLegacyV1Accepts(session.sessionId, 40_050)).toBe(false);
    const parts = session.sessionId.split(".");
    expect(
      rejectedLegacyV1Accepts(`${parts.at(-2)}.${parts.at(-1)}`, 40_050),
    ).toBe(false);
  });

  it("rejects legacy, downgraded, upgraded, stripped, and legacy-resigned tokens without consuming current authority", () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const current = createPacketReviewDecisionSession(model, {
      now: 50_000,
      ttlMs: 100,
    });
    if (!current.ok) throw new Error("expected cross-version session setup");

    const currentParts = current.sessionId.split(".");
    const currentPayload = currentParts.at(-2)!;
    const currentSignature = currentParts.at(-1)!;
    const currentPrefix = `${currentParts[0]}.${currentParts[1]}`;
    const currentClaims = JSON.parse(
      Buffer.from(currentPayload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const legacyClaims = {
      version: 1,
      nonce: currentClaims.nonce,
      packetFingerprint: currentClaims.packetFingerprint,
      canAccept: true,
      canReject: true,
      expiresAt: 50_100,
    };
    const legacyPayload = Buffer.from(
      JSON.stringify(legacyClaims),
      "utf8",
    ).toString("base64url");
    const mutations = [
      resignWithRejectedLegacyKey(legacyPayload),
      `${currentPayload}.${currentSignature}`,
      `${currentPrefix}.${Buffer.from(JSON.stringify({ ...currentClaims, version: 1 }), "utf8").toString("base64url")}.${currentSignature}`,
      `${currentPrefix}.${Buffer.from(JSON.stringify({ ...currentClaims, version: 999 }), "utf8").toString("base64url")}.${currentSignature}`,
      `${currentPrefix}.${Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(currentClaims).filter(([key]) => key !== "domain"))), "utf8").toString("base64url")}.${currentSignature}`,
      resignWithRejectedLegacyKey(currentPayload),
    ];
    for (const token of mutations) {
      expect(
        decidePacketReviewSession(token, "accept", { now: 50_001 }),
      ).toMatchObject({ ok: false, error: { code: "invalid_session" } });
    }
    expect(
      decidePacketReviewSession(current.sessionId, "accept", { now: 50_001 }),
    ).toMatchObject({ ok: true, decision: "accept" });
  });

  it("passively rejects every non-enum runtime decision without consuming the session", () => {
    const model = preparePacketReview(runCopy(), "review").model;
    let traps = 0;
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "accept";
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() { traps += 1; throw new Error("decision proxy get trap"); },
        getOwnPropertyDescriptor() { traps += 1; throw new Error("decision proxy descriptor trap"); },
        getPrototypeOf() { traps += 1; throw new Error("decision proxy prototype trap"); },
        ownKeys() { traps += 1; throw new Error("decision proxy ownKeys trap"); },
      },
    );
    const invalidDecisions: unknown[] = [
      "approve",
      "reject ",
      "",
      1,
      null,
      {},
      accessor,
      proxy,
    ];

    for (const invalidDecision of invalidDecisions) {
      const session = createPacketReviewDecisionSession(model);
      if (!session.ok) throw new Error("expected invalid-decision session setup");
      expect(
        decidePacketReviewSession(
          session.sessionId,
          invalidDecision as never,
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_decision" } });
      expect(
        decidePacketReviewSession(session.sessionId, "accept"),
      ).toMatchObject({ ok: true, decision: "accept" });
    }
    expect(accessorCalls).toBe(0);
    expect(traps).toBe(0);
  });

  it("validates the server-action decision before consuming its session", async () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const session = createPacketReviewDecisionSession(model);
    if (!session.ok) throw new Error("expected server-action validation setup");

    await expect(
      submitPacketReviewDecision(session.sessionId, "approve" as never),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_decision" },
    });
    await expect(
      submitPacketReviewDecision(session.sessionId, "accept"),
    ).resolves.toMatchObject({ ok: true, decision: "accept" });
  });

  it("shares current registry authority across a fresh module instance", async () => {
    const model = preparePacketReview(runCopy(), "review").model;
    const session = createPacketReviewDecisionSession(model);
    if (!session.ok) throw new Error("expected module-reset session setup");

    vi.resetModules();
    const freshState = await import(
      "../../src/features/workbench/packet-review-state"
    );
    expect(
      freshState.decidePacketReviewSession(session.sessionId, "accept"),
    ).toMatchObject({ ok: true, decision: "accept" });
  });
});
