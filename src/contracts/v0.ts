import { z } from "zod";

import { canonicalSha256 } from "./canonical";
import {
  CONTRACT_VERSION,
  LEGACY_CONTRACT_VERSION,
  PREVIOUS_CONTRACT_VERSION,
} from "./versioning";

const IdSchema = z.string().min(1);
const NullableIdSchema = IdSchema.nullable();
const TimestampSchema = z.string().datetime({ offset: true });
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NullableNonEmptyStringSchema = z.string().min(1).nullable();
const NonBlankTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "text must not be blank");
const StringListSchema = z.array(z.string());
const ForbiddenAuditTextSchema = /[\p{Cc}\p{Cf}]/u;

function inertAuditText(maximumLength: number, label: string) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value.trim().length > 0, `${label} must not be blank`)
    .refine(
      (value) => !ForbiddenAuditTextSchema.test(value),
      `${label} cannot contain control or formatting characters`,
    );
}

export const DeclaredActorSchema = inertAuditText(80, "declared actor");
export const DecisionRationaleSchema = inertAuditText(2_000, "rationale");

function isSortedUnique(values: string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1] < value,
  );
}

function enforceCheckTimestamp(
  status: string,
  notCheckedStatus: string,
  checkedAt: string | null,
  context: z.RefinementCtx,
): void {
  const notChecked = status === notCheckedStatus;
  if ((!notChecked && checkedAt === null) || (notChecked && checkedAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["checkedAt"],
      message: notChecked
        ? "not-checked state cannot carry a check timestamp"
        : "performed check state requires a timestamp",
    });
  }
}

export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export const ReadableContractVersionSchema = z.union([
  z.literal(LEGACY_CONTRACT_VERSION),
  z.literal(PREVIOUS_CONTRACT_VERSION),
  ContractVersionSchema,
]);
export const ReadableContractVersionV01Schema = z.union([
  z.literal(LEGACY_CONTRACT_VERSION),
  z.literal(PREVIOUS_CONTRACT_VERSION),
]);
export const EvidenceModeSchema = z.enum([
  "live",
  "fixture",
  "mocked",
  "simulated",
  "unverified",
]);

export const RunStatusSchema = z.enum([
  "draft",
  "decomposing",
  "awaiting_scope_approval",
  "collecting_sources",
  "awaiting_packet_approval",
  "extracting_evidence",
  "verifying_evidence",
  "synthesizing",
  "planning_experiment",
  "reviewing_experiment",
  "awaiting_objection_dispositions",
  "revising_experiment",
  "awaiting_final_approval",
  "approved",
  "rejected",
  "failed",
]);

export const HumanDecisionV01Schema = z
  .object({
    id: IdSchema,
    checkpoint: z.enum([
      "scope",
      "packet_freeze",
      "objection_dispositions",
      "final",
    ]),
    optionsShown: z.array(z.string().min(1)).min(1),
    decision: z.string().min(1),
    edits: StringListSchema,
    decidedAt: TimestampSchema,
    unresolvedObjections: StringListSchema,
  })
  .strict();

export const HumanDecisionSchema = HumanDecisionV01Schema.extend({
    declaredActor: DeclaredActorSchema.optional(),
    rationale: DecisionRationaleSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    const hasActor = decision.declaredActor !== undefined;
    const hasRationale = decision.rationale !== undefined;
    if (hasActor !== hasRationale) {
      context.addIssue({
        code: "custom",
        path: hasActor ? ["rationale"] : ["declaredActor"],
        message: "declared actor and rationale must be recorded together",
      });
    }
    if (decision.checkpoint !== "final" && (hasActor || hasRationale)) {
      context.addIssue({
        code: "custom",
        path: ["declaredActor"],
        message: "declared actor and rationale are reserved for final decisions",
      });
    }
  });

export const ResearchIntakeSchema = z
  .object({
    originalQuestion: z.string().min(1),
    intendedApplication: z.string().min(1),
    populationOrGeography: z.string().min(1),
    timeHorizon: z.string().min(1),
    availableMaterialsOrBudget: z.string().min(1),
    desiredDepth: z.string().min(1),
    constraints: StringListSchema,
    unansweredClarifications: StringListSchema,
  })
  .strict();

export const ClaimSchema = z
  .object({
    id: IdSchema,
    statement: z.string().min(1),
    operationalDefinition: z.string().min(1),
    category: z.string().min(1),
    parentClaimId: NullableIdSchema,
    scopeConstraints: StringListSchema,
    disposition: z.enum([
      "proposed",
      "approved",
      "edited",
      "removed",
      "added",
    ]),
    rationale: z.string().min(1),
  })
  .strict();

export const RightsDecisionSchema = z
  .object({
    mayStore: z.enum(["allowed", "denied", "unknown"]),
    mayDisplay: z.enum(["allowed", "denied", "unknown"]),
    maySendToModel: z.enum(["allowed", "denied", "unknown"]),
    basis: z.string().min(1),
    checkedAt: TimestampSchema,
  })
  .strict();

export const DoiResolutionSchema = z
  .object({
    syntax: z.enum(["valid", "invalid", "not_provided"]),
    resolution: z.enum(["resolved", "not_found", "unavailable", "not_checked"]),
    registrationAgency: NullableNonEmptyStringSchema,
    checkedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((verification, context) => {
    enforceCheckTimestamp(
      verification.resolution,
      "not_checked",
      verification.checkedAt,
      context,
    );
  });

export const BibliographicMetadataSchema = z
  .object({
    title: z.string().min(1),
    authors: z.array(z.string().min(1)),
    year: z.number().int().min(1000).max(9999).nullable(),
    venue: NullableNonEmptyStringSchema,
    studyType: NullableNonEmptyStringSchema,
  })
  .strict();

export const SourceAccessSchema = z
  .object({
    origin: z.enum(["user_import", "curated_fixture", "live_discovery"]),
    contentScope: z.enum([
      "metadata_only",
      "abstract",
      "user_excerpt",
      "full_text",
    ]),
    provider: z.string().min(1),
    version: NullableNonEmptyStringSchema,
    location: z.string().min(1),
    retrievedAt: TimestampSchema,
  })
  .strict();

export const MetadataFieldDiffSchema = z
  .object({
    field: z.string().min(1),
    expected: NullableNonEmptyStringSchema,
    observed: NullableNonEmptyStringSchema,
  })
  .strict();

export const MetadataVerificationSchema = z
  .object({
    status: z.enum(["match", "mismatch", "unavailable", "not_checked"]),
    method: z.string().min(1),
    checkedAt: TimestampSchema.nullable(),
    fieldDiffs: z.array(MetadataFieldDiffSchema),
  })
  .strict()
  .superRefine((verification, context) => {
    enforceCheckTimestamp(
      verification.status,
      "not_checked",
      verification.checkedAt,
      context,
    );
  });

export const IntegrityNoticeSchema = z
  .object({
    kind: z.enum(["retraction", "correction", "update", "other"]),
    noticeUrl: z.string().url(),
    affectsSource: z.boolean(),
    checkedAt: TimestampSchema,
  })
  .strict();

export const SourceRecordSchema = z
  .object({
    id: IdSchema,
    originalInput: z.string().min(1),
    canonicalDoi: NullableNonEmptyStringSchema,
    canonicalUrl: z.string().url().nullable(),
    doiResolution: DoiResolutionSchema,
    bibliographicMetadata: BibliographicMetadataSchema,
    access: SourceAccessSchema,
    rights: RightsDecisionSchema,
    contentHash: HashSchema,
    metadataVerification: MetadataVerificationSchema,
    integrityNotices: z.array(IntegrityNoticeSchema),
    mergedSourceIds: z.array(IdSchema),
    warnings: StringListSchema,
  })
  .strict();

export const SourceChunkSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    text: NonBlankTextSchema,
    location: z.string().min(1),
    contentHash: HashSchema,
    displayPermission: z.enum(["allowed", "denied", "unknown"]),
  })
  .strict();

const PacketFingerprintPayloadSchema = z
  .object({
    schemaVersion: ReadableContractVersionSchema,
    packetVersion: z.number().int().positive(),
    sourceHashes: z.array(HashSchema),
    chunkHashes: z.array(HashSchema),
    frozenAt: TimestampSchema,
    freezeDecision: HumanDecisionSchema,
  })
  .strict();

const PacketFingerprintPayloadV01Schema = z
  .object({
    schemaVersion: ReadableContractVersionV01Schema,
    packetVersion: z.number().int().positive(),
    sourceHashes: z.array(HashSchema),
    chunkHashes: z.array(HashSchema),
    frozenAt: TimestampSchema,
    freezeDecision: HumanDecisionV01Schema,
  })
  .strict();

type PacketFingerprintPayload = z.infer<typeof PacketFingerprintPayloadSchema>;

function packetFingerprint(payload: PacketFingerprintPayload): string {
  return canonicalSha256(payload);
}

function validatePacketFreeze(
  packet: z.output<typeof PacketFingerprintPayloadSchema> & {
    fingerprint: string;
  },
  context: z.RefinementCtx,
): void {
  if (!isSortedUnique(packet.sourceHashes)) {
    context.addIssue({
      code: "custom",
      path: ["sourceHashes"],
      message: "source hashes must be sorted and unique",
    });
  }
  if (!isSortedUnique(packet.chunkHashes)) {
    context.addIssue({
      code: "custom",
      path: ["chunkHashes"],
      message: "chunk hashes must be sorted and unique",
    });
  }
  if (
    packet.freezeDecision.checkpoint !== "packet_freeze" ||
    packet.freezeDecision.decision !== "approve"
  ) {
    context.addIssue({
      code: "custom",
      path: ["freezeDecision"],
      message: "packet freeze requires an approving packet-freeze decision",
    });
  }

  const {
    fingerprint,
    packetVersion,
    sourceHashes,
    chunkHashes,
    frozenAt,
    freezeDecision,
    schemaVersion,
  } = packet;
  const expected = packetFingerprint({
    schemaVersion,
    packetVersion,
    sourceHashes,
    chunkHashes,
    frozenAt,
    freezeDecision,
  });
  if (fingerprint !== expected) {
    context.addIssue({
      code: "custom",
      path: ["fingerprint"],
      message: "fingerprint does not match the canonical packet payload",
    });
  }
}

export const PacketFreezeSchema = PacketFingerprintPayloadSchema.extend({
  fingerprint: HashSchema,
})
  .strict()
  .superRefine(validatePacketFreeze);

export const PacketFreezeV01Schema = PacketFingerprintPayloadV01Schema.extend({
  fingerprint: HashSchema,
})
  .strict()
  .superRefine(validatePacketFreeze);

type FreezePacketInput = {
  packetVersion?: number;
  sourceHashes: string[];
  chunkHashes: string[];
  frozenAt: string;
  freezeDecision: z.input<typeof HumanDecisionSchema>;
};

function freezePacketAtVersion(
  input: FreezePacketInput,
  schemaVersion: z.input<typeof ReadableContractVersionSchema>,
): z.output<typeof PacketFreezeSchema> {
  const payload = PacketFingerprintPayloadSchema.parse({
    schemaVersion,
    packetVersion: input.packetVersion ?? 1,
    sourceHashes: [...input.sourceHashes].sort(),
    chunkHashes: [...input.chunkHashes].sort(),
    frozenAt: input.frozenAt,
    freezeDecision: input.freezeDecision,
  });

  return PacketFreezeSchema.parse({
    ...payload,
    fingerprint: packetFingerprint(payload),
  });
}

/** Preserved 0.1 packet writer for existing consumer lanes. */
export function freezePacket(
  input: FreezePacketInput,
): z.output<typeof PacketFreezeSchema> {
  return freezePacketAtVersion(input, PREVIOUS_CONTRACT_VERSION);
}

/** Current 0.2 packet writer; callers must perform a new human freeze. */
export function freezeCurrentPacket(
  input: FreezePacketInput,
): z.output<typeof PacketFreezeSchema> {
  return freezePacketAtVersion(input, CONTRACT_VERSION);
}

export const DeterministicVerificationSchema = z
  .object({
    method: z.string().min(1),
    status: z.enum(["verified", "failed", "unavailable", "not_checked"]),
    checkedAt: TimestampSchema.nullable(),
    details: z.string().min(1),
  })
  .strict()
  .superRefine((verification, context) => {
    enforceCheckTimestamp(
      verification.status,
      "not_checked",
      verification.checkedAt,
      context,
    );
  });

export const ModelAssessmentSchema = z
  .object({
    entailment: z.enum([
      "full_support",
      "partial_support",
      "contradicts",
      "insufficient",
      "unclear",
    ]),
    rationale: z.string().min(1),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    returnedModelId: NullableNonEmptyStringSchema,
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    executionId: IdSchema,
  })
  .strict();

export const EvidenceHumanReviewSchema = z
  .object({
    status: z.enum(["unreviewed", "confirmed", "overridden"]),
    reason: NullableNonEmptyStringSchema,
    reviewedAt: TimestampSchema.nullable(),
    reviewerId: NullableNonEmptyStringSchema,
  })
  .strict()
  .superRefine((review, context) => {
    const hasAllAuditMetadata =
      review.reason !== null &&
      review.reviewedAt !== null &&
      review.reviewerId !== null;
    const hasAnyAuditMetadata =
      review.reason !== null ||
      review.reviewedAt !== null ||
      review.reviewerId !== null;
    if (review.status === "unreviewed" && hasAnyAuditMetadata) {
      context.addIssue({
        code: "custom",
        message: "unreviewed evidence cannot carry completed review metadata",
      });
    }
    if (review.status !== "unreviewed" && !hasAllAuditMetadata) {
      context.addIssue({
        code: "custom",
        message: "completed evidence review requires reason, time, and reviewer",
      });
    }
  });

export const EvidenceCardSchema = z
  .object({
    id: IdSchema,
    subclaimId: IdSchema,
    sourceChunkId: IdSchema,
    excerpt: NonBlankTextSchema,
    extractedResult: z.string().min(1),
    settingAndSample: z.string().min(1),
    studyType: z.string().min(1),
    limitation: z.string().min(1),
    relationship: z.enum(["supports", "contradicts", "unresolved"]),
    deterministicVerification: DeterministicVerificationSchema,
    modelAssessment: ModelAssessmentSchema,
    conclusionStrengthWarning: NullableNonEmptyStringSchema,
    humanReview: EvidenceHumanReviewSchema,
    extractionIssues: StringListSchema,
  })
  .strict();

export const SubclaimConclusionSchema = z
  .object({
    subclaimId: IdSchema,
    strength: z.enum([
      "strong",
      "moderate",
      "weak",
      "conflicting",
      "insufficient",
    ]),
    conclusion: z.string().min(1),
    supportingEvidenceCardIds: z.array(IdSchema),
    contradictingEvidenceCardIds: z.array(IdSchema),
    disagreementSummary: NullableNonEmptyStringSchema,
    limitations: StringListSchema,
    changeEvidence: StringListSchema,
    overclaimingWarnings: StringListSchema,
    humanReviewStatus: z.enum(["unreviewed", "confirmed", "overridden"]),
  })
  .strict();

export const ResearchGapSchema = z
  .object({
    id: IdSchema,
    affectedSubclaimIds: z.array(IdSchema).min(1),
    type: z.enum([
      "insufficient_data",
      "conflicting_methodology",
      "missing_population",
      "short_duration",
      "absent_control",
      "scale_up_uncertainty",
      "measurement_inconsistency",
      "other",
    ]),
    impactRationale: z.string().min(1),
    tractabilityRationale: z.string().min(1),
    evidenceCardIds: z.array(IdSchema),
    rank: z.number().int().positive(),
    selection: z.enum(["unselected", "selected", "rejected"]),
  })
  .strict();

export const AllocationPlanSchema = z
  .object({
    randomization: z.string().min(1),
    blocking: z.string().min(1),
    blinding: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

export const ExpectedOutcomeBranchSchema = z
  .object({
    outcome: z.string().min(1),
    establishes: z.string().min(1),
    doesNotEstablish: z.string().min(1),
  })
  .strict();

export const ExperimentProtocolSchema = z
  .object({
    selectedGapId: IdSchema,
    objective: z.string().min(1),
    designType: z.string().min(1),
    hypothesis: z.string().min(1),
    nullHypothesis: z.string().min(1),
    experimentalOrObservationalUnit: z.string().min(1),
    unitOfAnalysis: z.string().min(1),
    interventionOrExposure: z.string().min(1),
    comparator: z.string().min(1),
    independentVariables: StringListSchema,
    dependentVariables: StringListSchema,
    primaryOutcomes: z.array(z.string().min(1)).min(1),
    secondaryOutcomes: StringListSchema,
    controls: StringListSchema,
    comparisonGroups: StringListSchema,
    measurementValidity: z.string().min(1),
    allocation: AllocationPlanSchema,
    replicationPlan: z.string().min(1),
    repeatedMeasurementPlan: z.string().min(1),
    inclusionCriteria: StringListSchema,
    exclusionCriteria: StringListSchema,
    attritionPlan: z.string().min(1),
    missingDataPlan: z.string().min(1),
    procedure: z.array(z.string().min(1)).min(1),
    sampleSizeBasis: z.string().min(1),
    missingPowerAssumptions: StringListSchema,
    estimand: z.string().min(1),
    metrics: z.array(z.string().min(1)).min(1),
    analysisPlan: z.string().min(1),
    assumptionChecks: StringListSchema,
    confounders: StringListSchema,
    mitigations: StringListSchema,
    feasibility: z.string().min(1),
    requiredResources: StringListSchema,
    constraints: StringListSchema,
    hazards: StringListSchema,
    ethics: StringListSchema,
    qualifiedReviewRequired: z.boolean(),
    stoppingCriteria: StringListSchema,
    failureCriteria: StringListSchema,
    expectedOutcomeBranches: z.array(ExpectedOutcomeBranchSchema).min(1),
    externalValidityBoundary: z.string().min(1),
    supportingEvidenceCardIds: z.array(IdSchema),
  })
  .strict();

export const ExperimentAbstentionSchema = z
  .object({
    id: IdSchema,
    reason: z.string().min(1),
    safetyCategories: z
      .array(
        z.enum([
          "medical",
          "hazardous",
          "missing_qualified_review",
          "missing_required_evidence",
          "other",
        ]),
      )
      .min(1),
    qualifiedReviewRequired: z.literal(true),
    missingInputs: z.array(z.string().min(1)),
    allowedNextStep: z.string().min(1),
  })
  .strict();

export const ExperimentObjectionSchema = z
  .object({
    id: IdSchema,
    category: z.enum([
      "confound",
      "circular_reasoning",
      "equipment_feasibility",
      "metrics",
      "unsupported_assumption",
      "ethics_safety",
      "inferential_overreach",
    ]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    targetField: z.string().min(1),
    rationale: z.string().min(1),
    evidenceCardIds: z.array(IdSchema),
  })
  .strict();

export const ExperimentReviewSchema = z
  .object({
    protocolVersion: z.string().min(1),
    reviewerExecutionId: IdSchema,
    objections: z.array(ExperimentObjectionSchema),
  })
  .strict();

export const ObjectionDecisionSchema = z
  .object({
    objectionId: IdSchema,
    disposition: z.enum(["accepted", "rejected", "unresolved"]),
    basis: z.string().min(1),
    originalValue: z.string(),
    revisedValue: z.string().nullable(),
    residualRisk: z.string().min(1),
  })
  .strict();

export const ExperimentRevisionSchema = z
  .object({
    protocolVersion: z.string().min(1),
    decisions: z.array(ObjectionDecisionSchema),
  })
  .strict();

export const GenerationSettingsSchema = z
  .object({
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().positive(),
    topP: z.number().min(0).max(1).nullable(),
    seed: z.number().int().nullable(),
    reasoningMode: z.enum(["disabled", "enabled", "provider_default"]),
    reasoningBudgetTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const ProviderTimingSchema = z
  .object({
    queueMs: z.number().nonnegative().nullable(),
    promptMs: z.number().nonnegative().nullable(),
    completionMs: z.number().nonnegative().nullable(),
    totalMs: z.number().nonnegative().nullable(),
  })
  .strict();

export const RequestIdentifiersSchema = z
  .object({
    clientRequestId: IdSchema,
    providerRequestId: NullableNonEmptyStringSchema,
    responseId: NullableNonEmptyStringSchema,
  })
  .strict();

export const RefusalSchema = z
  .object({
    refused: z.boolean(),
    reason: NullableNonEmptyStringSchema,
  })
  .strict()
  .superRefine((refusal, context) => {
    if (refusal.refused && refusal.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "a refusal reason is required when refused is true",
      });
    }
    if (!refusal.refused && refusal.reason !== null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "a non-refusal cannot carry a refusal reason",
      });
    }
  });

export const ProviderUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const PricingSnapshotSchema = z
  .object({
    currency: z.string().length(3),
    inputPerMillionTokens: z.number().nonnegative().nullable(),
    outputPerMillionTokens: z.number().nonnegative().nullable(),
    estimatedCost: z.number().nonnegative().nullable(),
    snapshotDate: z.string().date().nullable(),
  })
  .strict()
  .superRefine((pricing, context) => {
    if (
      pricing.estimatedCost !== null &&
      (pricing.snapshotDate === null ||
        pricing.inputPerMillionTokens === null ||
        pricing.outputPerMillionTokens === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "estimated cost requires pricing rates and a pricing snapshot date",
      });
    }
  });

export const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    issues: StringListSchema,
  })
  .strict();

export const NodeExecutionSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    attempt: z.number().int().positive(),
    status: z.enum([
      "started",
      "succeeded",
      "failed",
      "refused",
      "timed_out",
    ]),
    evidenceMode: EvidenceModeSchema,
    inputRefs: z.array(IdSchema),
    outputRefs: z.array(IdSchema),
    requestedProvider: z.string().min(1),
    returnedProvider: NullableNonEmptyStringSchema,
    requestedModelId: z.string().min(1),
    returnedModelId: NullableNonEmptyStringSchema,
    requestedDeveloperFamily: z.string().min(1),
    returnedDeveloperFamily: NullableNonEmptyStringSchema,
    requestedBaseFamily: z.string().min(1),
    returnedBaseFamily: NullableNonEmptyStringSchema,
    returnedReasoningMode: z
      .enum(["disabled", "enabled", "provider_default", "unknown"])
      .nullable(),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    // Legacy pre-freeze candidate executions may omit this field. Every
    // execution created by the current request boundary supplies it.
    promptHash: HashSchema.optional(),
    structuredOutputSchemaVersion: z.string().min(1),
    generationSettings: GenerationSettingsSchema,
    startedAt: TimestampSchema,
    endedAt: TimestampSchema.nullable(),
    clientLatencyMs: z.number().nonnegative().nullable(),
    providerTiming: ProviderTimingSchema,
    requestIds: RequestIdentifiersSchema,
    finishReason: NullableNonEmptyStringSchema,
    refusal: RefusalSchema,
    usage: ProviderUsageSchema,
    pricing: PricingSnapshotSchema,
    validation: ValidationResultSchema,
    errorIds: z.array(IdSchema),
    retryOfExecutionId: NullableIdSchema,
    fallbackFromExecutionId: NullableIdSchema,
    codeVersion: NullableNonEmptyStringSchema,
  })
  .strict();

export const RunErrorSchema = z
  .object({
    id: IdSchema,
    kind: z.enum([
      "invalid_input",
      "validation_failure",
      "invalid_model_json",
      "invalid_model_output",
      "provider_failure",
      "provider_refusal",
      "policy_refusal",
      "timeout",
      "missing_human_decision",
      "missing_source",
      "missing_passage",
      "missing_evidence",
      "rights_denied",
      "invalid_transition",
      "invariant_violation",
    ]),
    message: z.string().min(1),
    nodeId: IdSchema,
    executionId: NullableIdSchema,
    retryable: z.boolean(),
    occurredAt: TimestampSchema,
    details: z
      .object({
        field: NullableNonEmptyStringSchema,
        providerCode: NullableNonEmptyStringSchema,
        httpStatus: z.number().int().min(100).max(599).nullable(),
      })
      .strict(),
  })
  .strict();

export const ResearchRunSchema = z
  .object({
    schemaVersion: ReadableContractVersionSchema,
    id: IdSchema,
    status: RunStatusSchema,
    evidenceMode: EvidenceModeSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    intake: ResearchIntakeSchema,
    claims: z.array(ClaimSchema),
    scopeDecision: HumanDecisionSchema.nullable(),
    packet: PacketFreezeSchema.nullable(),
    sources: z.array(SourceRecordSchema),
    chunks: z.array(SourceChunkSchema),
    evidenceCards: z.array(EvidenceCardSchema),
    conclusions: z.array(SubclaimConclusionSchema),
    researchGaps: z.array(ResearchGapSchema),
    selectedGapId: NullableIdSchema,
    experiment: ExperimentProtocolSchema.nullable(),
    experimentAbstention: ExperimentAbstentionSchema.nullable().optional(),
    review: ExperimentReviewSchema.nullable(),
    objectionDispositionDecision: HumanDecisionSchema.nullable(),
    revision: ExperimentRevisionSchema.nullable(),
    finalDecision: HumanDecisionSchema.nullable(),
    executions: z.array(NodeExecutionSchema),
    errors: z.array(RunErrorSchema),
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.packet !== null &&
      run.packet.schemaVersion !== run.schemaVersion
    ) {
      context.addIssue({
        code: "custom",
        path: ["packet", "schemaVersion"],
        message: "packet schema version must match its research run",
      });
    }
    if (run.experiment !== null && run.experimentAbstention != null) {
      context.addIssue({
        code: "custom",
        path: ["experimentAbstention"],
        message:
          "a research run cannot contain both an experiment and an experiment abstention",
      });
    }
    if (run.schemaVersion !== LEGACY_CONTRACT_VERSION) {
      if (!Object.hasOwn(run, "experimentAbstention")) {
        context.addIssue({
          code: "custom",
          path: ["experimentAbstention"],
          message:
            "current research runs must explicitly record experimentAbstention, using null when absent",
        });
      }
      run.executions.forEach((execution, index) => {
        if (execution.promptHash === undefined) {
          context.addIssue({
            code: "custom",
            path: ["executions", index, "promptHash"],
            message:
              "current model executions must record the canonical prompt hash",
          });
        }
      });
    }
    if (
      run.schemaVersion === CONTRACT_VERSION &&
      run.finalDecision !== null &&
      (run.finalDecision.declaredActor === undefined ||
        run.finalDecision.rationale === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalDecision"],
        message:
          "current final decisions require declared actor and rationale provenance",
      });
    }
    for (const [field, expectedCheckpoint] of [
      ["scopeDecision", "scope"],
      ["objectionDispositionDecision", "objection_dispositions"],
      ["finalDecision", "final"],
    ] as const) {
      const decision = run[field];
      if (decision !== null && decision.checkpoint !== expectedCheckpoint) {
        context.addIssue({
          code: "custom",
          path: [field, "checkpoint"],
          message: `${field} must use the ${expectedCheckpoint} checkpoint`,
        });
      }
    }
  });

export const LegacyResearchRunV00Schema = ResearchRunSchema.refine(
  (run) => run.schemaVersion === LEGACY_CONTRACT_VERSION,
  {
    path: ["schemaVersion"],
    message: "legacy reader accepts only schema version 0.0",
  },
);

export function parseLegacyResearchRunV00(input: unknown) {
  return LegacyResearchRunV00Schema.parse(input);
}

export const PreviousResearchRunV01Schema = ResearchRunSchema.refine(
  (run) => run.schemaVersion === PREVIOUS_CONTRACT_VERSION,
  {
    path: ["schemaVersion"],
    message: "previous reader accepts only schema version 0.1",
  },
);

export function parsePreviousResearchRunV01(input: unknown) {
  return PreviousResearchRunV01Schema.parse(input);
}

export const CurrentResearchRunSchema = ResearchRunSchema.refine(
  (run) =>
    run.schemaVersion === PREVIOUS_CONTRACT_VERSION ||
    run.schemaVersion === CONTRACT_VERSION,
  {
    path: ["schemaVersion"],
    message: `current reader accepts schema versions ${PREVIOUS_CONTRACT_VERSION} and ${CONTRACT_VERSION}`,
  },
);

export const CurrentWriterResearchRunSchema = ResearchRunSchema.refine(
  (run) => run.schemaVersion === CONTRACT_VERSION,
  {
    path: ["schemaVersion"],
    message: `current writer requires schema version ${CONTRACT_VERSION}`,
  },
);

export type ResearchRun = z.infer<typeof ResearchRunSchema>;
export type NodeExecution = z.infer<typeof NodeExecutionSchema>;
export type PacketFreeze = z.infer<typeof PacketFreezeSchema>;
