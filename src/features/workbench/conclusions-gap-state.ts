import type { ResearchRun } from "../../contracts";

import type { EvidenceMatrixModel, MatrixCell } from "./evidence-matrix-state";

type EvidenceReference = {
  id: string;
  claimId: string;
  sourceId: string;
  relationship: MatrixCell["relationship"];
  targetId: string;
};

type SelectionDecision =
  | {
      state: "pending";
      selectedGapId: null;
      decision: null;
      impactRationale: null;
      tractabilityRationale: null;
    }
  | {
      state: "recorded";
      selectedGapId: string;
      decision: "selected";
      impactRationale: string;
      tractabilityRationale: string;
    };

class InspectorProjectionFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveEvidence(
  ids: string[],
  evidenceById: ReadonlyMap<string, EvidenceReference>,
  label: string,
): EvidenceReference[] {
  return ids.map((id) => {
    const evidence = evidenceById.get(id);
    if (!evidence) {
      throw new InspectorProjectionFailure(
        "missing_evidence_reference",
        `${label} references an evidence card outside the validated matrix.`,
      );
    }
    return evidence;
  });
}

function evidenceReferenceMap(matrix: EvidenceMatrixModel) {
  if (matrix.state !== "ready") {
    throw new InspectorProjectionFailure(
      "matrix_unavailable",
      "The conclusions inspector requires a validated evidence matrix.",
    );
  }

  const evidenceById = new Map<string, EvidenceReference>();
  for (const cell of matrix.rows.flatMap(({ cells }) => cells)) {
    for (const id of cell.evidenceIds) {
      if (evidenceById.has(id)) {
        throw new InspectorProjectionFailure(
          "duplicate_evidence_reference",
          "An evidence card appears in more than one matrix relationship.",
        );
      }
      evidenceById.set(id, {
        id,
        claimId: cell.claimId,
        sourceId: cell.sourceId,
        relationship: cell.relationship,
        targetId: `matrix-cell-${cell.id}`,
      });
    }
  }
  return evidenceById;
}

export function buildConclusionsGapModel(
  run: ResearchRun,
  matrix: EvidenceMatrixModel,
) {
  try {
    const evidenceById = evidenceReferenceMap(matrix);
    const claimsById = new Map(run.claims.map((claim) => [claim.id, claim]));

    const conclusions = run.conclusions.map((conclusion) => {
      const claim = claimsById.get(conclusion.subclaimId);
      if (!claim) {
        throw new InspectorProjectionFailure(
          "missing_conclusion_claim",
          "A conclusion references a claim outside the validated run.",
        );
      }
      return {
        claimId: claim.id,
        claimStatement: claim.statement,
        strength: conclusion.strength,
        strengthLabel:
          conclusion.strength.charAt(0).toUpperCase() +
          conclusion.strength.slice(1),
        conclusion: conclusion.conclusion,
        supportingEvidence: resolveEvidence(
          conclusion.supportingEvidenceCardIds,
          evidenceById,
          `Conclusion ${conclusion.subclaimId}`,
        ),
        contradictingEvidence: resolveEvidence(
          conclusion.contradictingEvidenceCardIds,
          evidenceById,
          `Conclusion ${conclusion.subclaimId}`,
        ),
        disagreementSummary: conclusion.disagreementSummary,
        limitations: [...conclusion.limitations],
        changeEvidence: [...conclusion.changeEvidence],
        overclaimingWarnings: [...conclusion.overclaimingWarnings],
        humanReviewStatus: conclusion.humanReviewStatus,
        isAbstention: conclusion.strength === "insufficient",
        abstentionLabel:
          conclusion.strength === "insufficient"
            ? "Insufficient evidence · abstain"
            : null,
      };
    });

    const gaps = run.researchGaps
      .map((gap) => ({
        id: gap.id,
        type: gap.type,
        rank: gap.rank,
        selection: gap.selection,
        affectedClaims: gap.affectedSubclaimIds.map((claimId) => {
          const claim = claimsById.get(claimId);
          if (!claim) {
            throw new InspectorProjectionFailure(
              "missing_gap_claim",
              "A research gap references a claim outside the validated run.",
            );
          }
          return { id: claim.id, statement: claim.statement };
        }),
        impactRationale: gap.impactRationale,
        tractabilityRationale: gap.tractabilityRationale,
        evidence: resolveEvidence(
          gap.evidenceCardIds,
          evidenceById,
          `Research gap ${gap.id}`,
        ),
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank || stableCompare(left.id, right.id),
      );

    let selectionDecision: SelectionDecision = {
      state: "pending",
      selectedGapId: null,
      decision: null,
      impactRationale: null,
      tractabilityRationale: null,
    };
    if (run.selectedGapId !== null) {
      const selectedGap = gaps.find(({ id }) => id === run.selectedGapId);
      if (!selectedGap || selectedGap.selection !== "selected") {
        throw new InspectorProjectionFailure(
          "invalid_selected_gap",
          "The selected gap does not resolve to one selected candidate.",
        );
      }
      selectionDecision = {
        state: "recorded",
        selectedGapId: selectedGap.id,
        decision: "selected",
        impactRationale: selectedGap.impactRationale,
        tractabilityRationale: selectedGap.tractabilityRationale,
      };
    }

    return {
      state: "ready" as const,
      error: null,
      conclusions,
      gaps,
      selectionDecision,
    };
  } catch (error) {
    const failure =
      error instanceof InspectorProjectionFailure
        ? error
        : new InspectorProjectionFailure(
            "inspector_projection_failed",
            "The conclusions and gap record could not be projected safely.",
          );
    return {
      state: "error" as const,
      error: { code: failure.code, message: failure.message },
      conclusions: [],
      gaps: [],
      selectionDecision: {
        state: "pending" as const,
        selectedGapId: null,
        decision: null,
        impactRationale: null,
        tractabilityRationale: null,
      },
    };
  }
}

export type ConclusionsGapModel = ReturnType<typeof buildConclusionsGapModel>;
