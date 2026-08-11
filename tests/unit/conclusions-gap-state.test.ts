import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { buildConclusionsGapModel } from "../../src/features/workbench/conclusions-gap-state";
import { buildEvidenceMatrixModel } from "../../src/features/workbench/evidence-matrix-state";

describe("conclusions and selected-gap inspector state", () => {
  it("projects categorical conclusions with traceable evidence and no numeric confidence", () => {
    const model = buildConclusionsGapModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
    );

    expect(model.state).toBe("ready");
    expect(model.conclusions).toHaveLength(goldenRunV01.conclusions.length);
    expect(model.conclusions[0]).toMatchObject({
      claimId: "gf-claim-duration",
      strength: "conflicting",
      strengthLabel: "Conflicting",
      conclusion: goldenRunV01.conclusions[0]!.conclusion,
      disagreementSummary:
        goldenRunV01.conclusions[0]!.disagreementSummary,
      limitations: goldenRunV01.conclusions[0]!.limitations,
      changeEvidence: goldenRunV01.conclusions[0]!.changeEvidence,
      overclaimingWarnings:
        goldenRunV01.conclusions[0]!.overclaimingWarnings,
      humanReviewStatus: "confirmed",
      isAbstention: false,
    });
    expect(model.conclusions[0]!.supportingEvidence.map(({ id }) => id)).toEqual(
      goldenRunV01.conclusions[0]!.supportingEvidenceCardIds,
    );
    expect(
      model.conclusions[0]!.contradictingEvidence.map(({ id }) => id),
    ).toEqual(goldenRunV01.conclusions[0]!.contradictingEvidenceCardIds);

    const forbiddenKeys: string[] = [];
    function inspect(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (/confidence|probability|percentage|percent/i.test(key)) {
          forbiddenKeys.push(key);
        }
        inspect(child);
      }
    }
    inspect(model);
    expect(forbiddenKeys).toEqual([]);
  });

  it("turns insufficient evidence into an explicit calibrated abstention", () => {
    const model = buildConclusionsGapModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
    );
    const insufficient = model.conclusions.find(
      ({ claimId }) => claimId === "gf-claim-integration",
    );

    expect(insufficient).toMatchObject({
      strength: "insufficient",
      strengthLabel: "Insufficient",
      isAbstention: true,
      abstentionLabel: "Insufficient evidence · abstain",
    });
    expect(insufficient?.changeEvidence).not.toEqual([]);
    expect(insufficient?.limitations).not.toEqual([]);
  });

  it("records ranked gap candidates and the persisted selection rationale", () => {
    const model = buildConclusionsGapModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
    );
    const selected = goldenRunV01.researchGaps[0]!;

    expect(model.gaps[0]).toMatchObject({
      id: selected.id,
      rank: 1,
      selection: "selected",
      impactRationale: selected.impactRationale,
      tractabilityRationale: selected.tractabilityRationale,
    });
    expect(model.gaps[0]!.evidence.map(({ id }) => id)).toEqual(
      selected.evidenceCardIds,
    );
    expect(model.selectionDecision).toEqual({
      state: "recorded",
      selectedGapId: selected.id,
      decision: "selected",
      impactRationale: selected.impactRationale,
      tractabilityRationale: selected.tractabilityRationale,
    });
  });

  it("sorts candidates deterministically and keeps an absent selection pending", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.selectedGapId = null;
    run.researchGaps[0]!.selection = "unselected";
    run.researchGaps[0]!.rank = 2;
    const otherGap = structuredClone(run.researchGaps[0]!);
    otherGap.id = "gf-gap-measurement";
    otherGap.type = "measurement_inconsistency";
    otherGap.rank = 1;
    run.researchGaps.push(otherGap);

    const model = buildConclusionsGapModel(
      run,
      buildEvidenceMatrixModel(goldenRunV01),
    );

    expect(model.gaps.map(({ id }) => id)).toEqual([
      "gf-gap-measurement",
      "gf-gap-loaded-duration",
    ]);
    expect(model.selectionDecision).toMatchObject({
      state: "pending",
      selectedGapId: null,
      decision: null,
    });
  });

  it("fails closed when the validated matrix cannot resolve a conclusion link", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.conclusions[0]!.supportingEvidenceCardIds = ["missing-evidence"];

    const model = buildConclusionsGapModel(
      run,
      buildEvidenceMatrixModel(run),
    );

    expect(model).toMatchObject({
      state: "error",
      conclusions: [],
      gaps: [],
      error: { code: "matrix_unavailable" },
    });
  });
});
