export type DispositionDraft = {
  objectionId: string;
  disposition: "accepted" | "rejected" | "unresolved";
  basis: string;
};

type SubmissionInput = {
  runId: string;
  expectedRevision: string;
  decidedAt: string;
  dispositions: DispositionDraft[];
};

type Fetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type CheckpointDecision = {
  id: string;
  checkpoint: "objection_dispositions";
  optionsShown: string[];
  decision: "approve";
  edits: string[];
  decidedAt: string;
  unresolvedObjections: string[];
};

const decisionKeys = [
  "checkpoint",
  "decidedAt",
  "decision",
  "edits",
  "id",
  "optionsShown",
  "unresolvedObjections",
] as const;

export type DispositionSubmissionResult =
  | {
      ok: true;
      revision: string;
      status: "revising_experiment";
      message: string;
    }
  | {
      ok: false;
      code:
        | "basis_required"
        | "invalid_target"
        | "revision_conflict"
        | "request_failed"
        | "invalid_response";
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return typeof value.error.code === "string" ? value.error.code : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return false;
  }
  const actual = [...value].sort();
  return (
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index])
  );
}

function provesPersistence(
  value: unknown,
  runId: string,
  expectedDecision: CheckpointDecision,
): value is {
  revision: string;
  run: {
    id: string;
    status: "revising_experiment";
    objectionDispositionDecision: CheckpointDecision;
  };
} {
  const decision =
    isRecord(value) &&
    isRecord(value.run) &&
    isRecord(value.run.objectionDispositionDecision)
      ? value.run.objectionDispositionDecision
      : null;
  return (
    isRecord(value) &&
    typeof value.revision === "string" &&
    value.revision.trim().length > 0 &&
    isRecord(value.run) &&
    value.run.id === runId &&
    value.run.status === "revising_experiment" &&
    decision !== null &&
    hasExactKeys(decision, decisionKeys) &&
    decision.id === expectedDecision.id &&
    decision.checkpoint === expectedDecision.checkpoint &&
    sameStrings(decision.optionsShown, expectedDecision.optionsShown) &&
    decision.decision === expectedDecision.decision &&
    sameStrings(decision.edits, expectedDecision.edits) &&
    decision.decidedAt === expectedDecision.decidedAt &&
    sameStringSet(
      decision.unresolvedObjections,
      expectedDecision.unresolvedObjections,
    )
  );
}

function dispositionEdit(disposition: DispositionDraft): string {
  return JSON.stringify({
    objectionId: disposition.objectionId,
    disposition: disposition.disposition,
    basis: disposition.basis,
  });
}

export async function submitObjectionDispositions(
  input: SubmissionInput,
  fetcher: Fetcher = fetch,
): Promise<DispositionSubmissionResult> {
  if (!input.runId || !input.expectedRevision) {
    return {
      ok: false,
      code: "invalid_target",
      message: "The process-local run target is unavailable.",
    };
  }
  if (
    input.dispositions.length === 0 ||
    input.dispositions.some(({ basis }) => !basis.trim())
  ) {
    return {
      ok: false,
      code: "basis_required",
      message: "Every objection disposition requires a human basis.",
    };
  }

  const objectionIds = input.dispositions.map(({ objectionId }) => objectionId);
  if (
    objectionIds.some((objectionId) => !objectionId) ||
    new Set(objectionIds).size !== objectionIds.length
  ) {
    return {
      ok: false,
      code: "invalid_target",
      message: "The objection disposition target is invalid.",
    };
  }

  const dispositions = input.dispositions
    .map((disposition) => ({
      ...disposition,
      basis: disposition.basis.trim(),
    }))
    .sort(({ objectionId: left }, { objectionId: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  const unresolvedObjections = dispositions
    .filter(({ disposition }) => disposition === "unresolved")
    .map(({ objectionId }) => objectionId);
  const decision: CheckpointDecision = {
    id: `objection-dispositions-${input.decidedAt}`,
    checkpoint: "objection_dispositions",
    optionsShown: ["approve", "request revision", "reject"],
    decision: "approve",
    edits: dispositions.map(dispositionEdit),
    decidedAt: input.decidedAt,
    unresolvedObjections,
  };
  const requestBody = {
    checkpoint: "objection_dispositions",
    expectedRevision: input.expectedRevision,
    decision,
    dispositions,
  };

  let response: Response;
  try {
    response = await fetcher(
      `/api/runs/${encodeURIComponent(input.runId)}/checkpoints`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );
  } catch {
    return {
      ok: false,
      code: "request_failed",
      message:
        "The checkpoint request failed. Your choices and bases were retained.",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (response.status === 409 && responseCode(payload) === "revision_conflict") {
      return {
        ok: false,
        code: "revision_conflict",
        message:
          "This run changed before the checkpoint was saved. Review the latest run before retrying.",
      };
    }
    return {
      ok: false,
      code: "request_failed",
      message:
        "The checkpoint was not saved. Your choices and bases were retained.",
    };
  }
  if (!provesPersistence(payload, input.runId, decision)) {
    return {
      ok: false,
      code: "invalid_response",
      message:
        "The checkpoint response could not prove that dispositions were persisted.",
    };
  }
  return {
    ok: true,
    revision: payload.revision,
    status: payload.run.status,
    message:
      "Dispositions saved to this process-local run. Selective revision is pending.",
  };
}
