import type { ResearchRun } from "../../contracts";

export const EXPERIMENT_PROTOCOL_SCENARIOS = ["abstention", "pending"] as const;

export type ExperimentProtocolScenario =
  (typeof EXPERIMENT_PROTOCOL_SCENARIOS)[number];

export function isExperimentProtocolScenario(
  value: string | undefined,
): value is ExperimentProtocolScenario {
  return EXPERIMENT_PROTOCOL_SCENARIOS.includes(
    value as ExperimentProtocolScenario,
  );
}

export function buildExperimentProtocolModel(run: ResearchRun) {
  if (run.experiment && run.experimentAbstention) {
    return {
      state: "error" as const,
      evidenceMode: run.evidenceMode,
      heading: "Experiment record unavailable",
      message:
        "The canonical run contains both a proposal and an abstention, so neither is displayed.",
    };
  }

  if (run.experimentAbstention) {
    return {
      state: "abstention" as const,
      evidenceMode: run.evidenceMode,
      id: run.experimentAbstention.id,
      heading: "Cannot propose responsibly",
      reason: run.experimentAbstention.reason,
      safetyCategories: [...run.experimentAbstention.safetyCategories],
      qualifiedReviewRequired:
        run.experimentAbstention.qualifiedReviewRequired,
      missingInputs: [...run.experimentAbstention.missingInputs],
      allowedNextStep: run.experimentAbstention.allowedNextStep,
    };
  }

  if (!run.experiment) {
    return {
      state: "pending" as const,
      evidenceMode: run.evidenceMode,
      heading: "Experiment planning pending",
      message:
        "No experiment proposal or typed abstention is recorded in the canonical run.",
    };
  }

  const protocol = run.experiment;
  const missingPowerAssumptions = [...protocol.missingPowerAssumptions];

  return {
    state: "proposal" as const,
    evidenceMode: run.evidenceMode,
    selectedGapId: protocol.selectedGapId,
    objective: protocol.objective,
    designType: protocol.designType,
    hypothesis: {
      alternative: protocol.hypothesis,
      null: protocol.nullHypothesis,
    },
    variables: {
      experimentalOrObservationalUnit:
        protocol.experimentalOrObservationalUnit,
      unitOfAnalysis: protocol.unitOfAnalysis,
      interventionOrExposure: protocol.interventionOrExposure,
      comparator: protocol.comparator,
      independent: [...protocol.independentVariables],
      dependent: [...protocol.dependentVariables],
      primaryOutcomes: [...protocol.primaryOutcomes],
      secondaryOutcomes: [...protocol.secondaryOutcomes],
      controls: [...protocol.controls],
      comparisonGroups: [...protocol.comparisonGroups],
    },
    validity: {
      measurement: protocol.measurementValidity,
      allocation: { ...protocol.allocation },
      replication: protocol.replicationPlan,
      repeatedMeasurement: protocol.repeatedMeasurementPlan,
      inclusionCriteria: [...protocol.inclusionCriteria],
      exclusionCriteria: [...protocol.exclusionCriteria],
      attrition: protocol.attritionPlan,
      missingData: protocol.missingDataPlan,
    },
    power: {
      status:
        missingPowerAssumptions.length > 0
          ? ("missing_assumptions" as const)
          : ("assumptions_recorded" as const),
      basis: protocol.sampleSizeBasis,
      missingAssumptions: missingPowerAssumptions,
      warning:
        missingPowerAssumptions.length > 0
          ? "Power assumptions are missing. Treat this as a pilot plan, not a confirmatory sample-size claim."
          : null,
    },
    analysis: {
      estimand: protocol.estimand,
      metrics: [...protocol.metrics],
      plan: protocol.analysisPlan,
      assumptionChecks: [...protocol.assumptionChecks],
    },
    bias: {
      confounders: [...protocol.confounders],
      mitigations: [...protocol.mitigations],
    },
    feasibility: {
      assessment: protocol.feasibility,
      requiredResources: [...protocol.requiredResources],
      constraints: [...protocol.constraints],
    },
    safety: {
      hazards: [...protocol.hazards],
      ethics: [...protocol.ethics],
      qualifiedReviewRequired: protocol.qualifiedReviewRequired,
    },
    criteria: {
      stopping: [...protocol.stoppingCriteria],
      failure: [...protocol.failureCriteria],
    },
    inference: {
      branches: protocol.expectedOutcomeBranches.map((branch) => ({
        ...branch,
      })),
      externalValidityBoundary: protocol.externalValidityBoundary,
    },
    supportingEvidenceCardIds: [...protocol.supportingEvidenceCardIds],
  };
}

export function buildExperimentProtocolScenarioModel(
  run: ResearchRun,
  scenario: ExperimentProtocolScenario,
): ExperimentProtocolModel {
  if (scenario === "pending") {
    return {
      state: "pending",
      evidenceMode: "simulated",
      heading: "Experiment planning pending",
      message:
        "No experiment proposal or typed abstention is recorded in this simulated state preview.",
    };
  }

  return {
    state: "abstention",
    evidenceMode: "simulated",
    id: "experiment-abstention-preview",
    heading: "Cannot propose responsibly",
    reason:
      "A safe protocol cannot be proposed responsibly until required evidence and qualified review are available.",
    safetyCategories: [
      "missing_qualified_review",
      "missing_required_evidence",
    ],
    qualifiedReviewRequired: true,
    missingInputs: [
      "Qualified safety review",
      "Evidence for the bounded comparator and measurement plan",
    ],
    allowedNextStep:
      "Obtain the missing review and evidence, then return for human assessment.",
  };
}

export type ExperimentProtocolModel = ReturnType<
  typeof buildExperimentProtocolModel
>;
