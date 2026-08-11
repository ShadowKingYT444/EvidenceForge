import { describe, expect, it } from "vitest";

import {
  HumanDecisionSchema,
  ResearchRunSchema,
  RunErrorSchema,
  canonicalSha256,
  type NodeExecution,
  type ResearchRun,
} from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  LEGAL_TRANSITIONS,
  InMemoryWorkflowRunStore,
  DuplicateRunError,
  InvalidExecutionAttemptError,
  InvalidTransitionError,
  MissingCheckpointError,
  NodeStartGuardError,
  RevisionConflictError,
  RunNotFoundError,
  advanceRun,
  appendExecutionAttempt,
  assertNodeMayStart,
  decideFinalApproval,
  failRun,
  persistObjectionDispositions,
  persistPacketApproval,
  persistScopeApproval,
  runGuardedNodeEffect,
  validateWorkflowMutation,
  type RunStatus,
} from "../../src/server/workflow";

type RunError = ReturnType<typeof RunErrorSchema.parse>;

const baseTimestamp = "2026-08-06T17:29:00.000Z";
const timestamp = "2026-08-06T17:30:00.000Z";
const nextTimestamp = "2026-08-06T17:31:00.000Z";
const thirdTimestamp = "2026-08-06T17:32:00.000Z";
const fourthTimestamp = "2026-08-06T17:33:00.000Z";
const fifthTimestamp = "2026-08-06T17:34:00.000Z";
const goldenObjectionDispositions =
  goldenRunV01.revision!.decisions.map(
    ({ objectionId, disposition, basis }) => ({
      objectionId,
      disposition,
      basis,
    }),
  );

function blankRun(status: RunStatus = "draft"): ResearchRun {
  return ResearchRunSchema.parse({
    ...structuredClone(goldenRunV01),
    id: "workflow-run",
    status,
    updatedAt: baseTimestamp,
    claims: [],
    scopeDecision: null,
    packet: null,
    sources: [],
    chunks: [],
    evidenceCards: [],
    conclusions: [],
    researchGaps: [],
    selectedGapId: null,
    experiment: null,
    review: null,
    objectionDispositionDecision: null,
    revision: null,
    finalDecision: null,
    executions: [],
    errors: [],
  });
}

function decision(
  checkpoint: "scope" | "objection_dispositions" | "final",
  choice = "approve",
) {
  return HumanDecisionSchema.parse({
    id: `decision-${checkpoint}`,
    checkpoint,
    optionsShown: ["approve", "reject"],
    decision: choice,
    edits: [],
    decidedAt: timestamp,
    unresolvedObjections: [],
  });
}

function packetMaterials(run: ResearchRun): ResearchRun {
  return ResearchRunSchema.parse({
    ...run,
    sources: structuredClone(goldenRunV01.sources),
    chunks: structuredClone(goldenRunV01.chunks),
  });
}

function runPreparedFor(status: RunStatus): ResearchRun {
  return ResearchRunSchema.parse({
    ...blankRun(status),
    scopeDecision: decision("scope"),
    packet: structuredClone(goldenRunV01.packet),
    sources: structuredClone(goldenRunV01.sources),
    chunks: structuredClone(goldenRunV01.chunks),
    review: structuredClone(goldenRunV01.review),
    objectionDispositionDecision:
      status === "awaiting_objection_dispositions"
        ? null
        : structuredClone(goldenRunV01.objectionDispositionDecision),
    revision:
      status === "awaiting_objection_dispositions"
        ? null
        : structuredClone(goldenRunV01.revision),
    finalDecision:
      status === "awaiting_final_approval" ? null : decision("final"),
    errors:
      status === "awaiting_final_approval"
        ? [
            {
              id: "terminal-error",
              kind: "invariant_violation",
              message: "The run cannot continue.",
              nodeId: "finalize",
              executionId: null,
              retryable: false,
              occurredAt: timestamp,
              details: {
                field: null,
                providerCode: null,
                httpStatus: null,
              },
            },
          ]
        : [],
  });
}

function storeAtAwaitingScope(store: InMemoryWorkflowRunStore) {
  let snapshot = store.create(blankRun());
  snapshot = store.save(
    advanceRun(snapshot.run, "decomposing", timestamp),
    snapshot.revision,
  );
  return store.save(
    advanceRun(snapshot.run, "awaiting_scope_approval", nextTimestamp),
    snapshot.revision,
  );
}

function storeAtCollectingSources(store: InMemoryWorkflowRunStore) {
  const awaitingScope = storeAtAwaitingScope(store);
  return store.save(
    persistScopeApproval(
      awaitingScope.run,
      decision("scope"),
      thirdTimestamp,
    ),
    awaitingScope.revision,
  );
}

function minuteAfter(run: ResearchRun): string {
  return new Date(Date.parse(run.updatedAt) + 60_000).toISOString();
}

function storeAtApprovedPacket(store: InMemoryWorkflowRunStore) {
  let snapshot = storeAtCollectingSources(store);
  const baseExecution = structuredClone(goldenRunV01.executions[0]);
  const collectionAttempt = appendExecutionAttempt(
    snapshot.run,
    {
      ...baseExecution,
      id: "stored-collection-attempt",
      nodeId: "collect-sources",
      attempt: 1,
      retryOfExecutionId: null,
    },
    [],
    minuteAfter(snapshot.run),
  );
  snapshot = store.save(
    {
      ...collectionAttempt,
      sources: structuredClone(goldenRunV01.sources),
      chunks: structuredClone(goldenRunV01.chunks),
    },
    snapshot.revision,
  );
  snapshot = store.save(
    advanceRun(
      snapshot.run,
      "awaiting_packet_approval",
      minuteAfter(snapshot.run),
    ),
    snapshot.revision,
  );
  return store.save(
    persistPacketApproval(
      snapshot.run,
      goldenRunV01.packet!,
      minuteAfter(snapshot.run),
    ),
    snapshot.revision,
  );
}

const statuses = [
  "draft",
  "decomposing",
  "awaiting_scope_approval",
  "collecting_sources",
  "awaiting_packet_approval",
  "extracting_evidence",
  "verifying_evidence",
  "synthesizing",
  "planning_experiment",
  "reviewing_experiment",
  "awaiting_objection_dispositions",
  "revising_experiment",
  "awaiting_final_approval",
  "approved",
  "rejected",
  "failed",
] as const satisfies readonly RunStatus[];

const expectedLegalEdges = [
  ["draft", "decomposing"],
  ["decomposing", "awaiting_scope_approval"],
  ["awaiting_scope_approval", "collecting_sources"],
  ["collecting_sources", "awaiting_packet_approval"],
  ["awaiting_packet_approval", "extracting_evidence"],
  ["extracting_evidence", "verifying_evidence"],
  ["verifying_evidence", "synthesizing"],
  ["synthesizing", "planning_experiment"],
  ["planning_experiment", "reviewing_experiment"],
  ["planning_experiment", "awaiting_final_approval"],
  ["reviewing_experiment", "awaiting_objection_dispositions"],
  ["awaiting_objection_dispositions", "revising_experiment"],
  ["revising_experiment", "awaiting_final_approval"],
  ["awaiting_final_approval", "approved"],
  ["awaiting_final_approval", "rejected"],
] as const satisfies readonly (readonly [RunStatus, RunStatus])[];

describe("workflow lifecycle", () => {
  it("accepts every declared lifecycle edge", () => {
    const exportedEdges = Object.entries(LEGAL_TRANSITIONS).flatMap(
      ([from, destinations]) =>
        destinations.map((to) => [from, to] as const),
    );
    expect(exportedEdges).toEqual(expectedLegalEdges);

    for (const [from, to] of expectedLegalEdges) {
      const current = runPreparedFor(from);
      const transitioned =
        from === "awaiting_objection_dispositions"
          ? persistObjectionDispositions(
              current,
              structuredClone(
                goldenRunV01.objectionDispositionDecision!,
              ),
              goldenObjectionDispositions,
              nextTimestamp,
            ).run
          : from === "revising_experiment"
            ? advanceRun(
                current,
                to,
                nextTimestamp,
                goldenObjectionDispositions,
              )
          : from === "awaiting_final_approval"
          ? decideFinalApproval(
              { ...current, finalDecision: null },
              {
                ...structuredClone(goldenRunV01.finalDecision!),
                decision: to === "approved" ? "approve" : "reject",
              },
              nextTimestamp,
            )
          : advanceRun(current, to, nextTimestamp);

      expect(transitioned.status, `${from} -> ${to}`).toBe(to);
      expect(transitioned.updatedAt).toBe(nextTimestamp);
    }
  });

  it("rejects every undeclared transition, including terminal exits and self loops", () => {
    const declared = new Set(
      expectedLegalEdges.map(([from, to]) => `${from}->${to}`),
    );

    for (const from of statuses) {
      for (const to of statuses) {
        if (declared.has(`${from}->${to}`)) {
          continue;
        }
        expect(
          () => advanceRun(runPreparedFor(from), to, nextTimestamp),
          `${from} -> ${to} must be rejected`,
        ).toThrow(InvalidTransitionError);
      }
    }
  });

  it("blocks and persists the scope, packet, objection, and final checkpoints", () => {
    expect(() =>
      advanceRun(
        blankRun("awaiting_scope_approval"),
        "collecting_sources",
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const scoped = persistScopeApproval(
      blankRun("awaiting_scope_approval"),
      decision("scope"),
      nextTimestamp,
    );
    expect(scoped.status).toBe("collecting_sources");
    expect(scoped.scopeDecision).toEqual(decision("scope"));

    expect(() =>
      advanceRun(
        { ...scoped, status: "awaiting_packet_approval" },
        "extracting_evidence",
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const packetApproved = persistPacketApproval(
      packetMaterials({
        ...scoped,
        status: "awaiting_packet_approval",
      }),
      goldenRunV01.packet!,
      thirdTimestamp,
    );
    expect(packetApproved.status).toBe("extracting_evidence");
    expect(packetApproved.packet).toEqual(goldenRunV01.packet);

    expect(() =>
      advanceRun(
        {
          ...packetApproved,
          status: "awaiting_objection_dispositions",
          review: structuredClone(goldenRunV01.review),
        },
        "revising_experiment",
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const objectionTransition = persistObjectionDispositions(
      {
        ...packetApproved,
        status: "awaiting_objection_dispositions",
        review: structuredClone(goldenRunV01.review),
      },
      structuredClone(goldenRunV01.objectionDispositionDecision!),
      goldenObjectionDispositions,
      fourthTimestamp,
    );
    const objectionsPersisted = objectionTransition.run;
    expect(objectionsPersisted.status).toBe("revising_experiment");
    expect(objectionsPersisted.objectionDispositionDecision).toEqual(
      goldenRunV01.objectionDispositionDecision,
    );
    expect(objectionsPersisted.revision).toBeNull();
    expect(objectionTransition.objectionDispositions).toEqual(
      goldenObjectionDispositions,
    );

    expect(() =>
      advanceRun(
        {
          ...objectionsPersisted,
          status: "awaiting_final_approval",
          updatedAt: baseTimestamp,
          revision: structuredClone(goldenRunV01.revision),
        },
        "approved",
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const approved = decideFinalApproval(
      {
        ...objectionsPersisted,
        status: "awaiting_final_approval",
        updatedAt: baseTimestamp,
        revision: structuredClone(goldenRunV01.revision),
      },
      structuredClone(goldenRunV01.finalDecision!),
      nextTimestamp,
    );
    expect(approved.status).toBe("approved");
    expect(approved.finalDecision).toEqual(goldenRunV01.finalDecision);
  });

  it("rejects malformed, unsupported, replacement, and mismatched checkpoint decisions", () => {
    const awaitingScope = blankRun("awaiting_scope_approval");
    expect(() =>
      persistScopeApproval(
        awaitingScope,
        {
          ...decision("scope", "reject"),
          optionsShown: ["approve", "reject"],
        },
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
    expect(() =>
      persistScopeApproval(
        awaitingScope,
        {
          ...decision("scope"),
          optionsShown: ["reject"],
        },
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
    expect(() =>
      persistScopeApproval(
        {
          ...awaitingScope,
          scopeDecision: decision("scope"),
        },
        decision("scope"),
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
    expect(awaitingScope.scopeDecision).toBeNull();

    expect(() =>
      persistPacketApproval(
        packetMaterials({
          ...blankRun("awaiting_packet_approval"),
          scopeDecision: decision("scope"),
        }),
        {
          ...structuredClone(goldenRunV01.packet!),
          fingerprint: "a".repeat(64),
        },
        nextTimestamp,
      ),
    ).toThrow();

    expect(() =>
      persistObjectionDispositions(
        {
          ...blankRun("awaiting_objection_dispositions"),
          review: structuredClone(goldenRunV01.review),
        },
        {
          ...structuredClone(goldenRunV01.objectionDispositionDecision!),
          unresolvedObjections: ["unknown-objection"],
        },
        goldenObjectionDispositions,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
    expect(() =>
      persistObjectionDispositions(
        {
          ...blankRun("awaiting_objection_dispositions"),
          review: structuredClone(goldenRunV01.review),
        },
        structuredClone(goldenRunV01.objectionDispositionDecision!),
        goldenObjectionDispositions.slice(1),
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    expect(() =>
      decideFinalApproval(
        blankRun("awaiting_final_approval"),
        {
          ...decision("final", "request revision"),
          optionsShown: ["approve", "request revision", "reject"],
        },
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
    expect(() =>
      decideFinalApproval(
        {
          ...runPreparedFor("awaiting_final_approval"),
          finalDecision: null,
        },
        {
          ...structuredClone(goldenRunV01.finalDecision!),
          unresolvedObjections: [],
        },
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);
  });

  it("binds packet approval and model work to the run's exact rights-approved content", () => {
    const { fingerprint: _fingerprint, ...packetPayload } =
      goldenRunV01.packet!;
    void _fingerprint;
    const emptyPacketPayload = {
      ...packetPayload,
      sourceHashes: [],
      chunkHashes: [],
    };
    const emptyPacket = {
      ...emptyPacketPayload,
      fingerprint: canonicalSha256(emptyPacketPayload),
    };
    expect(() =>
      persistPacketApproval(
        {
          ...blankRun("awaiting_packet_approval"),
          scopeDecision: decision("scope"),
        },
        emptyPacket,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    expect(() =>
      persistPacketApproval(
        {
          ...blankRun("awaiting_packet_approval"),
          scopeDecision: decision("scope"),
        },
        goldenRunV01.packet!,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const duplicateHashRecords = packetMaterials({
      ...blankRun("awaiting_packet_approval"),
      scopeDecision: decision("scope"),
    });
    duplicateHashRecords.sources.push({
      ...structuredClone(duplicateHashRecords.sources[0]),
      id: "duplicate-source-record",
    });
    duplicateHashRecords.chunks.push({
      ...structuredClone(duplicateHashRecords.chunks[0]),
      id: "duplicate-chunk-record",
    });
    expect(() =>
      persistPacketApproval(
        duplicateHashRecords,
        goldenRunV01.packet!,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const mismatchedChunks = packetMaterials({
      ...blankRun("awaiting_packet_approval"),
      scopeDecision: decision("scope"),
    });
    mismatchedChunks.chunks = mismatchedChunks.chunks.slice(1);
    expect(() =>
      persistPacketApproval(
        mismatchedChunks,
        goldenRunV01.packet!,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    const mismatchedSources = packetMaterials({
      ...blankRun("awaiting_packet_approval"),
      scopeDecision: decision("scope"),
    });
    mismatchedSources.sources = mismatchedSources.sources.slice(1);
    expect(() =>
      persistPacketApproval(
        mismatchedSources,
        goldenRunV01.packet!,
        nextTimestamp,
      ),
    ).toThrow(MissingCheckpointError);

    for (const maySendToModel of ["denied", "unknown"] as const) {
      const guarded = packetMaterials(
        blankRun("extracting_evidence"),
      );
      guarded.packet = structuredClone(goldenRunV01.packet);
      guarded.sources[0].rights.maySendToModel = maySendToModel;
      let effects = 0;
      expect(() =>
        runGuardedNodeEffect(guarded, "extract-evidence", () => {
          effects += 1;
        }),
      ).toThrow(NodeStartGuardError);
      expect(effects).toBe(0);
    }
  });

  it("requires a visible error before entering the failed terminal state", () => {
    expect(() =>
      failRun(
        blankRun("awaiting_final_approval"),
        {
          id: "failure",
          kind: "invariant_violation",
          message: "A visible terminal failure.",
          nodeId: "finalize",
          executionId: null,
          retryable: false,
          occurredAt: timestamp,
          details: {
            field: null,
            providerCode: null,
            httpStatus: null,
          },
        },
        nextTimestamp,
      ),
    ).not.toThrow();

    const current = blankRun("collecting_sources");
    const error: RunError = {
      id: "failure",
      kind: "invariant_violation",
      message: "A visible terminal failure.",
      nodeId: "collect-sources",
      executionId: null,
      retryable: false,
      occurredAt: timestamp,
      details: {
        field: null,
        providerCode: null,
        httpStatus: null,
      },
    };
    const failed = failRun(
      current,
      error,
      nextTimestamp,
    );
    expect(failed.status).toBe("failed");
    expect(failed.errors).toHaveLength(1);
    expect(current.status).toBe("collecting_sources");
    expect(current.errors).toEqual([]);
    expect(() => failRun(failed, { ...error, id: "another" }, nextTimestamp)).toThrow(
      InvalidTransitionError,
    );

    const approved = runPreparedFor("approved");
    expect(() =>
      validateWorkflowMutation(approved, {
        ...approved,
        updatedAt: nextTimestamp,
        intake: {
          ...approved.intake,
          originalQuestion: "Mutated after approval",
        },
      }),
    ).toThrow(InvalidTransitionError);
  });
});

describe("workflow execution guards and retry history", () => {
  it("prevents source work before scope approval and model work before packet approval", () => {
    let effects = 0;
    expect(() =>
      runGuardedNodeEffect(
        blankRun("collecting_sources"),
        "collect-sources",
        () => {
          effects += 1;
          return "must not run";
        },
      ),
    ).toThrow(NodeStartGuardError);
    expect(effects).toBe(0);

    const scoped = {
      ...blankRun("collecting_sources"),
      scopeDecision: decision("scope"),
    };
    expect(
      runGuardedNodeEffect(scoped, "collect-sources", () => {
        effects += 1;
        return "ran";
      }),
    ).toBe("ran");
    expect(effects).toBe(1);

    for (const [status, node] of [
      ["extracting_evidence", "extract-evidence"],
      ["verifying_evidence", "assess-entailment"],
      ["synthesizing", "synthesize-conclusions"],
      ["planning_experiment", "plan-experiment"],
      ["reviewing_experiment", "review-experiment"],
    ] as const) {
      expect(() => assertNodeMayStart(blankRun(status), node)).toThrow(
        NodeStartGuardError,
      );
    }

    expect(() =>
      assertNodeMayStart(
        {
          ...blankRun("revising_experiment"),
          packet: structuredClone(goldenRunV01.packet),
        },
        "revise-experiment",
      ),
    ).toThrow(NodeStartGuardError);
    expect(() =>
      assertNodeMayStart(blankRun("decomposing"), "typo-node" as never),
    ).toThrow(NodeStartGuardError);
  });

  it("leaves stored state and revision untouched when a guarded effect is blocked", () => {
    const store = new InMemoryWorkflowRunStore();
    const created = store.create(blankRun());
    const forgedLaterState = {
      ...created.run,
      status: "collecting_sources" as const,
    };
    let calls = 0;

    expect(() =>
      runGuardedNodeEffect(
        forgedLaterState,
        "collect-sources",
        () => {
          calls += 1;
        },
      ),
    ).toThrow(NodeStartGuardError);

    expect(calls).toBe(0);
    expect(store.load("workflow-run")).toEqual(created);
  });

  it("keeps failed attempts and linked errors beside a higher numbered retry", () => {
    const baseExecution = structuredClone(goldenRunV01.executions[0]);
    const failure = {
      ...baseExecution,
      id: "attempt-1",
      nodeId: "collect-sources",
      attempt: 1,
      status: "failed",
      outputRefs: [],
      validation: { valid: false, issues: ["fixture transport failed"] },
      errorIds: ["attempt-error"],
      retryOfExecutionId: null,
    } satisfies NodeExecution;
    const error = {
      id: "attempt-error",
      kind: "provider_failure",
      message: "Fixture transport failed.",
      nodeId: "collect-sources",
      executionId: "attempt-1",
      retryable: true,
      occurredAt: timestamp,
      details: {
        field: null,
        providerCode: "FIXTURE_FAILURE",
        httpStatus: null,
      },
    } satisfies RunError;
    const afterFailure = appendExecutionAttempt(
      {
        ...blankRun("collecting_sources"),
        scopeDecision: decision("scope"),
      },
      failure,
      [error],
      timestamp,
    );

    const retry = {
      ...baseExecution,
      id: "attempt-2",
      nodeId: "collect-sources",
      attempt: 2,
      status: "succeeded",
      errorIds: [],
      retryOfExecutionId: "attempt-1",
    } satisfies NodeExecution;
    const afterRetry = appendExecutionAttempt(
      afterFailure,
      retry,
      [],
      nextTimestamp,
    );

    expect(afterRetry.executions.map(({ id }) => id)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(afterRetry.errors).toEqual([error]);
    expect(afterRetry.executions[1].retryOfExecutionId).toBe("attempt-1");
  });

  it("rejects skipped attempts, retries of success, missing links, and history erasure", () => {
    const baseExecution = structuredClone(goldenRunV01.executions[0]);
    const runnable = {
      ...blankRun("collecting_sources"),
      scopeDecision: decision("scope"),
    };

    expect(() =>
      appendExecutionAttempt(
        runnable,
        {
          ...baseExecution,
          id: "attempt-2",
          nodeId: "collect-sources",
          attempt: 2,
          retryOfExecutionId: null,
        },
        [],
        timestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);

    const duplicateErrorAttempt = {
      ...baseExecution,
      id: "duplicate-error-attempt",
      nodeId: "collect-sources",
      attempt: 1,
      status: "failed",
      outputRefs: [],
      validation: { valid: false, issues: ["two terminal causes"] },
      errorIds: ["duplicate-error-a", "duplicate-error-a"],
      retryOfExecutionId: null,
    } satisfies NodeExecution;
    expect(() =>
      appendExecutionAttempt(
        runnable,
        duplicateErrorAttempt,
        [
          {
            id: "duplicate-error-a",
            kind: "provider_failure",
            message: "First cause.",
            nodeId: "collect-sources",
            executionId: "duplicate-error-attempt",
            retryable: true,
            occurredAt: timestamp,
            details: {
              field: null,
              providerCode: "FIRST",
              httpStatus: null,
            },
          },
          {
            id: "duplicate-error-b",
            kind: "timeout",
            message: "Second cause.",
            nodeId: "collect-sources",
            executionId: "duplicate-error-attempt",
            retryable: true,
            occurredAt: timestamp,
            details: {
              field: null,
              providerCode: "SECOND",
              httpStatus: null,
            },
          },
        ],
        timestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);

    expect(() =>
      appendExecutionAttempt(
        runnable,
        {
          ...baseExecution,
          id: "failed-without-error",
          nodeId: "collect-sources",
          attempt: 1,
          status: "failed",
          outputRefs: [],
          validation: { valid: false, issues: ["failed"] },
          errorIds: ["missing-error"],
          retryOfExecutionId: null,
        },
        [],
        timestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);

    const afterSuccess = appendExecutionAttempt(
      runnable,
      {
        ...baseExecution,
        id: "success-1",
        nodeId: "collect-sources",
        attempt: 1,
        retryOfExecutionId: null,
      },
      [],
      timestamp,
    );
    expect(() =>
      appendExecutionAttempt(
        afterSuccess,
        {
          ...baseExecution,
          id: "retry-success",
          nodeId: "collect-sources",
          attempt: 2,
          retryOfExecutionId: "success-1",
        },
        [],
        nextTimestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);

    const store = new InMemoryWorkflowRunStore();
    const collecting = storeAtCollectingSources(store);
    const storedSuccess = appendExecutionAttempt(
      collecting.run,
      {
        ...baseExecution,
        id: "stored-success-1",
        nodeId: "collect-sources",
        attempt: 1,
        retryOfExecutionId: null,
      },
      [],
      fourthTimestamp,
    );
    const created = store.save(storedSuccess, collecting.revision);
    const erased = {
      ...created.run,
      updatedAt: fifthTimestamp,
      executions: [],
    };
    expect(() => store.save(erased, created.revision)).toThrow(
      InvalidExecutionAttemptError,
    );

    const nonretryableFailure = appendExecutionAttempt(
      runnable,
      {
        ...baseExecution,
        id: "nonretryable-1",
        nodeId: "collect-sources",
        attempt: 1,
        status: "failed",
        outputRefs: [],
        validation: { valid: false, issues: ["terminal fixture error"] },
        errorIds: ["nonretryable-error"],
        retryOfExecutionId: null,
      },
      [
        {
          id: "nonretryable-error",
          kind: "missing_source",
          message: "The fixture source does not exist.",
          nodeId: "collect-sources",
          executionId: "nonretryable-1",
          retryable: false,
          occurredAt: timestamp,
          details: {
            field: "doi",
            providerCode: "DOI_NOT_FOUND",
            httpStatus: 404,
          },
        },
      ],
      timestamp,
    );
    expect(() =>
      appendExecutionAttempt(
        nonretryableFailure,
        {
          ...baseExecution,
          id: "invalid-retry",
          nodeId: "collect-sources",
          attempt: 2,
          retryOfExecutionId: "nonretryable-1",
        },
        [],
        nextTimestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);

    const mixedFailure = appendExecutionAttempt(
      runnable,
      {
        ...baseExecution,
        id: "mixed-failure",
        nodeId: "collect-sources",
        attempt: 1,
        status: "failed",
        outputRefs: [],
        validation: { valid: false, issues: ["mixed causes"] },
        errorIds: ["retryable-cause", "terminal-cause"],
        retryOfExecutionId: null,
      },
      [
        {
          id: "retryable-cause",
          kind: "timeout",
          message: "Retryable timeout.",
          nodeId: "collect-sources",
          executionId: "mixed-failure",
          retryable: true,
          occurredAt: timestamp,
          details: {
            field: null,
            providerCode: "TIMEOUT",
            httpStatus: null,
          },
        },
        {
          id: "terminal-cause",
          kind: "rights_denied",
          message: "Rights block retries.",
          nodeId: "collect-sources",
          executionId: "mixed-failure",
          retryable: false,
          occurredAt: timestamp,
          details: {
            field: "rights.maySendToModel",
            providerCode: null,
            httpStatus: null,
          },
        },
      ],
      timestamp,
    );
    expect(() =>
      appendExecutionAttempt(
        mixedFailure,
        {
          ...baseExecution,
          id: "mixed-retry",
          nodeId: "collect-sources",
          attempt: 2,
          retryOfExecutionId: "mixed-failure",
        },
        [],
        nextTimestamp,
      ),
    ).toThrow(InvalidExecutionAttemptError);
  });
});

describe("process-local workflow persistence", () => {
  it("states its durability limits and supports explicit reset", () => {
    const store = new InMemoryWorkflowRunStore();
    expect(store.capabilities).toEqual({
      scope: "process_local",
      survivesCallsWithinProcess: true,
      survivesProcessRestart: false,
      diskDurable: false,
      multiProcessSafe: false,
    });

    expect(() =>
      store.create({
        ...blankRun(),
        status: "approved",
      }),
    ).toThrow(InvalidTransitionError);
    store.create(blankRun());
    expect(() => store.create(blankRun())).toThrow(DuplicateRunError);
    expect(store.load("workflow-run")).not.toBeNull();
    store.reset();
    expect(store.load("workflow-run")).toBeNull();
    expect(new InMemoryWorkflowRunStore().load("workflow-run")).toBeNull();
  });

  it("returns isolated clones and rejects stale optimistic revisions", () => {
    const store = new InMemoryWorkflowRunStore();
    const callerOwned = blankRun();
    const created = store.create(callerOwned);
    callerOwned.status = "failed";
    expect(store.load("workflow-run")!.run.status).toBe("draft");
    const firstRead = store.load("workflow-run")!;
    firstRead.run.status = "failed";
    firstRead.run.errors.push({
      id: "mutation",
      kind: "invariant_violation",
      message: "Caller-owned mutation",
      nodeId: "test",
      executionId: null,
      retryable: false,
      occurredAt: timestamp,
      details: { field: null, providerCode: null, httpStatus: null },
    });

    expect(store.load("workflow-run")!.run.status).toBe("draft");
    expect(store.load("workflow-run")!.run.errors).toEqual([]);

    const advanced = advanceRun(
      created.run,
      "decomposing",
      nextTimestamp,
    );
    const saved = store.save(advanced, created.revision);
    expect(saved.revision).not.toBe(created.revision);
    expect(() => store.save(advanced, created.revision)).toThrow(
      RevisionConflictError,
    );

    store.reset();
    const recreated = store.create(blankRun());
    expect(recreated.revision).not.toBe(created.revision);
    expect(() => store.save(advanced, created.revision)).toThrow(
      RevisionConflictError,
    );
    expect(() =>
      store.save({ ...advanced, id: "missing-run" }, recreated.revision),
    ).toThrow(RunNotFoundError);
  });

  it("rejects lifecycle skips and malformed history at the public save boundary", () => {
    const store = new InMemoryWorkflowRunStore();
    const created = store.create(blankRun());

    expect(() =>
      store.save(
        {
          ...created.run,
          status: "approved",
          updatedAt: nextTimestamp,
        },
        created.revision,
      ),
    ).toThrow(InvalidTransitionError);
    expect(store.load("workflow-run")).toEqual(created);
    expect(() =>
      store.save(
        {
          ...created.run,
          status: "decomposing",
          updatedAt: nextTimestamp,
          sources: structuredClone(goldenRunV01.sources),
        },
        created.revision,
      ),
    ).toThrow(InvalidTransitionError);
    expect(store.load("workflow-run")).toEqual(created);

    const malformedExecution = {
      ...structuredClone(goldenRunV01.executions[0]),
      id: "attempt-99",
      nodeId: "collect-sources",
      attempt: 99,
      retryOfExecutionId: null,
    };
    expect(() =>
      store.save(
        {
          ...created.run,
          updatedAt: nextTimestamp,
          executions: [malformedExecution],
        },
        created.revision,
      ),
    ).toThrow(InvalidExecutionAttemptError);
    expect(store.load("workflow-run")).toEqual(created);

    expect(() =>
      store.save(
        {
          ...created.run,
          updatedAt: nextTimestamp,
          executions: [
            {
              ...malformedExecution,
              id: "phase-bypass-attempt",
              attempt: 1,
            },
          ],
        },
        created.revision,
      ),
    ).toThrow(NodeStartGuardError);
    expect(store.load("workflow-run")).toEqual(created);
  });

  it("keeps frozen packet members immutable across later execution saves", () => {
    const store = new InMemoryWorkflowRunStore();
    const frozen = storeAtApprovedPacket(store);
    const baseExecution = structuredClone(goldenRunV01.executions[0]);
    const extraction = appendExecutionAttempt(
      frozen.run,
      {
        ...baseExecution,
        id: "stored-extraction-attempt",
        nodeId: "extract-evidence",
        attempt: 1,
        retryOfExecutionId: null,
      },
      [],
      minuteAfter(frozen.run),
    );

    const changedText = structuredClone(extraction);
    changedText.chunks[0].text = "Changed after immutable packet freeze.";
    expect(() =>
      store.save(changedText, frozen.revision),
    ).toThrow(InvalidExecutionAttemptError);

    const changedRights = structuredClone(extraction);
    changedRights.sources[0].rights.maySendToModel = "denied";
    expect(() =>
      store.save(changedRights, frozen.revision),
    ).toThrow(InvalidExecutionAttemptError);
    expect(store.load("workflow-run")).toEqual(frozen);
  });

  it("does not allow a normal lifecycle edge to smuggle a run-level error", () => {
    const store = new InMemoryWorkflowRunStore();
    const created = store.create(blankRun());
    const decomposing = advanceRun(
      created.run,
      "decomposing",
      minuteAfter(created.run),
    );
    decomposing.errors.push({
      id: "smuggled-error",
      kind: "invariant_violation",
      message: "This error must use failRun.",
      nodeId: "clarify-and-decompose",
      executionId: null,
      retryable: false,
      occurredAt: timestamp,
      details: {
        field: null,
        providerCode: null,
        httpStatus: null,
      },
    });

    expect(() =>
      store.save(decomposing, created.revision),
    ).toThrow(InvalidTransitionError);
    expect(store.load("workflow-run")).toEqual(created);
  });

  it("persists typed dispositions before revision and permits one matching revision result", () => {
    const reviewBase = structuredClone(goldenRunV01.executions[0]);
    const checkpointStore = new InMemoryWorkflowRunStore();
    let checkpoint = storeAtApprovedPacket(checkpointStore);
    for (const status of [
      "verifying_evidence",
      "synthesizing",
      "planning_experiment",
      "reviewing_experiment",
    ] as const) {
      checkpoint = checkpointStore.save(
        advanceRun(
          checkpoint.run,
          status,
          minuteAfter(checkpoint.run),
        ),
        checkpoint.revision,
      );
    }
    const reviewed = appendExecutionAttempt(
      checkpoint.run,
      {
        ...reviewBase,
        id: "stored-review-attempt",
        nodeId: "review-experiment",
        attempt: 1,
        retryOfExecutionId: null,
      },
      [],
      minuteAfter(checkpoint.run),
    );
    checkpoint = checkpointStore.save(
      {
        ...reviewed,
        review: structuredClone(goldenRunV01.review),
      },
      checkpoint.revision,
    );
    checkpoint = checkpointStore.save(
      advanceRun(
        checkpoint.run,
        "awaiting_objection_dispositions",
        minuteAfter(checkpoint.run),
      ),
      checkpoint.revision,
    );

    const dispositionTransition = persistObjectionDispositions(
      checkpoint.run,
      structuredClone(goldenRunV01.objectionDispositionDecision!),
      goldenObjectionDispositions,
      minuteAfter(checkpoint.run),
    );
    const dispositionsSaved = checkpointStore.save(
      dispositionTransition.run,
      checkpoint.revision,
      dispositionTransition.objectionDispositions,
    );
    expect(dispositionsSaved.run.revision).toBeNull();
    expect(dispositionsSaved.objectionDispositions).toEqual(
      goldenObjectionDispositions,
    );

    const revisionBase = structuredClone(goldenRunV01.executions[0]);
    const revisionAttempt = appendExecutionAttempt(
      dispositionsSaved.run,
      {
        ...revisionBase,
        id: "stored-revision-attempt",
        nodeId: "revise-experiment",
        attempt: 1,
        retryOfExecutionId: null,
      },
      [],
      minuteAfter(dispositionsSaved.run),
      dispositionsSaved.objectionDispositions,
    );
    const revisionSaved = checkpointStore.save(
      {
        ...revisionAttempt,
        revision: structuredClone(goldenRunV01.revision),
      },
      dispositionsSaved.revision,
    );
    expect(revisionSaved.run.revision).toEqual(goldenRunV01.revision);
    expect(revisionSaved.objectionDispositions).toEqual(
      goldenObjectionDispositions,
    );
    expect(() =>
      checkpointStore.save(
        {
          ...revisionSaved.run,
          updatedAt: minuteAfter(revisionSaved.run),
          revision: {
            ...revisionSaved.run.revision!,
            protocolVersion: "replaced",
          },
        },
        revisionSaved.revision,
      ),
    ).toThrow(InvalidExecutionAttemptError);
  });

  it("round-trips human checkpoints without weakening their recorded content", () => {
    const store = new InMemoryWorkflowRunStore();
    const created = storeAtAwaitingScope(store);
    const scope = {
      ...decision("scope"),
      edits: ["Limit the claim to the approved packet."],
      unresolvedObjections: ["scope limitation remains visible"],
    };
    const scoped = persistScopeApproval(
      created.run,
      scope,
      thirdTimestamp,
    );
    const saved = store.save(scoped, created.revision);
    const loaded = store.load("workflow-run")!;

    expect(loaded).toEqual(saved);
    expect(loaded.run.scopeDecision).toEqual(scope);
    expect(loaded.run.scopeDecision?.optionsShown).toEqual([
      "approve",
      "reject",
    ]);

    expect(() =>
      store.save(
        {
          ...loaded.run,
          scopeDecision: null,
        },
        loaded.revision,
      ),
    ).toThrow(InvalidExecutionAttemptError);
    expect(() =>
      store.save(
        {
          ...loaded.run,
          scopeDecision: {
            ...loaded.run.scopeDecision!,
            edits: ["Replace the recorded human checkpoint."],
          },
        },
        loaded.revision,
      ),
    ).toThrow(InvalidExecutionAttemptError);
    expect(store.load("workflow-run")).toEqual(loaded);
  });
});
