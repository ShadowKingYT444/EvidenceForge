export type IntakeClaim = {
  id: string;
  statement: string;
  operationalDefinition: string;
};

export type IntakeDraft = {
  originalQuestion: string;
  intendedApplication: string;
  populationOrGeography: string;
  timeHorizon: string;
  availableMaterialsOrBudget: string;
  desiredDepth: string;
  constraints: string;
  clarifications: string[];
  claims: IntakeClaim[];
};

export type IntakeValidation = {
  originalQuestion?: string;
  intendedApplication?: string;
  claims?: string;
  claimFields: Record<
    string,
    {
      statement?: string;
      operationalDefinition?: string;
    }
  >;
  clarifications?: string;
};

export function createEmptyIntake(): IntakeDraft {
  return {
    originalQuestion: "",
    intendedApplication: "",
    populationOrGeography: "",
    timeHorizon: "",
    availableMaterialsOrBudget: "",
    desiredDepth: "",
    constraints: "",
    clarifications: [],
    claims: [],
  };
}

export function validateIntake(draft: IntakeDraft): IntakeValidation {
  const claimFields: IntakeValidation["claimFields"] = {};

  for (const claim of draft.claims) {
    const errors: {
      statement?: string;
      operationalDefinition?: string;
    } = {};

    if (claim.statement.trim() === "") {
      errors.statement = "Enter a concise, testable statement.";
    }
    if (claim.operationalDefinition.trim() === "") {
      errors.operationalDefinition =
        "Define the observable success or failure condition.";
    }
    if (Object.keys(errors).length > 0) {
      claimFields[claim.id] = errors;
    }
  }

  return {
    originalQuestion:
      draft.originalQuestion.trim() === ""
        ? "Enter the research question."
        : undefined,
    intendedApplication:
      draft.intendedApplication.trim() === ""
        ? "Enter the intended application."
        : undefined,
    claims:
      draft.claims.length === 0 ? "Add at least one testable claim." : undefined,
    claimFields,
    clarifications:
      draft.clarifications.length > 3
        ? "Keep clarification questions to three or fewer."
        : undefined,
  };
}

export function hasValidationErrors(validation: IntakeValidation): boolean {
  return (
    validation.originalQuestion !== undefined ||
    validation.intendedApplication !== undefined ||
    validation.claims !== undefined ||
    validation.clarifications !== undefined ||
    Object.keys(validation.claimFields).length > 0
  );
}
