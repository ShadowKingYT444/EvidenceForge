import { headers } from "next/headers";

import { goldenRunV01 } from "@/fixtures/golden-run-v0.1";
import { buildConclusionsGapModel } from "@/features/workbench/conclusions-gap-state";
import { buildEvidenceMatrixModel, buildEvidenceMatrixScenarioModel, isEvidenceMatrixScenario, type MatrixDisplayOverrides } from "@/features/workbench/evidence-matrix-state";
import { buildExperimentProtocolModel, buildExperimentProtocolScenarioModel, isExperimentProtocolScenario } from "@/features/workbench/experiment-protocol-state";
import { buildObjectionDispositionModel, buildObjectionDispositionScenarioModel } from "@/features/workbench/objection-disposition-state";
import { bindPacketReviewDecisionSession, buildPacketReviewModel, isPacketReviewScenario } from "@/features/workbench/packet-review-state";
import { loadProcessLocalRunFromApi } from "@/features/workbench/process-local-run-loader";
import { resolveWorkbenchProjectionQuery, SIMULATED_OBJECTION_RUN_ID } from "@/features/workbench/workbench-query-policy";
import { WorkbenchShell, type WorkbenchStageId } from "@/features/workbench/workbench-shell";
import { buildWorkbenchModel, buildWorkbenchScenarioModel, isWorkbenchScenario } from "@/features/workbench/workbench-state";

type SearchValue = string | string[] | undefined;
type WorkbenchPageProps = { searchParams: Promise<Record<string, SearchValue>> };

function first(value: SearchValue) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkbenchPage({ searchParams }: WorkbenchPageProps) {
  const raw = await searchParams;
  const query = resolveWorkbenchProjectionQuery({
    scenario: first(raw.scenario),
    packet: first(raw.packet),
    matrix: first(raw.matrix),
    evidence: first(raw.evidence),
    protocol: first(raw.protocol),
    dispositions: first(raw.dispositions),
    runId: first(raw.runId),
    expectedRevision: first(raw.expectedRevision),
  });

  let run = goldenRunV01;
  let revision: string | null = null;
  if (query.runId) {
    const host = (await headers()).get("host");
    if (!host) throw new Error("Process-local origin authority unavailable.");
    const loaded = await loadProcessLocalRunFromApi({ runId: query.runId, host, environment: process.env });
    run = loaded.run;
    revision = loaded.revision;
  }

  const model = !query.runId && isWorkbenchScenario(query.scenario) ? buildWorkbenchScenarioModel(run, query.scenario) : buildWorkbenchModel(run);
  const packetScenario = !query.runId && isPacketReviewScenario(query.packet) ? query.packet : "frozen";
  const packetReviewBase = buildPacketReviewModel(run, packetScenario);
  const packetReview = packetScenario === "review"
    ? bindPacketReviewDecisionSession(packetReviewBase)
    : packetScenario === "stale-session"
      ? bindPacketReviewDecisionSession(packetReviewBase, { now: Date.now() - 60_000, ttlMs: 1 })
      : packetReviewBase;
  const displayOverrides: MatrixDisplayOverrides = new Map(packetReview.sources.map((source) => [source.id, source.display.state === "available" ? { state: "available" as const } : { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }]));
  const evidenceMatrix = !query.runId && isEvidenceMatrixScenario(query.matrix) ? buildEvidenceMatrixScenarioModel(run, query.matrix, displayOverrides) : buildEvidenceMatrixModel(run, displayOverrides);
  const conclusionsGap = evidenceMatrix.state === "ready" ? buildConclusionsGapModel(run, evidenceMatrix) : null;
  const experimentProtocol = !query.runId && isExperimentProtocolScenario(query.protocol) ? buildExperimentProtocolScenarioModel(run, query.protocol) : buildExperimentProtocolModel(run);
  const objectionDisposition = evidenceMatrix.state === "ready"
    ? !query.runId && query.dispositions === "awaiting"
      ? buildObjectionDispositionScenarioModel(run, evidenceMatrix, { runId: SIMULATED_OBJECTION_RUN_ID, expectedRevision: query.expectedRevision ?? "revision-7" })
      : buildObjectionDispositionModel(run, evidenceMatrix)
    : null;
  const finalDecision = query.runId && revision
    ? { kind: "process_local" as const, run, revision }
    : { kind: "recorded" as const, run };
  const shellModel = !query.runId && (query.packet === "missing-packet" || query.packet === "tampered-packet")
    ? null
    : model;
  const decisionScenarios = new Set(["reviewer", "final-decision", "approved", "rejected", "failed"]);
  const evidenceScenarios = new Set(["awaiting", "collecting", "running", "partial", "fixture"]);
  const initialStage: WorkbenchStageId = query.runId
    ? "decision"
    : query.packet
      ? "packet"
      : query.protocol
        ? "experiment"
        : query.dispositions
          ? "review"
          : query.matrix || query.evidence || !query.scenario || evidenceScenarios.has(query.scenario)
            ? "evidence"
            : decisionScenarios.has(query.scenario)
              ? "decision"
              : "audit";

  return <WorkbenchShell model={shellModel} packetReview={packetReview} evidenceMatrix={evidenceMatrix} conclusionsGap={conclusionsGap} experimentProtocol={experimentProtocol} objectionDisposition={objectionDisposition} finalDecision={finalDecision} initialEvidenceId={query.evidence ?? null} allowSimulatedStates={!query.runId} initialStage={initialStage} />;
}
