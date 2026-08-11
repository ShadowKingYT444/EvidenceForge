import type { ResearchRun } from "../../contracts";

import type {
  EvidenceMatrixModel,
  MatrixCell,
} from "./evidence-matrix-state";

type ProcessLocalTarget = {
  runId: string;
  expectedRevision: string;
};

type EvidenceReference = {
  id: string;
  relationship: MatrixCell["relationship"];
};

class DispositionProjectionFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function evidenceReferences(matrix: EvidenceMatrixModel) {
  if (matrix.state !== "ready") {
    throw new DispositionProjectionFailure(
      "objection_evidence_unavailable",
      "The objection record requires a validated evidence matrix.",
    );
  }

  const references = new Map<
    string,
    EvidenceReference & { state: "available" | "hidden" }
  >();
  for (const cell of matrix.rows.flatMap(({ cells }) => cells)) {
    for (const evidence of cell.evidence) {
      if (references.has(evidence.id)) {
        throw new DispositionProjectionFailure(
          "objection_evidence_duplicate",
          "An objection evidence card appears in more than one matrix relationship.",
        );
      }
      references.set(evidence.id, {
        id: evidence.id,
        relationship: cell.relationship,
        state: evidence.state,
      });
    }
  }
  return references;
}

function resolveObjectionEvidence(
  ids: string[],
  references: ReturnType<typeof evidenceReferences>,
): EvidenceReference[] {
  return ids.map((id) => {
    const reference = references.get(id);
    if (!reference) {
      throw new DispositionProjectionFailure(
        "objection_evidence_missing",
        "An objection cites evidence outside the validated matrix.",
      );
    }
    if (reference.state === "hidden") {
      throw new DispositionProjectionFailure(
        "objection_evidence_hidden",
        "An objection cites evidence that is not permitted for display, so dispositions are unavailable.",
      );
    }
    return { id: reference.id, relationship: reference.relationship };
  });
}

function protocolFieldValue(
  experiment: NonNullable<ResearchRun["experiment"]>,
  targetField: string,
): string {
  if (
    targetField === "__proto__" ||
    targetField === "constructor" ||
    !Object.prototype.hasOwnProperty.call(experiment, targetField)
  ) {
    throw new DispositionProjectionFailure(
      "objection_target_unavailable",
      "An objection target does not resolve to a validated protocol field.",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(experiment, targetField);
  if (!descriptor || !("value" in descriptor)) {
    throw new DispositionProjectionFailure(
      "objection_target_untrusted",
      "An objection target cannot be read as passive protocol data.",
    );
  }
  const value: unknown = descriptor.value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Required" : "Not required";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("; ");
  }
  if (
    value &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
  ) {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${item}`)
      .join("; ");
  }
  throw new DispositionProjectionFailure(
    "objection_target_untrusted",
    "An objection target cannot be rendered as passive protocol text.",
  );
}

function buildModel(
  run: ResearchRun,
  matrix: EvidenceMatrixModel,
  target: ProcessLocalTarget | null,
) {
  const evidenceMode = target ? ("simulated" as const) : run.evidenceMode;
  try {
    if (!run.review) {
      return {
        state: "pending" as const,
        evidenceMode,
        message: "No adversarial experiment review is recorded.",
        objections: [],
      };
    }
    if (!run.experiment) {
      throw new DispositionProjectionFailure(
        "objection_protocol_unavailable",
        "Objections cannot be displayed without a validated experiment protocol.",
      );
    }
    if (!target && run.objectionDispositionDecision && !run.revision) {
      throw new DispositionProjectionFailure(
        "revision_unavailable",
        "The disposition checkpoint is recorded, but its selective revision is unavailable.",
      );
    }
    const references = evidenceReferences(matrix);
    const decisions = new Map(
      (run.revision?.decisions ?? []).map((decision) => [
        decision.objectionId,
        decision,
      ]),
    );
    const objections = run.review.objections.map((objection) => {
      const recordedDecision = decisions.get(objection.id) ?? null;
      if (!target && run.revision && !recordedDecision) {
        throw new DispositionProjectionFailure(
          "objection_decision_missing",
          "A reviewed objection has no selective-revision decision.",
        );
      }
      const originalValue =
        recordedDecision?.originalValue ??
        protocolFieldValue(run.experiment!, objection.targetField);
      const decision = target
        ? null
        : recordedDecision
          ? {
              disposition: recordedDecision.disposition,
              basis: recordedDecision.basis,
              originalValue: recordedDecision.originalValue,
              revisedValue: recordedDecision.revisedValue,
              residualRisk: recordedDecision.residualRisk,
              showsChange:
                recordedDecision.disposition === "accepted" &&
                recordedDecision.revisedValue !== null &&
                recordedDecision.revisedValue !== recordedDecision.originalValue,
            }
          : null;
      return {
        id: objection.id,
        category: objection.category,
        severity: objection.severity,
        targetField: objection.targetField,
        rationale: objection.rationale,
        rationaleTrustLabel: "Untrusted reviewer text · rendered as plain text",
        evidence: resolveObjectionEvidence(
          objection.evidenceCardIds,
          references,
        ),
        originalValue,
        decision,
        remainsUnresolvedAtFinal:
          decision?.disposition === "unresolved" &&
          (run.finalDecision?.unresolvedObjections.includes(objection.id) ??
            false),
        finalDecision: run.finalDecision?.decision ?? null,
      };
    });

    if (target) {
      if (!target.runId || !target.expectedRevision) {
        throw new DispositionProjectionFailure(
          "process_local_target_invalid",
          "Process-local persistence requires a run ID and expected revision.",
        );
      }
      return {
        state: "awaiting" as const,
        evidenceMode,
        persistence: {
          state: "process_local" as const,
          label: "Process-local checkpoint",
          runId: target.runId,
          expectedRevision: target.expectedRevision,
        },
        objections,
      };
    }

    return {
      state: "recorded" as const,
      evidenceMode,
      persistence: {
        state: "recorded_fixture" as const,
        label: "Recorded fixture · read-only",
      },
      objections,
    };
  } catch (error) {
    const failure =
      error instanceof DispositionProjectionFailure
        ? error
        : new DispositionProjectionFailure(
            "objection_projection_failed",
            "The objection and revision record could not be projected safely.",
          );
    return {
      state: "error" as const,
      evidenceMode,
      error: { code: failure.code, message: failure.message },
      objections: [],
    };
  }
}

export function buildObjectionDispositionModel(
  run: ResearchRun,
  matrix: EvidenceMatrixModel,
) {
  return buildModel(run, matrix, null);
}

export function buildObjectionDispositionScenarioModel(
  run: ResearchRun,
  matrix: EvidenceMatrixModel,
  target: ProcessLocalTarget,
) {
  return buildModel(run, matrix, target);
}

export type ObjectionDispositionModel = ReturnType<
  typeof buildObjectionDispositionModel
>;
