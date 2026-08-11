import type { ResearchRun } from "@/contracts";

type Execution = ResearchRun["executions"][number];
type RunError = ResearchRun["errors"][number];

const UNAVAILABLE = "Unavailable";
const MAX_DISPLAY_LENGTH = 120;
const MACHINE_ACTIVE_RUN_STATUSES = new Set<ResearchRun["status"]>([
  "decomposing",
  "collecting_sources",
  "extracting_evidence",
  "verifying_evidence",
  "synthesizing",
  "planning_experiment",
  "reviewing_experiment",
  "revising_experiment",
]);

function compactAuditValue(value: string) {
  if (value.length <= MAX_DISPLAY_LENGTH) {
    return value;
  }
  return `${value.slice(0, 84)}…${value.slice(-34)}`;
}

export function redactAuditValue(value: string) {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:api[_-]?key|token|secret|authorization)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|authorization|password)\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`,
    )
    .replace(/\b(?:sk|gsk|nvapi)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]");

  return compactAuditValue(redacted);
}

function display(value: string | null | undefined) {
  return value === null || value === undefined
    ? UNAVAILABLE
    : redactAuditValue(value);
}

function milliseconds(value: number | null) {
  return value === null ? UNAVAILABLE : `${value} ms`;
}

function tokens(value: number | null) {
  return value === null ? UNAVAILABLE : String(value);
}

function rate(
  currency: string,
  value: number | null,
) {
  return value === null ? UNAVAILABLE : `${currency} ${value} / 1M`;
}

function statusPresentation(
  execution: Execution,
  runStatus: ResearchRun["status"],
) {
  if (execution.status === "started") {
    if (execution.endedAt !== null) {
      return { label: "Started (closed record)", isRunning: false };
    }
    return MACHINE_ACTIVE_RUN_STATUSES.has(runStatus)
      ? { label: "Running", isRunning: true }
      : { label: "Started (stale open record)", isRunning: false };
  }

  const labels = {
    succeeded: "Succeeded",
    failed: "Failed",
    refused: "Refused",
    timed_out: "Timed out",
  } as const;

  return { label: labels[execution.status], isRunning: false };
}

function mapError(error: RunError) {
  return {
    id: redactAuditValue(error.id),
    kind: error.kind,
    message: redactAuditValue(error.message),
    retryable: error.retryable,
    providerCode: display(error.details.providerCode),
    httpStatus:
      error.details.httpStatus === null
        ? UNAVAILABLE
        : String(error.details.httpStatus),
  };
}

function summarize(
  executions: AuditExecution[],
  label: AuditLedger["label"],
): AuditLedger {
  return {
    label,
    executionCount: executions.length,
    preservedFailureCount: executions.filter((execution) =>
      ["failed", "refused", "timed_out"].includes(execution.status),
    ).length,
    retryCount: executions.filter(
      (execution) => execution.retryOfExecutionId !== UNAVAILABLE,
    ).length,
    activeCount: executions.filter((execution) => execution.isRunning).length,
    executions,
  };
}

export type AuditExecution = ReturnType<typeof mapExecution>;

export type AuditLedger = {
  label: "Complete ledger" | "Partial ledger" | "No attempts";
  executionCount: number;
  preservedFailureCount: number;
  retryCount: number;
  activeCount: number;
  executions: AuditExecution[];
};

function mapExecution(
  execution: Execution,
  linkedErrors: RunError[],
  runStatus: ResearchRun["status"],
) {
  const status = statusPresentation(execution, runStatus);

  return {
    id: redactAuditValue(execution.id),
    nodeId: redactAuditValue(execution.nodeId),
    attempt: execution.attempt,
    status: execution.status,
    statusLabel: status.label,
    isRunning: status.isRunning,
    evidenceMode: execution.evidenceMode,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt ?? UNAVAILABLE,
    provider: {
      requested: display(execution.requestedProvider),
      returned: display(execution.returnedProvider),
    },
    model: {
      requested: display(execution.requestedModelId),
      returned: display(execution.returnedModelId),
    },
    prompt: {
      id: display(execution.promptId),
      version: display(execution.promptVersion),
      hash: display(execution.promptHash),
      schemaVersion: display(execution.structuredOutputSchemaVersion),
    },
    validation: {
      label: execution.validation.valid ? "Valid" : "Invalid",
      issues: execution.validation.issues.map(redactAuditValue),
    },
    latency: {
      client: milliseconds(execution.clientLatencyMs),
      queue: milliseconds(execution.providerTiming.queueMs),
      prompt: milliseconds(execution.providerTiming.promptMs),
      completion: milliseconds(execution.providerTiming.completionMs),
      providerTotal: milliseconds(execution.providerTiming.totalMs),
    },
    usage: {
      input: tokens(execution.usage.inputTokens),
      output: tokens(execution.usage.outputTokens),
      total: tokens(execution.usage.totalTokens),
      cachedInput: tokens(execution.usage.cachedInputTokens),
      reasoning: tokens(execution.usage.reasoningTokens),
    },
    cost: {
      estimated:
        execution.pricing.estimatedCost === null
          ? UNAVAILABLE
          : `${execution.pricing.currency} ${execution.pricing.estimatedCost}`,
      inputRate: rate(
        execution.pricing.currency,
        execution.pricing.inputPerMillionTokens,
      ),
      outputRate: rate(
        execution.pricing.currency,
        execution.pricing.outputPerMillionTokens,
      ),
      snapshotDate: display(execution.pricing.snapshotDate),
    },
    retryOfExecutionId: display(execution.retryOfExecutionId),
    fallbackFromExecutionId: display(execution.fallbackFromExecutionId),
    refusal: execution.refusal.refused
      ? display(execution.refusal.reason)
      : UNAVAILABLE,
    errors: linkedErrors.map(mapError),
  };
}

export function buildAuditLedger(run: ResearchRun): AuditLedger {
  const sorted = [...run.executions].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.attempt - right.attempt ||
      left.id.localeCompare(right.id),
  );

  const executions = sorted.map((execution) => {
    const linkedErrors = run.errors
      .filter(
        (error) =>
          error.executionId === execution.id ||
          execution.errorIds.includes(error.id),
      )
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.id.localeCompare(right.id),
      );
    return mapExecution(execution, linkedErrors, run.status);
  });

  return summarize(executions, executions.length ? "Complete ledger" : "No attempts");
}

function previewAttempt(
  source: AuditExecution,
  status: "timed_out" | "refused",
): AuditExecution {
  const timedOut = status === "timed_out";
  return {
    ...source,
    id: timedOut ? "fixture-preview-timeout" : "fixture-preview-refusal",
    status,
    statusLabel: timedOut ? "Timed out" : "Refused",
    isRunning: false,
    evidenceMode: "simulated",
    provider: {
      requested: "Fixture state preview",
      returned: UNAVAILABLE,
    },
    model: {
      requested: "Fixture state preview",
      returned: UNAVAILABLE,
    },
    validation: {
      label: "Invalid",
      issues: [
        timedOut
          ? "Provider response was not received before the timeout."
          : "Provider returned an explicit refusal.",
      ],
    },
    retryOfExecutionId: UNAVAILABLE,
    fallbackFromExecutionId: UNAVAILABLE,
    refusal: timedOut ? UNAVAILABLE : "Fixture refusal preview",
    errors: [
      {
        id: timedOut ? "fixture-timeout-error" : "fixture-refusal-error",
        kind: timedOut ? "timeout" : "provider_refusal",
        message: timedOut
          ? "The provider timed out before returning a validated result."
          : "The provider refused the request; no proposal was produced.",
        retryable: timedOut,
        providerCode: UNAVAILABLE,
        httpStatus: UNAVAILABLE,
      },
    ],
  };
}

function previewFailureAttempt(
  source: AuditExecution,
  input: {
    id: string;
    attempt: number;
    kind: RunError["kind"];
    message: string;
    retryable: boolean;
    retryOfExecutionId?: string;
  },
): AuditExecution {
  return {
    ...source,
    id: input.id,
    attempt: input.attempt,
    status: "failed",
    statusLabel: "Failed",
    isRunning: false,
    evidenceMode: "simulated",
    provider: {
      requested: "Fixture state preview",
      returned: "Unavailable",
    },
    model: {
      requested: "Fixture state preview",
      returned: "Unavailable",
    },
    validation: {
      label: "Invalid",
      issues: [input.message],
    },
    retryOfExecutionId: input.retryOfExecutionId ?? UNAVAILABLE,
    fallbackFromExecutionId: UNAVAILABLE,
    refusal: UNAVAILABLE,
    errors: [
      {
        id: `${input.id}-error`,
        kind: input.kind,
        message: input.message,
        retryable: input.retryable,
        providerCode: UNAVAILABLE,
        httpStatus: UNAVAILABLE,
      },
    ],
  };
}

export function resolveAuditScenario(
  ledger: AuditLedger,
  scenario: string,
): AuditLedger {
  if (["awaiting", "collecting", "running"].includes(scenario)) {
    return summarize([], "No attempts");
  }
  if (scenario === "partial") {
    return summarize(ledger.executions.slice(0, 4), "Partial ledger");
  }
  if (scenario === "invalid-output") {
    return summarize(
      ledger.executions.filter(
        (execution) =>
          execution.id === "gf-execution-plan-1",
      ),
      "Partial ledger",
    );
  }
  if (scenario === "invalid-json" || scenario === "invalid-schema") {
    const source = ledger.executions.find(
      (execution) => execution.id === "gf-execution-plan-1",
    );
    if (!source) return summarize([], "No attempts");
    const invalidJson = scenario === "invalid-json";
    return summarize(
      [
        previewFailureAttempt(source, {
          id: invalidJson
            ? "fixture-preview-invalid-json"
            : "fixture-preview-invalid-schema",
          attempt: 1,
          kind: invalidJson ? "invalid_model_json" : "invalid_model_output",
          message: invalidJson
            ? "The provider response was not valid JSON and was not accepted."
            : "The provider JSON failed application schema validation and was not accepted.",
          retryable: true,
        }),
      ],
      "Partial ledger",
    );
  }
  if (scenario === "retry-exhausted") {
    const source = ledger.executions.find(
      (execution) => execution.id === "gf-execution-review-failure-1",
    );
    if (!source) return summarize([], "No attempts");
    const first = previewFailureAttempt(source, {
      id: "fixture-preview-retry-exhausted-1",
      attempt: 1,
      kind: "provider_failure",
      message: "The provider failed before returning a validated result.",
      retryable: true,
    });
    const second = previewFailureAttempt(source, {
      id: "fixture-preview-retry-exhausted-2",
      attempt: 2,
      kind: "provider_failure",
      message: "The provider retry budget was exhausted after two failed attempts.",
      retryable: false,
      retryOfExecutionId: first.id,
    });
    return summarize([first, second], "Partial ledger");
  }
  if (scenario === "retry") {
    return summarize(
      ledger.executions.filter((execution) =>
        [
          "gf-execution-plan-1",
          "gf-execution-plan-2",
          "gf-execution-review-failure-1",
          "gf-execution-review-1",
        ].includes(execution.id),
      ),
      "Partial ledger",
    );
  }
  if (scenario === "missing-source") {
    return summarize(
      ledger.executions.filter(
        (execution) => execution.id === "gf-execution-collect-1",
      ),
      "Partial ledger",
    );
  }
  if (scenario === "timeout" || scenario === "refusal") {
    const source = ledger.executions[0];
    if (!source) {
      return summarize([], "No attempts");
    }
    return summarize(
      [
        previewAttempt(
          source,
          scenario === "timeout" ? "timed_out" : "refused",
        ),
      ],
      "Partial ledger",
    );
  }
  return ledger;
}
