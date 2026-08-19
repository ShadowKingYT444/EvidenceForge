import { redirect } from "next/navigation";

type LegacyWorkbenchProps = {
  searchParams: Promise<{ runId?: string | string[] }>;
};

export default async function LegacyWorkbench({ searchParams }: LegacyWorkbenchProps) {
  const { runId } = await searchParams;
  if (typeof runId === "string" && runId.trim()) {
    redirect(`/runs/${encodeURIComponent(runId)}`);
  }
  redirect("/intake");
}
