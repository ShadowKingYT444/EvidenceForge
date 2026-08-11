import { ResearchRunSchema, type ResearchRun } from "../../contracts";

import { buildAuditLedger, resolveAuditScenario } from "./audit-ledger";

type RunStatus = ResearchRun["status"];
type EvidenceMode = ResearchRun["evidenceMode"];
type RunError = ResearchRun["errors"][number];

export const WORKBENCH_SCENARIOS = [
  "awaiting",
  "collecting",
  "running",
  "partial",
  "fixture",
  "timeout",
  "refusal",
  "invalid-json",
  "invalid-schema",
  "invalid-output",
  "retry-exhausted",
  "retry",
  "source-mismatch",
  "missing-source",
  "reviewer-decision",
  "final-decision",
  "approved",
  "rejected",
  "failed",
  "stale-execution",
] as const;

export type WorkbenchScenario = (typeof WORKBENCH_SCENARIOS)[number];

type StateTone = "neutral" | "active" | "warning" | "success" | "danger";

type RecoveryPresentation = {
  kind: RunError["kind"] | "metadata_mismatch";
  evidenceMode: "fixture" | "simulated";
  contractSource: string;
  allowedAction: string;
  priorAttemptRetained: true;
};

type StatePresentation = {
  status: RunStatus;
  label: string;
  phase: string;
  description: string;
  nextStep: string;
  tone: StateTone;
  isRunning: boolean;
};

const statePresentations: Record<RunStatus, StatePresentation> = {
  draft: {
    status: "draft",
    label: "Draft",
    phase: "Scope",
    description: "The research boundary has not entered the workflow.",
    nextStep: "Complete and approve the claim scope.",
    tone: "neutral",
    isRunning: false,
  },
  decomposing: {
    status: "decomposing",
    label: "Decomposing claims",
    phase: "Scope",
    description: "The approved question is being mapped to testable claims.",
    nextStep: "Wait for the current node or inspect the audit record.",
    tone: "active",
    isRunning: true,
  },
  awaiting_scope_approval: {
    status: "awaiting_scope_approval",
    label: "Awaiting scope approval",
    phase: "Human checkpoint",
    description: "Source collection stays blocked until a human approves the claim contract.",
    nextStep: "Return to intake to approve or revise the scope.",
    tone: "warning",
    isRunning: false,
  },
  collecting_sources: {
    status: "collecting_sources",
    label: "Collecting approved sources",
    phase: "Source packet",
    description: "Only the bounded, approved source path is active.",
    nextStep: "Wait for collection to finish; failures remain in the audit record.",
    tone: "active",
    isRunning: true,
  },
  awaiting_packet_approval: {
    status: "awaiting_packet_approval",
    label: "Packet approval required",
    phase: "Human checkpoint",
    description: "Evidence extraction is blocked until the source packet is reviewed and frozen.",
    nextStep: "Review source rights, provenance, and packet contents.",
    tone: "warning",
    isRunning: false,
  },
  extracting_evidence: {
    status: "extracting_evidence",
    label: "Extracting evidence",
    phase: "Claims & evidence",
    description: "Passages are being mapped to approved claims.",
    nextStep: "Wait for the active node or inspect preserved attempts.",
    tone: "active",
    isRunning: true,
  },
  verifying_evidence: {
    status: "verifying_evidence",
    label: "Verifying evidence",
    phase: "Claims & evidence",
    description: "Existence, metadata, model assessment, and human review remain separate.",
    nextStep: "Inspect partial results without treating them as a final conclusion.",
    tone: "active",
    isRunning: true,
  },
  synthesizing: {
    status: "synthesizing",
    label: "Synthesizing conclusions",
    phase: "Claims & evidence",
    description: "Categorical conclusions are being assembled from traceable evidence cards.",
    nextStep: "Wait for synthesis or inspect the evidence already available.",
    tone: "active",
    isRunning: true,
  },
  planning_experiment: {
    status: "planning_experiment",
    label: "Planning experiment",
    phase: "Experiment",
    description: "A reviewable educational protocol is being proposed for the selected gap.",
    nextStep: "Wait for a complete proposal or a typed abstention.",
    tone: "active",
    isRunning: true,
  },
  reviewing_experiment: {
    status: "reviewing_experiment",
    label: "Reviewing experiment",
    phase: "Experiment",
    description: "An adversarial reviewer is checking the proposal for named failure modes.",
    nextStep: "Wait for objections; no objection is silently resolved.",
    tone: "active",
    isRunning: true,
  },
  awaiting_objection_dispositions: {
    status: "awaiting_objection_dispositions",
    label: "Reviewer decision required",
    phase: "Human checkpoint",
    description: "Every objection needs an accepted, rejected, or unresolved disposition.",
    nextStep: "Review objections and record explicit dispositions.",
    tone: "warning",
    isRunning: false,
  },
  revising_experiment: {
    status: "revising_experiment",
    label: "Revising experiment",
    phase: "Experiment",
    description: "Accepted objections are being applied while unresolved risk is preserved.",
    nextStep: "Wait for the revision diff to complete.",
    tone: "active",
    isRunning: true,
  },
  awaiting_final_approval: {
    status: "awaiting_final_approval",
    label: "Final decision required",
    phase: "Human checkpoint",
    description: "The proposal, objections, revisions, and unresolved risks await a human decision.",
    nextStep: "Approve or reject after reviewing the full record.",
    tone: "warning",
    isRunning: false,
  },
  approved: {
    status: "approved",
    label: "Approved with boundaries",
    phase: "Final decision",
    description: "A human approved the bounded proposal; unresolved risks still apply.",
    nextStep: "Inspect the canonical record before using or exporting it.",
    tone: "success",
    isRunning: false,
  },
  rejected: {
    status: "rejected",
    label: "Rejected",
    phase: "Final decision",
    description: "A human rejected the proposal. No downstream success is implied.",
    nextStep: "Inspect the decision record and preserved objections.",
    tone: "danger",
    isRunning: false,
  },
  failed: {
    status: "failed",
    label: "Run failed",
    phase: "Terminal state",
    description: "The workflow ended without an approved result.",
    nextStep: "Inspect the failure and retry eligibility in the audit record.",
    tone: "danger",
    isRunning: false,
  },
};

const modePresentations: Record<
  EvidenceMode,
  { key: EvidenceMode; label: string; description: string }
> = {
  live: {
    key: "live",
    label: "Live",
    description: "Provider-backed run record",
  },
  fixture: {
    key: "fixture",
    label: "Fixture",
    description: "Deterministic reviewed fixture",
  },
  mocked: {
    key: "mocked",
    label: "Mocked",
    description: "Mocked dependency record",
  },
  simulated: {
    key: "simulated",
    label: "Simulated",
    description: "Simulated state record",
  },
  unverified: {
    key: "unverified",
    label: "Unverified",
    description: "Evidence provenance unverified",
  },
};

export type WorkbenchModel = ReturnType<typeof buildWorkbenchModel>;

export function buildWorkbenchModel(run: ResearchRun) {
  const conclusions = new Map(
    run.conclusions.map((conclusion) => [conclusion.subclaimId, conclusion]),
  );
  const sources = new Map(run.sources.map((source) => [source.id, source]));
  const chunks = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
  const relationshipCounts = {
    supports: 0,
    contradicts: 0,
    unresolved: 0,
  };

  for (const card of run.evidenceCards) {
    relationshipCounts[card.relationship] += 1;
  }

  const claims = run.claims.map((claim) => {
    const conclusion = conclusions.get(claim.id);
    const cards = run.evidenceCards.filter(
      (card) => card.subclaimId === claim.id,
    );

    return {
      id: claim.id,
      statement: claim.statement,
      operationalDefinition: claim.operationalDefinition,
      disposition: claim.disposition,
      strength: conclusion?.strength ?? "not_assessed",
      disagreement: conclusion?.disagreementSummary ?? null,
      evidenceCount: cards.length,
    };
  });

  const previewCard =
    run.evidenceCards.find((card) => {
      const chunk = chunks.get(card.sourceChunkId);
      const source = chunk ? sources.get(chunk.sourceId) : null;
      return (
        chunk?.displayPermission === "allowed" &&
        source?.rights.mayDisplay === "allowed"
      );
    }) ?? null;
  const previewChunk = previewCard
    ? chunks.get(previewCard.sourceChunkId) ?? null
    : null;
  const previewSource = previewChunk
    ? sources.get(previewChunk.sourceId) ?? null
    : null;
  const selectedGap =
    run.researchGaps.find((gap) => gap.id === run.selectedGapId) ?? null;
  const unresolvedObjectionCount =
    run.revision?.decisions.filter(
      (decision) => decision.disposition === "unresolved",
    ).length ??
    run.finalDecision?.unresolvedObjections.length ??
    0;

  return {
    scenario: null as WorkbenchScenario | null,
    disclosure: null as string | null,
    run: {
      id: run.id,
      schemaVersion: run.schemaVersion,
      evidenceMode: run.evidenceMode,
      status: run.status,
      updatedAt: run.updatedAt,
    },
    mode: modePresentations[run.evidenceMode],
    state: statePresentations[run.status],
    scope: {
      question: run.intake.originalQuestion,
      application: run.intake.intendedApplication,
      population: run.intake.populationOrGeography,
      timeHorizon: run.intake.timeHorizon,
      constraints: run.intake.constraints,
    },
    claims,
    matrix: {
      sourceCount: run.sources.length,
      evidenceCount: run.evidenceCards.length,
      relationshipCounts,
      metadataMismatchCount: run.sources.filter(
        (source) => source.metadataVerification.status === "mismatch",
      ).length,
    },
    evidencePreview: previewCard
      ? {
          id: previewCard.id,
          relationship: previewCard.relationship,
          excerpt: previewCard.excerpt,
          result: previewCard.extractedResult,
          limitation: previewCard.limitation,
          warning: previewCard.conclusionStrengthWarning,
          location: previewChunk?.location ?? "Location unavailable",
          contentScope:
            previewSource?.access.contentScope ?? "Content scope unavailable",
          sourceTitle:
            previewSource?.bibliographicMetadata.title ?? "Source unavailable",
          deterministicStatus: previewCard.deterministicVerification.status,
          modelEntailment: previewCard.modelAssessment.entailment,
          humanReview: previewCard.humanReview.status,
        }
      : null,
    experiment: {
      selectedGapId: selectedGap?.id ?? null,
      gapType: selectedGap?.type ?? null,
      impact: selectedGap?.impactRationale ?? null,
      objective: run.experiment?.objective ?? null,
      abstentionReason: run.experimentAbstention?.reason ?? null,
      qualifiedReviewRequired:
        run.experiment?.qualifiedReviewRequired ??
        run.experimentAbstention?.qualifiedReviewRequired ??
        false,
      objectionCount: run.review?.objections.length ?? 0,
      revisionCount: run.revision?.decisions.length ?? 0,
      unresolvedObjectionCount,
    },
    audit: buildAuditLedger(run),
    attention: latestAttention(run.errors),
    recovery: null as RecoveryPresentation | null,
    finalDecision: {
      state: run.status as "approved" | "rejected" | "failed" | RunStatus,
      decision: run.finalDecision?.decision ?? null,
      optionsShown: run.finalDecision?.optionsShown ?? ["approve", "reject"],
      unresolvedObjectionCount,
      decidedAt: run.finalDecision?.decidedAt ?? null,
    },
  };
}

function staleExecutionRun(run: ResearchRun): ResearchRun {
  const source = run.executions[0];
  if (!source) {
    return run;
  }

  return ResearchRunSchema.parse({
    ...structuredClone(run),
    status: "approved",
    executions: [
      {
        ...structuredClone(source),
        id: "fixture-stale-open-after-approval",
        status: "started",
        endedAt: null,
      },
    ],
  });
}

export function buildWorkbenchScenarioModel(
  run: ResearchRun,
  scenario: WorkbenchScenario,
) {
  const scenarioRun =
    scenario === "stale-execution" ? staleExecutionRun(run) : run;
  return resolveWorkbenchScenario(buildWorkbenchModel(scenarioRun), scenario);
}

function latestAttention(errors: RunError[]) {
  let error: RunError | undefined;
  for (const candidate of errors) {
    if (!error || candidate.occurredAt > error.occurredAt) {
      error = candidate;
    }
  }
  if (!error) {
    return null;
  }
  return {
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    nodeId: error.nodeId,
  };
}

function scenarioAttention(
  kind: RunError["kind"],
  message: string,
  retryable: boolean,
) {
  return {
    kind,
    message,
    retryable,
    nodeId: "fixture-state-preview",
  };
}

function recovery(
  kind: RecoveryPresentation["kind"],
  evidenceMode: RecoveryPresentation["evidenceMode"],
  contractSource: string,
  allowedAction: string,
): RecoveryPresentation {
  return {
    kind,
    evidenceMode,
    contractSource,
    allowedAction,
    priorAttemptRetained: true,
  };
}

export function resolveWorkbenchScenario(
  model: WorkbenchModel,
  scenario: WorkbenchScenario,
): WorkbenchModel {
  let state = model.state;
  let attention = model.attention;
  let recoveryModel = model.recovery;
  let finalDecision = model.finalDecision;

  switch (scenario) {
    case "awaiting":
      state = statePresentations.awaiting_scope_approval;
      attention = null;
      finalDecision = { ...finalDecision, state: "awaiting_scope_approval", decision: null };
      break;
    case "collecting":
      state = statePresentations.collecting_sources;
      attention = null;
      finalDecision = { ...finalDecision, state: "collecting_sources", decision: null };
      break;
    case "running":
      state = statePresentations.verifying_evidence;
      attention = null;
      finalDecision = { ...finalDecision, state: "verifying_evidence", decision: null };
      break;
    case "partial":
      state = {
        ...statePresentations.verifying_evidence,
        label: "Partial evidence",
        description:
          "Some evidence is inspectable, but missing and unresolved relationships block a final conclusion.",
        nextStep: "Inspect what is available and keep absent evidence explicit.",
        tone: "warning",
        isRunning: false,
      };
      attention = scenarioAttention(
        "missing_evidence",
        "The fixture preview intentionally leaves evidence unresolved.",
        false,
      );
      finalDecision = { ...finalDecision, state: "verifying_evidence", decision: null };
      break;
    case "timeout":
      state = {
        ...statePresentations.verifying_evidence,
        label: "Provider timeout",
        tone: "warning",
        isRunning: false,
      };
      attention = scenarioAttention(
        "timeout",
        "The provider timed out before returning a validated result.",
        true,
      );
      recoveryModel = recovery(
        "timeout",
        "simulated",
        "RunError.kind=timeout",
        "Retry this node after confirming the provider is available; the timed-out attempt remains in the ledger.",
      );
      finalDecision = { ...finalDecision, state: "verifying_evidence", decision: null };
      break;
    case "refusal":
      state = {
        ...statePresentations.planning_experiment,
        label: "Provider refusal",
        tone: "warning",
        isRunning: false,
      };
      attention = scenarioAttention(
        "provider_refusal",
        "The provider refused the request; no proposal was produced.",
        false,
      );
      recoveryModel = recovery(
        "provider_refusal",
        "simulated",
        "RunError.kind=provider_refusal",
        "Revise the request or stop; this refusal is not automatically retried.",
      );
      finalDecision = { ...finalDecision, state: "planning_experiment", decision: null };
      break;
    case "invalid-json":
      state = {
        ...statePresentations.planning_experiment,
        label: "Invalid provider JSON",
        tone: "warning",
        isRunning: false,
      };
      attention = scenarioAttention(
        "invalid_model_json",
        "The provider response was not valid JSON and was not accepted.",
        true,
      );
      recoveryModel = recovery(
        "invalid_model_json",
        "simulated",
        "RunError.kind=invalid_model_json",
        "Retry with JSON repair inside the declared attempt budget; retain the invalid response as failure evidence.",
      );
      finalDecision = { ...finalDecision, state: "planning_experiment", decision: null };
      break;
    case "invalid-schema":
    case "invalid-output":
      state = {
        ...statePresentations.planning_experiment,
        label: "Invalid model output",
        tone: "warning",
        isRunning: false,
      };
      attention = scenarioAttention(
        "invalid_model_output",
        "The model response failed contract validation and was not accepted.",
        true,
      );
      recoveryModel = recovery(
        "invalid_model_output",
        "simulated",
        "RunError.kind=invalid_model_output",
        "Retry after schema validation inside the declared attempt budget; retain the rejected output.",
      );
      finalDecision = { ...finalDecision, state: "planning_experiment", decision: null };
      break;
    case "retry-exhausted":
      state = {
        ...statePresentations.planning_experiment,
        label: "Retry budget exhausted",
        description:
          "Both declared attempts failed; no additional automatic retry or success is implied.",
        nextStep: "Review the retained failures before changing input or provider configuration.",
        tone: "danger",
        isRunning: false,
      };
      attention = scenarioAttention(
        "provider_failure",
        "The provider retry budget was exhausted after two failed attempts.",
        false,
      );
      recoveryModel = recovery(
        "provider_failure",
        "simulated",
        "RunError.kind=provider_failure + NodeExecution.retryOfExecutionId",
        "Review the input or provider configuration; automatic retry is no longer permitted.",
      );
      finalDecision = { ...finalDecision, state: "planning_experiment", decision: null };
      break;
    case "retry":
      state = {
        ...statePresentations.reviewing_experiment,
        label: "Retry completed",
        tone: "warning",
        isRunning: false,
        description:
          "A later fixture attempt succeeded; earlier failures remain visible and unchanged.",
      };
      attention = scenarioAttention(
        "provider_failure",
        "The prior provider failure is preserved beside its explicit retry.",
        true,
      );
      recoveryModel = recovery(
        "provider_failure",
        "fixture",
        "goldenRunV01.errors + NodeExecution.retryOfExecutionId",
        "Continue from the successful linked retry while keeping both failed attempts visible.",
      );
      finalDecision = { ...finalDecision, state: "reviewing_experiment", decision: null };
      break;
    case "source-mismatch":
      state = {
        ...statePresentations.awaiting_packet_approval,
        label: "Source metadata mismatch",
        description:
          "The canonical fixture retains field-level supplied-versus-provider metadata differences.",
        nextStep: "Review the mismatch before accepting or refreezing the bounded packet.",
        tone: "warning",
        isRunning: false,
      };
      attention = null;
      recoveryModel = recovery(
        "metadata_mismatch",
        "fixture",
        "SourceRecord.metadataVerification.status=mismatch",
        "Review the field-level mismatch; correct the source only through a new packet version and freeze.",
      );
      finalDecision = { ...finalDecision, state: "awaiting_packet_approval", decision: null };
      break;
    case "missing-source": {
      state = {
        ...statePresentations.collecting_sources,
        label: "Source not found",
        description:
          "The supplied DOI did not resolve, so no source, passage, or entailment record was created.",
        nextStep: "Add or approve another bounded source before continuing.",
        tone: "warning",
        isRunning: false,
      };
      const missingAttempt = model.audit.executions.find((execution) =>
        execution.errors.some((error) => error.kind === "missing_source"),
      );
      const missingError = missingAttempt?.errors.find(
        (error) => error.kind === "missing_source",
      );
      attention = missingError
        ? {
            kind: "missing_source",
            message: missingError.message,
            retryable: missingError.retryable,
            nodeId: missingAttempt?.nodeId ?? "collect-sources",
          }
        : scenarioAttention(
            "missing_source",
            "The source was not found; no source or passage record was created.",
            false,
          );
      recoveryModel = recovery(
        "missing_source",
        "fixture",
        "goldenRunV01.errors[kind=missing_source]",
        "Add or approve another bounded source; the nonexistent DOI is not retried as a successful source.",
      );
      finalDecision = { ...finalDecision, state: "collecting_sources", decision: null };
      break;
    }
    case "reviewer-decision":
      state = statePresentations.awaiting_objection_dispositions;
      attention = null;
      finalDecision = {
        ...finalDecision,
        state: "awaiting_objection_dispositions",
        decision: null,
      };
      break;
    case "final-decision":
      state = statePresentations.awaiting_final_approval;
      attention = null;
      finalDecision = {
        ...finalDecision,
        state: "awaiting_final_approval",
        decision: null,
        optionsShown: ["approve", "reject"],
      };
      break;
    case "approved":
      state = statePresentations.approved;
      attention = model.attention;
      finalDecision = { ...finalDecision, state: "approved", decision: "approve" };
      break;
    case "rejected":
      state = statePresentations.rejected;
      attention = null;
      finalDecision = { ...finalDecision, state: "rejected", decision: "reject" };
      break;
    case "failed":
      state = statePresentations.failed;
      attention = scenarioAttention(
        "provider_failure",
        "The fixture state preview ended without an approved result.",
        false,
      );
      finalDecision = { ...finalDecision, state: "failed", decision: null };
      break;
    case "stale-execution":
      break;
    case "fixture":
      break;
  }

  return {
    ...model,
    scenario,
    disclosure: "Fixture state preview—not a live provider result.",
    audit: resolveAuditScenario(model.audit, scenario),
    state,
    attention,
    recovery: recoveryModel,
    finalDecision,
  };
}

export function isWorkbenchScenario(
  value: string | undefined,
): value is WorkbenchScenario {
  return WORKBENCH_SCENARIOS.includes(value as WorkbenchScenario);
}
