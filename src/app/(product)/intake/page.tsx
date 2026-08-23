import { LiveIntake } from "@/features/research/live-intake";
import { IntakeScope } from "@/features/intake/intake-scope";
import type { IntakeDraft } from "@/features/intake/intake-state";
import { goldenRunV01 } from "@/fixtures/golden-run-v0.1";

type IntakePageProps = { searchParams: Promise<{ example?: string | string[]; demo?: string | string[] }> };

export default async function IntakePage({ searchParams }: IntakePageProps) {
  const { example, demo } = await searchParams;
  if (example === "ai-reliability") return <LiveIntake example />;
  const goldenDraft: IntakeDraft = {
    originalQuestion: goldenRunV01.intake.originalQuestion,
    intendedApplication: goldenRunV01.intake.intendedApplication,
    populationOrGeography: goldenRunV01.intake.populationOrGeography,
    timeHorizon: goldenRunV01.intake.timeHorizon,
    availableMaterialsOrBudget: goldenRunV01.intake.availableMaterialsOrBudget,
    desiredDepth: goldenRunV01.intake.desiredDepth,
    constraints: goldenRunV01.intake.constraints.join("\n"),
    clarifications: [...goldenRunV01.intake.unansweredClarifications],
    claims: goldenRunV01.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      operationalDefinition: claim.operationalDefinition,
    })),
  };
  return <IntakeScope goldenDraft={goldenDraft} startWithGolden={demo === "golden"} />;
}
