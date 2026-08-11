import { describe, expect, it } from "vitest";

import {
  createEmptyIntake,
  validateIntake,
  type IntakeDraft,
} from "../../src/features/intake/intake-state";

function validDraft(): IntakeDraft {
  return {
    ...createEmptyIntake(),
    originalQuestion: "Can the bounded intervention improve the named outcome?",
    intendedApplication: "A reviewable laboratory comparison",
    claims: [
      {
        id: "claim-1",
        statement: "The intervention improves the outcome under the bounded test.",
        operationalDefinition:
          "The preregistered primary measure exceeds the comparator threshold.",
      },
    ],
  };
}

describe("intake scope validation", () => {
  it("represents a genuinely empty intake", () => {
    expect(createEmptyIntake()).toEqual({
      originalQuestion: "",
      intendedApplication: "",
      populationOrGeography: "",
      timeHorizon: "",
      availableMaterialsOrBudget: "",
      desiredDepth: "",
      constraints: "",
      clarifications: [],
      claims: [],
    });
  });

  it("rejects an empty intake and names the missing approval fields", () => {
    expect(validateIntake(createEmptyIntake())).toEqual({
      originalQuestion: "Enter the research question.",
      intendedApplication: "Enter the intended application.",
      claims: "Add at least one testable claim.",
      claimFields: {},
      clarifications: undefined,
    });
  });

  it("rejects incomplete claim rows", () => {
    const draft = validDraft();
    draft.claims[0] = {
      ...draft.claims[0],
      operationalDefinition: " ",
    };

    expect(validateIntake(draft).claimFields).toEqual({
      "claim-1": {
        operationalDefinition:
          "Define the observable success or failure condition.",
      },
    });
  });

  it("accepts a bounded draft with complete claim definitions", () => {
    expect(validateIntake(validDraft())).toEqual({
      originalQuestion: undefined,
      intendedApplication: undefined,
      claims: undefined,
      claimFields: {},
      clarifications: undefined,
    });
  });

  it("rejects more than three clarification questions", () => {
    const draft = validDraft();
    draft.clarifications = ["One?", "Two?", "Three?", "Four?"];

    expect(validateIntake(draft).clarifications).toBe(
      "Keep clarification questions to three or fewer.",
    );
  });
});
