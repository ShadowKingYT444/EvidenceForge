import { describe, expect, it } from "vitest";

import {
  ResearchRunSchema,
  RunStatusSchema,
  type ResearchRun,
} from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  buildAuditLedger,
  redactAuditValue,
} from "../../src/features/workbench/audit-ledger";

function runWithExecutions(
  executions: ResearchRun["executions"],
  errors: ResearchRun["errors"] = [],
): ResearchRun {
  return {
    ...goldenRunV01,
    executions,
    errors,
  };
}

describe("execution audit ledger", () => {
  it("sorts actual attempts chronologically and preserves failure before retry success", () => {
    const ledger = buildAuditLedger(goldenRunV01);
    const ids = ledger.executions.map((execution) => execution.id);

    expect(ids.indexOf("gf-execution-plan-1")).toBeLessThan(
      ids.indexOf("gf-execution-plan-2"),
    );
    expect(ids.indexOf("gf-execution-review-failure-1")).toBeLessThan(
      ids.indexOf("gf-execution-review-1"),
    );
    expect(
      ledger.executions.find(
        (execution) => execution.id === "gf-execution-plan-1",
      ),
    ).toMatchObject({
      status: "failed",
      statusLabel: "Failed",
      isRunning: false,
      validation: {
        label: "Invalid",
        issues: ["sampleSizeBasis was omitted"],
      },
    });
    expect(
      ledger.executions.find(
        (execution) => execution.id === "gf-execution-plan-2",
      ),
    ).toMatchObject({
      status: "succeeded",
      statusLabel: "Succeeded",
      retryOfExecutionId: "gf-execution-plan-1",
      isRunning: false,
    });
  });

  it("keeps requested and returned provider/model fields separate", () => {
    const execution = structuredClone(goldenRunV01.executions[0]);
    execution.requestedProvider = "requested-provider";
    execution.returnedProvider = "returned-provider";
    execution.requestedModelId = "requested-model";
    execution.returnedModelId = "returned-model";

    const [attempt] = buildAuditLedger(runWithExecutions([execution])).executions;

    expect(attempt.provider).toEqual({
      requested: "requested-provider",
      returned: "returned-provider",
    });
    expect(attempt.model).toEqual({
      requested: "requested-model",
      returned: "returned-model",
    });
    expect(attempt.prompt).toEqual({
      id: execution.promptId,
      version: execution.promptVersion,
      hash: execution.promptHash,
      schemaVersion: execution.structuredOutputSchemaVersion,
    });
    expect(attempt.evidenceMode).toBe("fixture");
  });

  it("renders live only when the execution ledger explicitly records live evidence", () => {
    const live = structuredClone(goldenRunV01.executions[0]);
    live.evidenceMode = "live";

    const [attempt] = buildAuditLedger(runWithExecutions([live])).executions;

    expect(attempt.evidenceMode).toBe("live");
    expect(attempt.statusLabel).toBe("Succeeded");
    expect(attempt.isRunning).toBe(false);
  });

  it("shows exact latency, usage, and cost values or explicit unavailable states", () => {
    const unavailable = structuredClone(goldenRunV01.executions[0]);
    unavailable.clientLatencyMs = null;
    unavailable.providerTiming = {
      queueMs: null,
      promptMs: null,
      completionMs: null,
      totalMs: null,
    };
    unavailable.usage = {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    };
    unavailable.pricing = {
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      estimatedCost: null,
      snapshotDate: null,
    };

    const available = structuredClone(goldenRunV01.executions[0]);
    available.id = "execution-with-metrics";
    available.clientLatencyMs = 42;
    available.providerTiming = {
      queueMs: 3,
      promptMs: 7,
      completionMs: 29,
      totalMs: 39,
    };
    available.usage = {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cachedInputTokens: 12,
      reasoningTokens: 4,
    };
    available.pricing = {
      currency: "USD",
      inputPerMillionTokens: 0.1,
      outputPerMillionTokens: 0.2,
      estimatedCost: 0.000015,
      snapshotDate: "2026-08-06",
    };

    const measuredExecutions = buildAuditLedger(
      runWithExecutions([unavailable, available]),
    ).executions;
    const missing = measuredExecutions.find(
      ({ id }) => id === unavailable.id,
    )!;
    const measured = measuredExecutions.find(
      ({ id }) => id === available.id,
    )!;

    expect(missing.latency).toEqual({
      client: "Unavailable",
      queue: "Unavailable",
      prompt: "Unavailable",
      completion: "Unavailable",
      providerTotal: "Unavailable",
    });
    expect(missing.usage).toEqual({
      input: "Unavailable",
      output: "Unavailable",
      total: "Unavailable",
      cachedInput: "Unavailable",
      reasoning: "Unavailable",
    });
    expect(missing.cost).toMatchObject({
      estimated: "Unavailable",
      snapshotDate: "Unavailable",
    });
    expect(measured.latency).toMatchObject({
      client: "42 ms",
      providerTotal: "39 ms",
    });
    expect(measured.usage).toMatchObject({
      input: "100",
      output: "25",
      total: "125",
    });
    expect(measured.cost).toEqual({
      estimated: "USD 0.000015",
      inputRate: "USD 0.1 / 1M",
      outputRate: "USD 0.2 / 1M",
      snapshotDate: "2026-08-06",
    });
  });

  it("maps retry, fallback, refusal, timeout, validation, and run errors without erasure", () => {
    const failed = structuredClone(goldenRunV01.executions[0]);
    failed.id = "failed-attempt";
    failed.status = "timed_out";
    failed.endedAt = "2026-08-06T15:00:05.000Z";
    failed.errorIds = ["timeout-error"];
    failed.validation = { valid: false, issues: ["provider did not respond"] };

    const refused = structuredClone(goldenRunV01.executions[0]);
    refused.id = "refused-attempt";
    refused.startedAt = "2026-08-06T15:00:06.000Z";
    refused.endedAt = "2026-08-06T15:00:07.000Z";
    refused.status = "refused";
    refused.refusal = { refused: true, reason: "policy boundary" };
    refused.errorIds = ["refusal-error"];

    const retry = structuredClone(goldenRunV01.executions[0]);
    retry.id = "retry-attempt";
    retry.startedAt = "2026-08-06T15:00:08.000Z";
    retry.endedAt = "2026-08-06T15:00:09.000Z";
    retry.attempt = 2;
    retry.retryOfExecutionId = "failed-attempt";
    retry.fallbackFromExecutionId = "refused-attempt";

    const errors: ResearchRun["errors"] = [
      {
        id: "timeout-error",
        kind: "timeout",
        message: "provider did not respond",
        nodeId: failed.nodeId,
        executionId: failed.id,
        retryable: true,
        occurredAt: failed.endedAt,
        details: {
          field: null,
          providerCode: "TIMEOUT",
          httpStatus: 504,
        },
      },
      {
        id: "refusal-error",
        kind: "provider_refusal",
        message: "policy boundary",
        nodeId: refused.nodeId,
        executionId: refused.id,
        retryable: false,
        occurredAt: refused.endedAt,
        details: {
          field: null,
          providerCode: "REFUSAL",
          httpStatus: 400,
        },
      },
    ];

    const ledger = buildAuditLedger(
      runWithExecutions([retry, refused, failed], errors),
    );

    expect(ledger.executions.map(({ statusLabel }) => statusLabel)).toEqual([
      "Timed out",
      "Refused",
      "Succeeded",
    ]);
    expect(ledger.executions[0].errors).toEqual([
      {
        id: "timeout-error",
        kind: "timeout",
        message: "provider did not respond",
        retryable: true,
        providerCode: "TIMEOUT",
        httpStatus: "504",
      },
    ]);
    expect(ledger.executions[1].refusal).toBe("policy boundary");
    expect(ledger.executions[2]).toMatchObject({
      retryOfExecutionId: "failed-attempt",
      fallbackFromExecutionId: "refused-attempt",
    });
  });

  it("uses Running only for an open started execution", () => {
    const genuine = structuredClone(goldenRunV01.executions[0]);
    genuine.id = "genuine-running";
    genuine.status = "started";
    genuine.endedAt = null;

    const closed = structuredClone(goldenRunV01.executions[0]);
    closed.id = "closed-start";
    closed.startedAt = "2026-08-06T15:00:02.000Z";
    closed.status = "started";
    closed.endedAt = "2026-08-06T15:00:03.000Z";

    const activeRun = runWithExecutions([closed, genuine]);
    activeRun.status = "verifying_evidence";
    expect(ResearchRunSchema.safeParse(activeRun).success).toBe(true);

    const ledger = buildAuditLedger(activeRun);

    expect(ledger.executions.find(({ id }) => id === "genuine-running")).toMatchObject({
      statusLabel: "Running",
      isRunning: true,
    });
    expect(ledger.executions.find(({ id }) => id === "closed-start")).toMatchObject({
      statusLabel: "Started (closed record)",
      isRunning: false,
    });
    expect(ledger.activeCount).toBe(1);
  });

  it("does not upgrade a stale open attempt in a schema-valid final run to Running", () => {
    const stale = structuredClone(goldenRunV01.executions[0]);
    stale.id = "stale-open-after-approval";
    stale.status = "started";
    stale.endedAt = null;

    const finalRun = runWithExecutions([stale]);
    finalRun.status = "approved";
    expect(ResearchRunSchema.safeParse(finalRun).success).toBe(true);

    expect(buildAuditLedger(finalRun)).toMatchObject({
      activeCount: 0,
      executions: [
        {
          id: "stale-open-after-approval",
          status: "started",
          statusLabel: "Started (stale open record)",
          isRunning: false,
        },
      ],
    });
  });

  it("applies the complete run-lifecycle truth table to open started attempts", () => {
    const machineActiveStatuses = new Set<ResearchRun["status"]>([
      "decomposing",
      "collecting_sources",
      "extracting_evidence",
      "verifying_evidence",
      "synthesizing",
      "planning_experiment",
      "reviewing_experiment",
      "revising_experiment",
    ]);

    expect(RunStatusSchema.options).toEqual([
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
    ]);

    for (const runStatus of RunStatusSchema.options) {
      const execution = structuredClone(goldenRunV01.executions[0]);
      execution.id = `open-${runStatus}`;
      execution.status = "started";
      execution.endedAt = null;

      const run = runWithExecutions([execution]);
      run.status = runStatus;
      expect(
        ResearchRunSchema.safeParse(run).success,
        `${runStatus} fixture must remain schema-valid`,
      ).toBe(true);

      const [attempt] = buildAuditLedger(run).executions;
      const expectedRunning = machineActiveStatuses.has(runStatus);
      expect(attempt, runStatus).toMatchObject({
        status: "started",
        statusLabel: expectedRunning
          ? "Running"
          : "Started (stale open record)",
        isRunning: expectedRunning,
      });
    }
  });

  it("never derives Running from closed or terminal attempt telemetry", () => {
    const executionCases = [
      {
        status: "started",
        endedAt: "2026-08-06T15:00:05.000Z",
        label: "Started (closed record)",
      },
      { status: "succeeded", endedAt: null, label: "Succeeded" },
      { status: "failed", endedAt: null, label: "Failed" },
      { status: "refused", endedAt: null, label: "Refused" },
      { status: "timed_out", endedAt: null, label: "Timed out" },
    ] as const;

    for (const executionCase of executionCases) {
      const execution = structuredClone(goldenRunV01.executions[0]);
      execution.id = `${executionCase.status}-${executionCase.endedAt ?? "open"}`;
      execution.status = executionCase.status;
      execution.endedAt = executionCase.endedAt;

      const run = runWithExecutions([execution]);
      run.status = "verifying_evidence";
      expect(ResearchRunSchema.safeParse(run).success).toBe(true);

      expect(buildAuditLedger(run)).toMatchObject({
        activeCount: 0,
        executions: [
          {
            status: executionCase.status,
            statusLabel: executionCase.label,
            isRunning: false,
          },
        ],
      });
    }
  });

  it("renders empty and partial ledgers without upgrading missing evidence", () => {
    expect(buildAuditLedger(runWithExecutions([]))).toMatchObject({
      executionCount: 0,
      activeCount: 0,
      executions: [],
    });

    const partial = buildAuditLedger(
      runWithExecutions(goldenRunV01.executions.slice(0, 3)),
    );
    expect(partial.executionCount).toBe(3);
    expect(partial.executions.at(-1)?.nodeId).toBe("extract-evidence");
  });

  it("redacts credential-like text, compacts long values, and never exposes prompt bodies", () => {
    const secret = "sk-" + "a".repeat(48);
    const longValue = `model-${"x".repeat(220)}`;
    const execution = structuredClone(goldenRunV01.executions[0]);
    execution.requestedProvider = `https://provider.test?api_key=${secret}`;
    execution.returnedProvider = `Bearer ${secret}`;
    execution.requestedModelId = longValue;
    execution.returnedModelId = `token=${secret}`;
    execution.validation = {
      valid: false,
      issues: [`authorization=${secret}`, `safe ${longValue}`],
    };

    const [attempt] = buildAuditLedger(runWithExecutions([execution])).executions;
    const serialized = JSON.stringify(attempt);

    expect(redactAuditValue(`Bearer ${secret}`)).toBe("Bearer [redacted]");
    expect(serialized).not.toContain(secret);
    expect(attempt.provider.requested).toContain("api_key=[redacted]");
    expect(attempt.model.requested.length).toBeLessThanOrEqual(120);
    expect(attempt.validation.issues[1]).toContain("…");
    expect(Object.keys(attempt.prompt)).toEqual([
      "id",
      "version",
      "hash",
      "schemaVersion",
    ]);
  });
});
