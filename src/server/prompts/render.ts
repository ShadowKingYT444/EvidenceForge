import { createHash } from "node:crypto";

import {
  ResearchRunSchema,
  canonicalizeJson,
  type ResearchRun,
} from "../../contracts";
import type { ObjectionDispositionPlan, WorkflowNodeId } from "../workflow";
import {
  parsePromptInput,
  promptRegistry,
  type PromptCondition,
  type PromptResource,
} from "./registry";

type BuilderInput = Readonly<{
  run: ResearchRun;
  nodeId: WorkflowNodeId;
  inputRefs: readonly string[];
  objectionDispositions: ObjectionDispositionPlan | null;
}>;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameSortedValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function assertFrozenModelPacket(run: ResearchRun): void {
  if (
    run.packet === null ||
    run.sources.length === 0 ||
    run.chunks.length === 0
  ) {
    throw new TypeError(
      "A nonempty, human-approved frozen packet with source chunks is required.",
    );
  }
  const sourceById = new Map(run.sources.map((source) => [source.id, source]));
  if (
    !sameSortedValues(
      run.packet.sourceHashes,
      run.sources.map(({ contentHash }) => contentHash),
    ) ||
    !sameSortedValues(
      run.packet.chunkHashes,
      run.chunks.map(({ contentHash }) => contentHash),
    )
  ) {
    throw new TypeError(
      "Frozen packet membership does not match the current sources and chunks.",
    );
  }
  for (const source of run.sources) {
    if (source.rights.maySendToModel !== "allowed") {
      throw new TypeError(
        "Source rights do not allow sending the complete frozen packet to a model.",
      );
    }
  }
  for (const chunk of run.chunks) {
    if (
      !sourceById.has(chunk.sourceId) ||
      chunk.contentHash !== sha256Text(chunk.text)
    ) {
      throw new TypeError(
        "A frozen source chunk is missing, detached, or has an invalid content hash.",
      );
    }
  }
}

export function normalizedSourceMetadata(runInput: ResearchRun) {
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  return run.sources.map((source) => ({
    id: source.id,
    originalInput: source.originalInput,
    canonicalDoi: source.canonicalDoi,
    canonicalUrl: source.canonicalUrl,
    doiResolution: {
      syntax: source.doiResolution.syntax,
      resolution: source.doiResolution.resolution,
      registrationAgency: source.doiResolution.registrationAgency,
    },
    bibliographicMetadata: source.bibliographicMetadata,
    access: {
      origin: source.access.origin,
      contentScope: source.access.contentScope,
      provider: source.access.provider,
      version: source.access.version,
      location: source.access.location,
    },
    rights: {
      mayStore: source.rights.mayStore,
      mayDisplay: source.rights.mayDisplay,
      maySendToModel: source.rights.maySendToModel,
      basis: source.rights.basis,
    },
    contentHash: source.contentHash,
    metadataVerification: {
      status: source.metadataVerification.status,
      method: source.metadataVerification.method,
      fieldDiffs: source.metadataVerification.fieldDiffs,
    },
    integrityNotices: source.integrityNotices.map((notice) => ({
      kind: notice.kind,
      noticeUrl: notice.noticeUrl,
      affectsSource: notice.affectsSource,
    })),
    mergedSourceIds: source.mergedSourceIds,
    warnings: source.warnings,
  }));
}

function resolvedScope(run: ResearchRun) {
  return {
    intake: run.intake,
    claims: run.claims,
    scopeDecision: run.scopeDecision,
  };
}

function sourcePacket(run: ResearchRun) {
  return {
    packet: run.packet,
    normalizedMetadata: normalizedSourceMetadata(run),
    chunks: run.chunks.map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      text: chunk.text,
      location: chunk.location,
      contentHash: chunk.contentHash,
      displayPermission: chunk.displayPermission,
    })),
  };
}

function experimentPlanningPayload(run: ResearchRun) {
  const selectedGap = run.researchGaps.find(
    ({ id }) => id === run.selectedGapId,
  );
  if (selectedGap === undefined || run.scopeDecision === null) {
    throw new TypeError(
      "experiment planning requires an approved scope and exact selected gap",
    );
  }
  const affectedIds = new Set(selectedGap.affectedSubclaimIds);
  const evidenceIds = new Set(selectedGap.evidenceCardIds);
  const claims = run.claims
    .filter(({ id }) => affectedIds.has(id))
    .map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      operationalDefinition: claim.operationalDefinition,
      category: claim.category,
      parentClaimId: claim.parentClaimId,
      scopeConstraints: claim.scopeConstraints,
      rationale: claim.rationale,
    }));
  const conclusions = run.conclusions.filter(({ subclaimId }) =>
    affectedIds.has(subclaimId),
  );
  const evidenceCards = run.evidenceCards.filter(({ id }) =>
    evidenceIds.has(id),
  );
  if (
    claims.length !== affectedIds.size ||
    conclusions.length !== affectedIds.size ||
    evidenceCards.length !== evidenceIds.size ||
    evidenceCards.some(({ subclaimId }) => !affectedIds.has(subclaimId))
  ) {
    throw new TypeError(
      "selected-gap claim, conclusion, and evidence references must resolve exactly",
    );
  }
  return {
    resolvedScope: {
      intake: run.intake,
      claims,
      scopeChoice: {
        decision: run.scopeDecision.decision,
        edits: run.scopeDecision.edits,
        unresolvedObjections: run.scopeDecision.unresolvedObjections,
      },
    },
    selectedGap: {
      id: selectedGap.id,
      affectedSubclaimIds: selectedGap.affectedSubclaimIds,
      type: selectedGap.type,
      impactRationale: selectedGap.impactRationale,
      tractabilityRationale: selectedGap.tractabilityRationale,
      evidenceCardIds: selectedGap.evidenceCardIds,
    },
    conclusions: conclusions.map((conclusion) => ({
      subclaimId: conclusion.subclaimId,
      strength: conclusion.strength,
      conclusion: conclusion.conclusion,
      supportingEvidenceCardIds: conclusion.supportingEvidenceCardIds,
      contradictingEvidenceCardIds: conclusion.contradictingEvidenceCardIds,
      disagreementSummary: conclusion.disagreementSummary,
      limitations: conclusion.limitations,
      changeEvidence: conclusion.changeEvidence,
      overclaimingWarnings: conclusion.overclaimingWarnings,
    })),
    evidenceCards: evidenceCards.map((card) => ({
      id: card.id,
      subclaimId: card.subclaimId,
      sourceChunkId: card.sourceChunkId,
      excerpt: card.excerpt,
      extractedResult: card.extractedResult,
      settingAndSample: card.settingAndSample,
      studyType: card.studyType,
      limitation: card.limitation,
      relationship: card.relationship,
      entailment: card.modelAssessment.entailment,
      entailmentRationale: card.modelAssessment.rationale,
      conclusionStrengthWarning: card.conclusionStrengthWarning,
      extractionIssues: card.extractionIssues,
    })),
  };
}

function nodePayload(input: BuilderInput): unknown {
  const { run, nodeId, objectionDispositions } = input;
  switch (nodeId) {
    case "clarify-and-decompose":
      return { intake: run.intake };
    case "collect-sources":
      throw new TypeError(
        "collect-sources is a non-model bounded source-packet boundary and cannot be rendered.",
      );
    case "extract-evidence":
      return {
        resolvedScope: resolvedScope(run),
        ...sourcePacket(run),
      };
    case "assess-entailment":
      return {
        resolvedScope: resolvedScope(run),
        ...sourcePacket(run),
        evidenceCards: run.evidenceCards,
      };
    case "synthesize-conclusions":
      return {
        resolvedScope: resolvedScope(run),
        packetFingerprint: run.packet?.fingerprint,
        evidenceCards: run.evidenceCards,
      };
    case "plan-experiment":
      return experimentPlanningPayload(run);
    case "review-experiment":
      return {
        resolvedScope: resolvedScope(run),
        packetFingerprint: run.packet?.fingerprint,
        experiment: run.experiment,
        evidenceCards: run.evidenceCards,
      };
    case "revise-experiment":
      return {
        resolvedScope: resolvedScope(run),
        packetFingerprint: run.packet?.fingerprint,
        experiment: run.experiment,
        review: run.review,
        objectionDispositionDecision: run.objectionDispositionDecision,
        objectionDispositions,
      };
  }
}

function messages(
  resource: PromptResource,
  nodeId: PromptCondition,
  inputRefs: readonly string[],
  payload: unknown,
) {
  const validatedInput = parsePromptInput(nodeId, {
    kind: "evidenceforge.prompt-input.v1",
    nodeId,
    inputRefs: [...inputRefs],
    payload,
  });
  return [
    ...resource.messages,
    {
      role: "user" as const,
      content: canonicalizeJson(validatedInput),
    },
  ];
}

export function renderRunNodePrompt(input: BuilderInput) {
  const run = ResearchRunSchema.parse(structuredClone(input.run));
  const resource = promptRegistry.forNode(input.nodeId);
  if (
    resource.providerCapabilities.modelInvocation !== "allowed"
  ) {
    throw new TypeError(
      "collect-sources is a non-model bounded source-packet boundary.",
    );
  }
  if (resource.providerCapabilities.requiresFrozenPacket) {
    assertFrozenModelPacket(run);
  }
  return {
    promptId: resource.id,
    promptVersion: resource.version,
    promptHash: resource.hash,
    messages: messages(
      resource,
      input.nodeId,
      input.inputRefs,
      nodePayload({ ...input, run }),
    ),
    settings: resource.generationSettings,
    timeoutMs: resource.timeoutMs,
    repairInvalidOutput: resource.repairInvalidOutput,
    maximumAttempts: resource.maximumAttempts,
  };
}

export function createPromptRunNodeRequestBuilder() {
  return (input: BuilderInput) => renderRunNodePrompt(input);
}
