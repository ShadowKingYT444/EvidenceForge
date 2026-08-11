import { z } from "zod";

import { canonicalSha256, canonicalizeJson } from "../../src/contracts";
import {
  GOLDEN_FIXTURE_SHA256,
  GOLDEN_PACKET_FINGERPRINT,
} from "../../src/fixtures/golden-run-v0.1";
import { promptRegistry } from "../../src/server/prompts/registry";

export const BENCHMARK_PROTOCOL_VERSION = "1.0.0" as const;

function ownAndDeepFreeze<T>(input: T): T {
  if (Array.isArray(input)) {
    return Object.freeze(
      input.map((value) => ownAndDeepFreeze(value)),
    ) as unknown as T;
  }
  if (typeof input === "object" && input !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, value]) => [
          key,
          ownAndDeepFreeze(value),
        ]),
      ),
    ) as T;
  }
  return input;
}

export const ELIGIBLE_BENCHMARK_DOMAINS = Object.freeze([
  "environmental_sustainability",
  "materials_engineering",
  "software_reliability",
] as const);

const BENCHMARK_CONDITION_SOURCE = [
  {
    id: "strong_baseline",
    label: "Strong single-prompt baseline",
    comprehensiveCallCount: 1,
    workflowStages: false,
    deterministicVerificationContributions: true,
    entailmentStrengthVerificationContributions: true,
    adversarialReview: false,
    revisionAfterReview: false,
  },
  {
    id: "complete_workflow",
    label: "Complete workflow",
    comprehensiveCallCount: null,
    workflowStages: true,
    deterministicVerificationContributions: true,
    entailmentStrengthVerificationContributions: true,
    adversarialReview: true,
    revisionAfterReview: true,
  },
  {
    id: "no_verification",
    label: "No-verification ablation",
    comprehensiveCallCount: null,
    workflowStages: true,
    deterministicVerificationContributions: false,
    entailmentStrengthVerificationContributions: false,
    adversarialReview: true,
    revisionAfterReview: true,
  },
  {
    id: "no_adversarial_review",
    label: "No-adversarial-review ablation",
    comprehensiveCallCount: null,
    workflowStages: true,
    deterministicVerificationContributions: true,
    entailmentStrengthVerificationContributions: true,
    adversarialReview: false,
    revisionAfterReview: false,
  },
] as const;

const TRUSTED_BENCHMARK_CONDITIONS = ownAndDeepFreeze(
  BENCHMARK_CONDITION_SOURCE,
);

export const REQUIRED_BENCHMARK_CONDITIONS = ownAndDeepFreeze(
  TRUSTED_BENCHMARK_CONDITIONS,
);

export const CONDITION_MATRIX_HASH = canonicalSha256(
  TRUSTED_BENCHMARK_CONDITIONS,
);

export const BENCHMARK_PROTOCOL_SCHEMA_HASH = canonicalSha256({
  protocolVersion: BENCHMARK_PROTOCOL_VERSION,
  eligibleDomains: ELIGIBLE_BENCHMARK_DOMAINS,
  requiredConditions: TRUSTED_BENCHMARK_CONDITIONS,
  caseRoles: ["development", "heldout"],
  headlineEvidenceMode: "live",
  trialCount: 3,
  trialSelectionPolicy: "report_all_no_best_of",
  seedPolicy:
    "three_distinct_frozen_integers_when_supported_otherwise_three_nulls",
  denominatorPolicy: "retain_failures_report_pre_run_exclusions",
  allowedExclusionReasons: [
    "safety_gate_blocked",
    "rights_gate_blocked",
    "provider_unavailable_before_attempt",
    "configuration_invalid_before_attempt",
  ],
  fallbackSemantics: "any_observed_fallback_invalidates_pairing",
});

const frozenPromptManifest = Object.freeze(
  promptRegistry
    .list()
    .map(({ id, version, hash }) => Object.freeze({ id, version, hash }))
    .sort((left, right) => left.id.localeCompare(right.id)),
);

export const FROZEN_CONSUMER_EDGE = Object.freeze({
  contractVersion: "0.1",
  packetFingerprint: GOLDEN_PACKET_FINGERPRINT,
  goldenFixtureHash: GOLDEN_FIXTURE_SHA256,
  promptManifest: frozenPromptManifest,
  promptManifestHash: canonicalSha256(frozenPromptManifest),
});

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const EvidenceModeSchema = z.enum([
  "live",
  "fixture",
  "mocked",
  "simulated",
  "unverified",
]);
const BenchmarkConditionIdSchema = z.enum([
  "strong_baseline",
  "complete_workflow",
  "no_verification",
  "no_adversarial_review",
]);

function isSortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

const SortedHashSetSchema = z
  .array(HashSchema)
  .min(1)
  .refine(isSortedUnique, "hashes must be sorted and unique");

const ResolvedScopeSchema = z
  .object({
    question: z.string().min(1),
    constraints: z.array(z.string().min(1)).min(1),
  })
  .strict();

const PacketReferenceSchema = z
  .object({
    fingerprint: HashSchema,
    sourceHashes: SortedHashSetSchema,
    chunkHashes: SortedHashSetSchema,
  })
  .strict();

const MetadataSnapshotSchema = z
  .object({
    id: IdSchema,
    hash: HashSchema,
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const ExpectedFailureLabelSchema = z.string().min(1);

const BenchmarkCaseInputSchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    role: z.enum(["development", "heldout"]),
    domain: z.enum(ELIGIBLE_BENCHMARK_DOMAINS),
    originalQuestion: z.string().min(1),
    resolvedScope: ResolvedScopeSchema,
    packet: PacketReferenceSchema,
    metadataSnapshot: MetadataSnapshotSchema,
    expectedFailureLabels: z
      .array(ExpectedFailureLabelSchema)
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        "expected failure labels must be unique",
      )
      .optional(),
    safety: z
      .object({
        nonMedical: z.literal(true),
        nonHazardous: z.literal(true),
        notes: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    graderInstructions: z.string().min(1).optional(),
  })
  .strict();

function caseHashPayload(
  benchmarkCase: z.infer<typeof BenchmarkCaseInputSchema> & {
    resolvedScopeHash: string;
  },
) {
  return {
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    ...benchmarkCase,
  };
}

export const BenchmarkCaseSchema = BenchmarkCaseInputSchema.extend({
  resolvedScopeHash: HashSchema,
  caseHash: HashSchema,
})
  .strict()
  .superRefine((benchmarkCase, context) => {
    const hasPrivateScoringFields =
      benchmarkCase.expectedFailureLabels !== undefined ||
      benchmarkCase.graderInstructions !== undefined;
    if (
      benchmarkCase.role === "development" &&
      (benchmarkCase.expectedFailureLabels === undefined ||
        benchmarkCase.graderInstructions === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "development cases require scoring fields",
      });
    }
    if (benchmarkCase.role === "heldout" && hasPrivateScoringFields) {
      context.addIssue({
        code: "custom",
        message: "held-out scoring fields require a private scoring pack",
      });
    }
    if (
      benchmarkCase.resolvedScopeHash !==
      canonicalSha256(benchmarkCase.resolvedScope)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolvedScopeHash"],
        message: "resolvedScopeHash does not match the canonical scope",
      });
    }
    const { caseHash, ...withoutCaseHash } = benchmarkCase;
    if (caseHash !== canonicalSha256(caseHashPayload(withoutCaseHash))) {
      context.addIssue({
        code: "custom",
        path: ["caseHash"],
        message: "caseHash does not match the frozen case definition",
      });
    }
  });

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export function createBenchmarkCase(input: unknown): BenchmarkCase {
  const candidate = structuredClone(
    (input ?? {}) as Record<string, unknown>,
  );
  delete candidate.caseHash;
  delete candidate.resolvedScopeHash;
  const parsed = BenchmarkCaseInputSchema.parse(candidate);
  const withScopeHash = {
    ...parsed,
    resolvedScopeHash: canonicalSha256(parsed.resolvedScope),
  };
  return BenchmarkCaseSchema.parse({
    ...withScopeHash,
    caseHash: canonicalSha256(caseHashPayload(withScopeHash)),
  });
}

const ModelIdentitySchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    developerFamily: z.string().min(1),
    baseFamily: z.string().min(1),
  })
  .strict();

const GenerationConfigSchema = z
  .object({
    maxOutputTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    topP: z.number().positive().max(1),
    responseFormat: z.literal("json_schema"),
    seedPolicy: z.enum(["supported", "unsupported"]),
  })
  .strict();

const OutputContractSchema = z
  .object({
    schemaId: IdSchema,
    schemaVersion: SemverSchema,
    schemaHash: HashSchema,
    requiredFieldsHash: HashSchema,
    safetyConstraintsHash: HashSchema,
  })
  .strict();

const PromptDescriptorSchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    hash: HashSchema,
  })
  .strict();

const PromptManifestSchema = z
  .array(PromptDescriptorSchema)
  .min(1)
  .refine(
    (resources) =>
      new Set(resources.map(({ id }) => id)).size === resources.length,
    "prompt IDs must be unique",
  )
  .refine(
    (resources) =>
      resources.every(
        ({ id }, index) => index === 0 || resources[index - 1]!.id < id,
      ),
    "prompt manifest must be sorted by ID",
  );

const RetryPolicySchema = z
  .object({
    maximumAttempts: z.union([z.literal(1), z.literal(2)]),
    repairInvalidOutput: z.boolean(),
    retryableFailureKinds: z
      .array(
        z.enum([
          "provider_transport",
          "provider_timeout",
          "invalid_structured_output",
        ]),
      )
      .refine(
        (values) => new Set(values).size === values.length,
        "retryable failure kinds must be unique",
      ),
  })
  .strict();

const FallbackPolicySchema = z
  .object({
    mode: z.enum(["forbidden", "explicit_invalidating"]),
    configuredModel: ModelIdentitySchema.nullable(),
  })
  .strict()
  .superRefine((fallback, context) => {
    if (
      (fallback.mode === "forbidden" && fallback.configuredModel !== null) ||
      (fallback.mode === "explicit_invalidating" &&
        fallback.configuredModel === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuredModel"],
        message:
          "forbidden fallback requires null; explicit fallback requires a recorded model",
      });
    }
  });

const TrialPlanSchema = z
  .object({
    count: z.literal(3),
    trialIds: z.tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
    ]),
    trialSeeds: z.tuple([
      z.number().int().nullable(),
      z.number().int().nullable(),
      z.number().int().nullable(),
    ]),
    selectionPolicy: z.literal("report_all_no_best_of"),
  })
  .strict()
  .refine(
    ({ trialIds }) => new Set(trialIds).size === trialIds.length,
    "trial IDs must be unique",
  );

export const ExclusionReasonSchema = z.enum([
  "safety_gate_blocked",
  "rights_gate_blocked",
  "provider_unavailable_before_attempt",
  "configuration_invalid_before_attempt",
]);

export const ALLOWED_EXCLUSION_REASONS = Object.freeze([
  "safety_gate_blocked",
  "rights_gate_blocked",
  "provider_unavailable_before_attempt",
  "configuration_invalid_before_attempt",
] as const);

const ExclusionPolicySchema = z
  .object({
    allowedReasons: z
      .array(ExclusionReasonSchema)
      .refine(
        (values) => new Set(values).size === values.length,
        "allowed exclusion reasons must be unique",
      ),
    denominatorPolicy: z.literal(
      "retain_failures_report_pre_run_exclusions",
    ),
  })
  .strict();

const BenchmarkConfigInputSchema = z
  .object({
    id: IdSchema,
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    case: BenchmarkCaseSchema,
    conditionId: BenchmarkConditionIdSchema,
    primaryModel: ModelIdentitySchema,
    adversarialReviewerModel: ModelIdentitySchema,
    generation: GenerationConfigSchema,
    outputContract: OutputContractSchema,
    promptManifest: PromptManifestSchema,
    benchmarkCodeVersion: GitShaSchema,
    retryPolicy: RetryPolicySchema,
    fallbackPolicy: FallbackPolicySchema,
    trialPlan: TrialPlanSchema,
    exclusionPolicy: ExclusionPolicySchema,
    evidenceMode: EvidenceModeSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.primaryModel.baseFamily ===
      config.adversarialReviewerModel.baseFamily
    ) {
      context.addIssue({
        code: "custom",
        path: ["adversarialReviewerModel", "baseFamily"],
        message:
          "the frozen adversarial reviewer must use a different base family",
      });
    }
    const seeds = config.trialPlan.trialSeeds;
    if (
      (config.generation.seedPolicy === "supported" &&
        (seeds.some((seed) => seed === null) ||
          new Set(seeds).size !== seeds.length)) ||
      (config.generation.seedPolicy === "unsupported" &&
        seeds.some((seed) => seed !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["trialPlan", "trialSeeds"],
        message:
          "supported seeds require three distinct integers; unsupported seeds require three nulls",
      });
    }
  });

type BenchmarkConfigInput = z.infer<typeof BenchmarkConfigInputSchema>;

function pairingPayload(config: BenchmarkConfigInput, promptManifestHash: string) {
  return {
    protocolVersion: config.protocolVersion,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    caseId: config.case.id,
    caseVersion: config.case.version,
    caseHash: config.case.caseHash,
    caseRole: config.case.role,
    domain: config.case.domain,
    resolvedScopeHash: config.case.resolvedScopeHash,
    packetFingerprint: config.case.packet.fingerprint,
    sourceHashes: config.case.packet.sourceHashes,
    chunkHashes: config.case.packet.chunkHashes,
    metadataSnapshotId: config.case.metadataSnapshot.id,
    metadataSnapshotHash: config.case.metadataSnapshot.hash,
    primaryModel: config.primaryModel,
    adversarialReviewerModel: config.adversarialReviewerModel,
    generation: config.generation,
    outputContract: config.outputContract,
    promptManifestHash,
    benchmarkCodeVersion: config.benchmarkCodeVersion,
    retryPolicy: config.retryPolicy,
    fallbackPolicy: config.fallbackPolicy,
    trialPlan: config.trialPlan,
    exclusionPolicy: config.exclusionPolicy,
    evidenceMode: config.evidenceMode,
  };
}

function configHashPayload(
  config: BenchmarkConfigInput,
  computed: {
    promptManifestHash: string;
    pairingHash: string;
  },
) {
  const condition = TRUSTED_BENCHMARK_CONDITIONS.find(
    ({ id }) => id === config.conditionId,
  )!;
  return {
    ...pairingPayload(config, computed.promptManifestHash),
    conditionId: config.conditionId,
    conditionSpecHash: canonicalSha256(condition),
    configId: config.id,
    pairingHash: computed.pairingHash,
  };
}

export const BenchmarkConfigSchema = BenchmarkConfigInputSchema.extend({
  protocolSchemaHash: HashSchema,
  conditionMatrixHash: HashSchema,
  promptManifestHash: HashSchema,
  pairingHash: HashSchema,
  configHash: HashSchema,
})
  .strict()
  .superRefine((config, context) => {
    const promptManifestHash = canonicalSha256(config.promptManifest);
    if (config.protocolSchemaHash !== BENCHMARK_PROTOCOL_SCHEMA_HASH) {
      context.addIssue({
        code: "custom",
        path: ["protocolSchemaHash"],
        message: "protocolSchemaHash does not match benchmark protocol v1",
      });
    }
    if (config.conditionMatrixHash !== CONDITION_MATRIX_HASH) {
      context.addIssue({
        code: "custom",
        path: ["conditionMatrixHash"],
        message: "conditionMatrixHash does not match protocol v1",
      });
    }
    if (config.promptManifestHash !== promptManifestHash) {
      context.addIssue({
        code: "custom",
        path: ["promptManifestHash"],
        message: "promptManifestHash does not match the frozen prompt manifest",
      });
    }
    const pairingHash = canonicalSha256(pairingPayload(config, promptManifestHash));
    if (config.pairingHash !== pairingHash) {
      context.addIssue({
        code: "custom",
        path: ["pairingHash"],
        message: "pairingHash does not match comparison-critical configuration",
      });
    }
    const configHash = canonicalSha256(
      configHashPayload(config, { promptManifestHash, pairingHash }),
    );
    if (config.configHash !== configHash) {
      context.addIssue({
        code: "custom",
        path: ["configHash"],
        message: "configHash does not match the full condition configuration",
      });
    }
  });

export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export function createBenchmarkConfig(input: unknown): BenchmarkConfig {
  const candidate = structuredClone(
    (input ?? {}) as Record<string, unknown>,
  );
  delete candidate.protocolSchemaHash;
  delete candidate.conditionMatrixHash;
  delete candidate.promptManifestHash;
  delete candidate.pairingHash;
  delete candidate.configHash;
  const unsorted = candidate.promptManifest;
  if (Array.isArray(unsorted)) {
    candidate.promptManifest = structuredClone(unsorted).sort((left, right) => {
      const leftId =
        typeof left === "object" && left !== null && "id" in left
          ? String(left.id)
          : "";
      const rightId =
        typeof right === "object" && right !== null && "id" in right
          ? String(right.id)
          : "";
      return leftId.localeCompare(rightId);
    });
  }
  const parsed = BenchmarkConfigInputSchema.parse(candidate);
  const promptManifestHash = canonicalSha256(parsed.promptManifest);
  const pairingHash = canonicalSha256(
    pairingPayload(parsed, promptManifestHash),
  );
  return BenchmarkConfigSchema.parse({
    ...parsed,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash,
    pairingHash,
    configHash: canonicalSha256(
      configHashPayload(parsed, { promptManifestHash, pairingHash }),
    ),
  });
}

export const COMPARISON_INVALIDATION_REASONS = Object.freeze([
  "same_condition_not_a_comparison",
  "protocol_version_changed",
  "protocol_schema_changed",
  "condition_matrix_changed",
  "case_identity_changed",
  "case_role_changed",
  "case_definition_changed",
  "domain_changed",
  "resolved_scope_changed",
  "source_packet_changed",
  "source_membership_changed",
  "metadata_snapshot_changed",
  "primary_model_changed",
  "reviewer_model_changed",
  "generation_config_changed",
  "output_contract_changed",
  "prompt_manifest_changed",
  "benchmark_code_changed",
  "retry_policy_changed",
  "fallback_policy_changed",
  "trial_plan_changed",
  "exclusion_policy_changed",
  "evidence_mode_changed",
  "development_case_not_headline_eligible",
  "non_live_evidence_not_headline_eligible",
  "trial_config_mismatch",
  "trial_identity_changed",
  "actual_model_changed",
  "fallback_observed",
  "pre_run_exclusion_present",
] as const);

export type ComparisonInvalidationReason =
  (typeof COMPARISON_INVALIDATION_REASONS)[number];

function differs(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) !== canonicalizeJson(right);
}

export function assessComparisonPair(input: {
  left: BenchmarkConfig;
  right: BenchmarkConfig;
  reportingUse: "development" | "headline";
}): {
  valid: boolean;
  invalidationReasons: ComparisonInvalidationReason[];
  leftConfigHash: string;
  rightConfigHash: string;
  pairingHash: string | null;
} {
  const left = BenchmarkConfigSchema.parse(structuredClone(input.left));
  const right = BenchmarkConfigSchema.parse(structuredClone(input.right));
  const reasons: ComparisonInvalidationReason[] = [];
  const add = (reason: ComparisonInvalidationReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (left.conditionId === right.conditionId)
    add("same_condition_not_a_comparison");
  if (left.protocolVersion !== right.protocolVersion)
    add("protocol_version_changed");
  if (left.protocolSchemaHash !== right.protocolSchemaHash)
    add("protocol_schema_changed");
  if (left.conditionMatrixHash !== right.conditionMatrixHash)
    add("condition_matrix_changed");
  if (left.case.id !== right.case.id || left.case.version !== right.case.version)
    add("case_identity_changed");
  if (left.case.role !== right.case.role) add("case_role_changed");
  if (left.case.caseHash !== right.case.caseHash)
    add("case_definition_changed");
  if (left.case.domain !== right.case.domain) add("domain_changed");
  if (left.case.resolvedScopeHash !== right.case.resolvedScopeHash)
    add("resolved_scope_changed");
  if (left.case.packet.fingerprint !== right.case.packet.fingerprint)
    add("source_packet_changed");
  if (
    differs(left.case.packet.sourceHashes, right.case.packet.sourceHashes) ||
    differs(left.case.packet.chunkHashes, right.case.packet.chunkHashes)
  )
    add("source_membership_changed");
  if (
    left.case.metadataSnapshot.id !== right.case.metadataSnapshot.id ||
    left.case.metadataSnapshot.hash !== right.case.metadataSnapshot.hash
  )
    add("metadata_snapshot_changed");
  if (differs(left.primaryModel, right.primaryModel))
    add("primary_model_changed");
  if (differs(left.adversarialReviewerModel, right.adversarialReviewerModel))
    add("reviewer_model_changed");
  if (differs(left.generation, right.generation))
    add("generation_config_changed");
  if (differs(left.outputContract, right.outputContract))
    add("output_contract_changed");
  if (left.promptManifestHash !== right.promptManifestHash)
    add("prompt_manifest_changed");
  if (left.benchmarkCodeVersion !== right.benchmarkCodeVersion)
    add("benchmark_code_changed");
  if (differs(left.retryPolicy, right.retryPolicy))
    add("retry_policy_changed");
  if (differs(left.fallbackPolicy, right.fallbackPolicy))
    add("fallback_policy_changed");
  if (differs(left.trialPlan, right.trialPlan))
    add("trial_plan_changed");
  if (differs(left.exclusionPolicy, right.exclusionPolicy))
    add("exclusion_policy_changed");
  if (left.evidenceMode !== right.evidenceMode) add("evidence_mode_changed");
  if (input.reportingUse === "headline") {
    if (left.case.role !== "heldout" || right.case.role !== "heldout")
      add("development_case_not_headline_eligible");
    if (left.evidenceMode !== "live" || right.evidenceMode !== "live")
      add("non_live_evidence_not_headline_eligible");
  }

  return {
    valid: reasons.length === 0,
    invalidationReasons: reasons,
    leftConfigHash: left.configHash,
    rightConfigHash: right.configHash,
    pairingHash: reasons.length === 0 ? left.pairingHash : null,
  };
}

export const TrialRecordSchema = z
  .object({
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    configHash: HashSchema,
    caseId: IdSchema,
    conditionId: BenchmarkConditionIdSchema,
    trialId: z.string().min(1),
    evidenceMode: EvidenceModeSchema,
    seed: z.number().int().nullable(),
    attempted: z.boolean(),
    fallbackUsed: z.boolean(),
    actualPrimaryModel: ModelIdentitySchema,
    fallbackModel: ModelIdentitySchema.nullable(),
    excluded: z.boolean(),
    exclusionReason: ExclusionReasonSchema.nullable(),
  })
  .strict()
  .superRefine((trial, context) => {
    if (trial.fallbackUsed !== (trial.fallbackModel !== null)) {
      context.addIssue({
        code: "custom",
        path: ["fallbackModel"],
        message: "fallback use and fallback model must be recorded together",
      });
    }
    if (trial.excluded !== (trial.exclusionReason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["exclusionReason"],
        message: "exclusions require exactly one documented pre-run reason",
      });
    }
    if (trial.attempted && trial.excluded) {
      context.addIssue({
        code: "custom",
        path: ["excluded"],
        message:
          "attempted trials remain in the denominator and cannot be excluded",
      });
    }
    if (!trial.attempted && !trial.excluded) {
      context.addIssue({
        code: "custom",
        path: ["attempted"],
        message: "a completed trial record must be attempted or excluded",
      });
    }
  });

export type TrialRecord = z.infer<typeof TrialRecordSchema>;

export function assessTrialPair(input: {
  leftConfig: BenchmarkConfig;
  rightConfig: BenchmarkConfig;
  leftTrial: TrialRecord;
  rightTrial: TrialRecord;
  reportingUse: "development" | "headline";
}) {
  const configAssessment = assessComparisonPair({
    left: input.leftConfig,
    right: input.rightConfig,
    reportingUse: input.reportingUse,
  });
  const leftConfig = BenchmarkConfigSchema.parse(
    structuredClone(input.leftConfig),
  );
  const rightConfig = BenchmarkConfigSchema.parse(
    structuredClone(input.rightConfig),
  );
  const leftTrial = TrialRecordSchema.parse(structuredClone(input.leftTrial));
  const rightTrial = TrialRecordSchema.parse(structuredClone(input.rightTrial));
  const reasons = [...configAssessment.invalidationReasons];
  const add = (reason: ComparisonInvalidationReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (
    leftTrial.configHash !== leftConfig.configHash ||
    rightTrial.configHash !== rightConfig.configHash ||
    leftTrial.caseId !== leftConfig.case.id ||
    rightTrial.caseId !== rightConfig.case.id ||
    leftTrial.conditionId !== leftConfig.conditionId ||
    rightTrial.conditionId !== rightConfig.conditionId
  ) {
    add("trial_config_mismatch");
  }
  const leftTrialIndex = leftConfig.trialPlan.trialIds.indexOf(
    leftTrial.trialId,
  );
  const rightTrialIndex = rightConfig.trialPlan.trialIds.indexOf(
    rightTrial.trialId,
  );
  if (
    leftTrialIndex === -1 ||
    rightTrialIndex === -1 ||
    leftTrial.seed !== leftConfig.trialPlan.trialSeeds[leftTrialIndex] ||
    rightTrial.seed !== rightConfig.trialPlan.trialSeeds[rightTrialIndex] ||
    leftTrial.evidenceMode !== leftConfig.evidenceMode ||
    rightTrial.evidenceMode !== rightConfig.evidenceMode
  ) {
    add("trial_config_mismatch");
  }
  if (leftTrial.trialId !== rightTrial.trialId) {
    add("trial_identity_changed");
  }
  if (
    differs(leftTrial.actualPrimaryModel, leftConfig.primaryModel) ||
    differs(rightTrial.actualPrimaryModel, rightConfig.primaryModel)
  ) {
    add("actual_model_changed");
  }
  if (leftTrial.fallbackUsed || rightTrial.fallbackUsed) {
    add("fallback_observed");
  }
  if (leftTrial.excluded || rightTrial.excluded) {
    add("pre_run_exclusion_present");
  }

  return {
    valid: reasons.length === 0,
    invalidationReasons: reasons,
    leftConfigHash: leftConfig.configHash,
    rightConfigHash: rightConfig.configHash,
    trialId:
      leftTrial.trialId === rightTrial.trialId ? leftTrial.trialId : null,
  };
}
