import { LiveIntake } from "@/features/research/live-intake";
import { permanentRedirect } from "next/navigation";

type IntakePageProps = { searchParams: Promise<{ example?: string | string[]; demo?: string | string[] }> };

export default async function IntakePage({ searchParams }: IntakePageProps) {
  const { example, demo } = await searchParams;
  if (demo === "golden") permanentRedirect("/workbench");
  return <LiveIntake example={example === "ai-reliability"} />;
}
