import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { buildExperimentProtocolModel } from "../../src/features/workbench/experiment-protocol-state";

describe("experiment protocol inspector state", () => {
  it("projects a scannable proposal with missing-power and two-sided inference limits", () => {
    const model = buildExperimentProtocolModel(goldenRunV01);

    expect(model).toMatchObject({
      state: "proposal",
      evidenceMode: "fixture",
      objective: goldenRunV01.experiment?.objective,
      designType: goldenRunV01.experiment?.designType,
      hypothesis: {
        alternative: goldenRunV01.experiment?.hypothesis,
        null: goldenRunV01.experiment?.nullHypothesis,
      },
      power: {
        status: "missing_assumptions",
        basis: goldenRunV01.experiment?.sampleSizeBasis,
        missingAssumptions: goldenRunV01.experiment?.missingPowerAssumptions,
      },
      inference: {
        externalValidityBoundary:
          goldenRunV01.experiment?.externalValidityBoundary,
      },
    });
    expect(model.state === "proposal" && model.power.warning).toMatch(
      /power assumptions are missing/i,
    );
    expect(model.state === "proposal" && model.inference.branches).toEqual(
      goldenRunV01.experiment?.expectedOutcomeBranches,
    );
    expect(
      model.state === "proposal" &&
        model.inference.branches.every(
          (branch) => branch.establishes && branch.doesNotEstablish,
        ),
    ).toBe(true);

    expect("procedure" in model).toBe(false);
    expect(JSON.stringify(model)).not.toContain(
      goldenRunV01.experiment?.procedure[0],
    );
  });

  it("fails safely into a cannot-propose-responsibly abstention", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.experiment = null;
    run.experimentAbstention = {
      id: "gf-experiment-abstention",
      reason:
        "A safe protocol cannot be proposed responsibly from the current packet.",
      safetyCategories: [
        "missing_qualified_review",
        "missing_required_evidence",
      ],
      qualifiedReviewRequired: true,
      missingInputs: [
        "Qualified materials review",
        "Bounded comparator evidence",
      ],
      allowedNextStep:
        "Obtain the missing review and evidence, then return for human assessment.",
    };

    const model = buildExperimentProtocolModel(run);

    expect(model).toEqual({
      state: "abstention",
      evidenceMode: "fixture",
      id: "gf-experiment-abstention",
      heading: "Cannot propose responsibly",
      reason:
        "A safe protocol cannot be proposed responsibly from the current packet.",
      safetyCategories: [
        "missing_qualified_review",
        "missing_required_evidence",
      ],
      qualifiedReviewRequired: true,
      missingInputs: [
        "Qualified materials review",
        "Bounded comparator evidence",
      ],
      allowedNextStep:
        "Obtain the missing review and evidence, then return for human assessment.",
    });
  });

  it("keeps experiment planning pending when neither typed outcome is recorded", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.experiment = null;
    run.experimentAbstention = null;

    expect(buildExperimentProtocolModel(run)).toEqual({
      state: "pending",
      evidenceMode: "fixture",
      heading: "Experiment planning pending",
      message:
        "No experiment proposal or typed abstention is recorded in the canonical run.",
    });
  });
});
