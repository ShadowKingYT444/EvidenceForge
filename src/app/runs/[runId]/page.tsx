import { LiveWorkspace } from "@/features/research/live-workspace";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  return <LiveWorkspace runId={(await params).runId} />;
}
