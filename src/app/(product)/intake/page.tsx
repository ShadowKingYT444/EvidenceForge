import { goldenRunV01 } from "@/fixtures/golden-run-v0.1";
import { IntakeScope } from "@/features/intake/intake-scope";
import type { IntakeDraft } from "@/features/intake/intake-state";

function goldenIntakeDraft(): IntakeDraft {
  return {
    originalQuestion: goldenRunV01.intake.originalQuestion,
    intendedApplication: goldenRunV01.intake.intendedApplication,
    populationOrGeography: goldenRunV01.intake.populationOrGeography,
    timeHorizon: goldenRunV01.intake.timeHorizon,
    availableMaterialsOrBudget:
      goldenRunV01.intake.availableMaterialsOrBudget,
    desiredDepth: goldenRunV01.intake.desiredDepth,
    constraints: goldenRunV01.intake.constraints.join("\n"),
    clarifications: [...goldenRunV01.intake.unansweredClarifications],
    claims: goldenRunV01.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      operationalDefinition: claim.operationalDefinition,
    })),
  };
}

type IntakePageProps = {
  searchParams: Promise<{ demo?: string | string[] }>;
};

export default async function IntakePage({ searchParams }: IntakePageProps) {
  const demo = (await searchParams).demo;
  return (
    <IntakeScope
      goldenDraft={goldenIntakeDraft()}
      startWithGolden={demo === "golden"}
    />
  );
}
