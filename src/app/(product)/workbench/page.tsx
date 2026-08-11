import { goldenRunV01 } from "@/fixtures/golden-run-v0.1";
import type { ResearchRun } from "@/contracts";
import { headers } from "next/headers";
import { buildConclusionsGapModel } from "@/features/workbench/conclusions-gap-state";
import {
  buildExperimentProtocolModel,
  buildExperimentProtocolScenarioModel,
  isExperimentProtocolScenario,
} from "@/features/workbench/experiment-protocol-state";
import {
  buildObjectionDispositionModel,
  buildObjectionDispositionScenarioModel,
} from "@/features/workbench/objection-disposition-state";
import { WorkbenchShell } from "@/features/workbench/workbench-shell";
import type { FinalDecisionPanelModel } from "@/features/workbench/final-decision-panel";
import { loadProcessLocalRunFromApi } from "@/features/workbench/process-local-run-loader";
import {
  buildEvidenceMatrixModel,
  buildEvidenceMatrixScenarioModel,
  isEvidenceMatrixScenario,
} from "@/features/workbench/evidence-matrix-state";
import {
  bindPacketReviewDecisionSession,
  isPacketReviewScenario,
  preparePacketReview,
} from "@/features/workbench/packet-review-state";
import {
  buildWorkbenchModel,
  buildWorkbenchScenarioModel,
  isWorkbenchScenario,
} from "@/features/workbench/workbench-state";
import {
  resolveWorkbenchProjectionQuery,
  SIMULATED_OBJECTION_RUN_ID,
  type WorkbenchProjectionQuery,
} from "@/features/workbench/workbench-query-policy";

type WorkbenchPageProps = {
  searchParams: Promise<WorkbenchProjectionQuery>;
};

export default async function WorkbenchPage({
  searchParams,
}: WorkbenchPageProps) {
  const {
    scenario,
    packet,
    matrix,
    evidence,
    protocol,
    dispositions,
    runId,
    expectedRevision,
  } = resolveWorkbenchProjectionQuery(await searchParams);
  let canonicalRun: ResearchRun = goldenRunV01;
  let finalDecision: FinalDecisionPanelModel = {
    kind: "recorded",
    run: canonicalRun,
  };
  if (runId !== undefined) {
    try {
      const requestHeaders = await headers();
      const snapshot = await loadProcessLocalRunFromApi({
        runId,
        host: requestHeaders.get("host") ?? "",
        environment: process.env,
      });
      canonicalRun = snapshot.run;
      finalDecision = {
        kind: "process_local",
        run: snapshot.run,
        revision: snapshot.revision,
      };
    } catch {
      finalDecision = { kind: "unavailable", run: canonicalRun };
    }
  }
  const packetScenario = isPacketReviewScenario(packet) ? packet : "frozen";
  const prepared = preparePacketReview(
    canonicalRun,
    packetScenario,
  );
  const packetReview = bindPacketReviewDecisionSession(
    prepared.model,
    packetScenario === "stale-session" ? { now: 0, ttlMs: 1 } : undefined,
  );
  const projectedModel = prepared.run
    ? isWorkbenchScenario(scenario)
      ? buildWorkbenchScenarioModel(prepared.run, scenario)
      : buildWorkbenchModel(prepared.run)
    : null;
  const hasRestrictedPacketContent = packetReview.sources.some(
    (source) =>
      source.display.state === "hidden" || source.modelAccess.state === "excluded",
  );
  const model =
    projectedModel && hasRestrictedPacketContent
      ? { ...projectedModel, evidencePreview: null }
      : projectedModel;
  const matrixDisplayOverrides = new Map(
    packetReview.sources.map((source) => [
      source.id,
      source.display.state === "hidden"
        ? { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }
        : { state: "available" as const },
    ]),
  );
  const inferredMatrixScenario =
    isEvidenceMatrixScenario(matrix)
      ? matrix
      : packetScenario === "loading" || packetScenario === "empty"
        ? packetScenario
        : null;
  const evidenceMatrix = prepared.run
    ? inferredMatrixScenario
      ? buildEvidenceMatrixScenarioModel(
          prepared.run,
          inferredMatrixScenario,
          matrixDisplayOverrides,
        )
      : buildEvidenceMatrixModel(prepared.run, matrixDisplayOverrides)
    : null;
  const conclusionsGap =
    prepared.run && evidenceMatrix
      ? buildConclusionsGapModel(prepared.run, evidenceMatrix)
      : null;
  const experimentProtocol = prepared.run
    ? isExperimentProtocolScenario(protocol)
      ? buildExperimentProtocolScenarioModel(prepared.run, protocol)
      : buildExperimentProtocolModel(prepared.run)
    : null;
  const objectionDisposition =
    prepared.run && evidenceMatrix
      ? dispositions === "awaiting"
        ? buildObjectionDispositionScenarioModel(
            prepared.run,
            evidenceMatrix,
            {
              runId: SIMULATED_OBJECTION_RUN_ID,
              expectedRevision: expectedRevision ?? "",
            },
          )
        : buildObjectionDispositionModel(prepared.run, evidenceMatrix)
      : null;

  return (
    <WorkbenchShell
      model={model}
      packetReview={packetReview}
      evidenceMatrix={evidenceMatrix}
      conclusionsGap={conclusionsGap}
      experimentProtocol={experimentProtocol}
      objectionDisposition={objectionDisposition}
      finalDecision={finalDecision}
      initialEvidenceId={evidence ?? null}
    />
  );
}
