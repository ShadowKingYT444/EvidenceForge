import { LiveIntake } from "@/features/research/live-intake";

type IntakePageProps = { searchParams: Promise<{ example?: string | string[] }> };

export default async function IntakePage({ searchParams }: IntakePageProps) {
  const { example } = await searchParams;
  return <LiveIntake example={example === "ai-reliability"} />;
}
