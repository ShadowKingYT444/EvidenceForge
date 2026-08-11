import { join } from "node:path";
import { types as nodeTypes } from "node:util";

import { z } from "zod";

import { canonicalizeJson } from "../../src/contracts";
import { DEVELOPMENT_CASES } from "../cases/development-v1";
import {
  materializeStrongBaselineSmoke,
  parseBaselineAttemptSequence,
} from "../baseline/v1";
import {
  COMPARISON_INVALIDATION_REASONS,
  BenchmarkConfigSchema,
  TrialRecordSchema,
  assessComparisonPair,
  assessTrialPair,
  createBenchmarkConfig,
  type BenchmarkConfig,
  type ComparisonInvalidationReason,
} from "../protocol/v1";
import {
  WorkflowConditionFixtureSchema,
  createWorkflowDevelopmentMatrix,
  type WorkflowConditionId,
} from "../conditions/workflow-v1";

export const COMPARISON_ELIGIBILITY_VERSION = "1.0.0" as const;

const DEFAULT_BENCHMARK_CODE_VERSION =
  "348324361782ccbaaed9e959eec79fcf5bb262b6";
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const RightConditionIdSchema = z.enum([
  "complete_workflow",
  "no_verification",
  "no_adversarial_review",
]);

const AUTHORITY_INVALIDATION_REASONS = [
  "unauthorized_pair",
  "record_invalid",
  "authority_pair_id_mismatch",
  "authority_case_mismatch",
  "authority_condition_mismatch",
  "authority_trial_mismatch",
  "authority_run_mismatch",
  "authority_code_mismatch",
  "evidence_mismatch",
  "classification_mismatch",
  "unapproved_aggregate_payload",
] as const;

export const COMPARISON_ELIGIBILITY_REASONS = Object.freeze([
  ...COMPARISON_INVALIDATION_REASONS,
  ...AUTHORITY_INVALIDATION_REASONS,
] as const);

type AuthorityInvalidationReason =
  (typeof AUTHORITY_INVALIDATION_REASONS)[number];
export type ComparisonEligibilityReason =
  | ComparisonInvalidationReason
  | AuthorityInvalidationReason;

class PassiveDataError extends TypeError {}

function passiveDataSnapshot<T>(input: T): T {
  const snapshots = new WeakMap<object, unknown>();
  const visiting = new WeakSet<object>();

  function visit(value: unknown, path: string): unknown {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new PassiveDataError(
          `${path} must contain only finite JSON numbers`,
        );
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new PassiveDataError(`${path} must contain only passive JSON data`);
    }
    if (nodeTypes.isProxy(value)) {
      throw new PassiveDataError(`${path} must not contain proxies`);
    }
    if (visiting.has(value)) {
      throw new PassiveDataError(`${path} must not contain cycles`);
    }
    const prior = snapshots.get(value);
    if (prior !== undefined) return prior;

    const prototype = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new PassiveDataError(
        `${path} must use only ordinary object or array prototypes`,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
      throw new PassiveDataError(`${path} must not contain symbol keys`);
    }

    visiting.add(value);
    if (isArray) {
      const length = descriptors.length;
      if (
        length === undefined ||
        !("value" in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0
      ) {
        throw new PassiveDataError(`${path} has an invalid array length`);
      }
      const result: unknown[] = [];
      snapshots.set(value, result);
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new PassiveDataError(
            `${path}[${index}] must be an enumerable data property`,
          );
        }
        result.push(visit(descriptor.value, `${path}[${index}]`));
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: length.value }, (_, index) => String(index)),
      ]);
      if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) {
        throw new PassiveDataError(
          `${path} must not contain extra array properties`,
        );
      }
      visiting.delete(value);
      return result;
    }

    const result: Record<string, unknown> = {};
    snapshots.set(value, result);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new PassiveDataError(
          `${path}.${key} must be an enumerable data property`,
        );
      }
      Object.defineProperty(result, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: visit(descriptor.value, `${path}.${key}`),
      });
    }
    visiting.delete(value);
    return result;
  }

  return visit(input, "input") as T;
}

function deepFreeze<T>(input: T, seen = new WeakSet<object>()): T {
  if (typeof input !== "object" || input === null || seen.has(input)) {
    return input;
  }
  seen.add(input);
  for (const value of Object.values(input)) deepFreeze(value, seen);
  return Object.freeze(input);
}

const ClassificationSchema = z
  .object({
    evidenceMode: z.literal("fixture"),
    workflowEvidenceMode: z.literal("simulated"),
    reportingUse: z.literal("development"),
    headlineEligible: z.literal(false),
    trialRecordUse: z.literal("structural_eligibility_fixture_only"),
  })
  .strict();

const BaselineEvidenceSchema = z
  .object({
    parentRunId: IdSchema,
    rerunRunId: IdSchema,
    parentAttempts: z.array(z.json()).min(1),
    rerunAttempts: z.array(z.json()).min(1),
  })
  .strict();

const WorkflowEvidenceSchema = z
  .object({
    runId: IdSchema,
    fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
    conditionSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    attempts: z.array(z.json()).min(1),
    errors: z.array(z.json()),
  })
  .strict();

const MetricsSchema = z.record(z.string().min(1), z.number().finite());

const ComparisonCandidateSchema = z
  .object({
    schemaVersion: z.literal(COMPARISON_ELIGIBILITY_VERSION),
    pairId: IdSchema,
    caseId: IdSchema,
    leftConditionId: z.literal("strong_baseline"),
    rightConditionId: RightConditionIdSchema,
    trialId: z.enum(["trial-1", "trial-2", "trial-3"]),
    leftRunId: IdSchema,
    rightRunId: IdSchema,
    classification: ClassificationSchema,
    leftConfig: BenchmarkConfigSchema,
    rightConfig: BenchmarkConfigSchema,
    leftTrial: TrialRecordSchema,
    rightTrial: TrialRecordSchema,
    baselineEvidence: BaselineEvidenceSchema,
    workflowEvidence: WorkflowEvidenceSchema,
    preference: z.enum(["left", "right", "tie"]).nullable(),
    metrics: MetricsSchema.nullable(),
  })
  .strict();

export type ComparisonCandidate = z.infer<typeof ComparisonCandidateSchema>;

declare const comparisonPairAuthorityBrand: unique symbol;
export type ComparisonPairAuthority = Readonly<{
  [comparisonPairAuthorityBrand]: "ComparisonPairAuthority";
}>;

type TrustedPair = Readonly<{
  pairId: string;
  caseId: string;
  leftConditionId: "strong_baseline";
  rightConditionId: WorkflowConditionId;
  trialId: "trial-1" | "trial-2" | "trial-3";
  leftRunId: string;
  rightRunId: string;
  benchmarkCodeVersion: string;
  leftConfig: BenchmarkConfig;
  rightConfig: BenchmarkConfig;
  baselineEvidenceBytes: string;
  workflowEvidenceBytes: string;
  classificationBytes: string;
}>;

const trustedPairByAuthority = new WeakMap<object, TrustedPair>();

function issuePairAuthority(candidate: ComparisonCandidate) {
  const authority = Object.freeze(Object.create(null)) as ComparisonPairAuthority;
  trustedPairByAuthority.set(
    authority,
    Object.freeze({
      pairId: candidate.pairId,
      caseId: candidate.caseId,
      leftConditionId: candidate.leftConditionId,
      rightConditionId: candidate.rightConditionId,
      trialId: candidate.trialId,
      leftRunId: candidate.leftRunId,
      rightRunId: candidate.rightRunId,
      benchmarkCodeVersion: candidate.leftConfig.benchmarkCodeVersion,
      leftConfig: structuredClone(candidate.leftConfig),
      rightConfig: structuredClone(candidate.rightConfig),
      baselineEvidenceBytes: canonicalizeJson(candidate.baselineEvidence),
      workflowEvidenceBytes: canonicalizeJson(candidate.workflowEvidence),
      classificationBytes: canonicalizeJson(candidate.classification),
    }),
  );
  return authority;
}

function trustedPair(authority: unknown): TrustedPair | undefined {
  if (
    (typeof authority !== "object" || authority === null) &&
    typeof authority !== "function"
  ) {
    return undefined;
  }
  return trustedPairByAuthority.get(authority as object);
}

function trialRecord(
  config: BenchmarkConfig,
  trialId: "trial-1" | "trial-2" | "trial-3",
) {
  const index = config.trialPlan.trialIds.indexOf(trialId);
  return TrialRecordSchema.parse({
    protocolVersion: config.protocolVersion,
    configHash: config.configHash,
    caseId: config.case.id,
    conditionId: config.conditionId,
    trialId,
    evidenceMode: config.evidenceMode,
    seed: config.trialPlan.trialSeeds[index],
    attempted: true,
    fallbackUsed: false,
    actualPrimaryModel: config.primaryModel,
    fallbackModel: null,
    excluded: false,
    exclusionReason: null,
  });
}

function rightConfigFor(
  baselineConfig: BenchmarkConfig,
  workflowConfig: BenchmarkConfig,
  conditionId: WorkflowConditionId,
) {
  return createBenchmarkConfig({
    ...workflowConfig,
    id: `${baselineConfig.case.id}-${conditionId.replaceAll("_", "-")}-comparison`,
    conditionId,
  });
}

export async function materializeDevelopmentComparisonFixtureSet(input: {
  artifactRoot: string;
  benchmarkCodeVersion?: string;
}) {
  const safeInput = z
    .object({
      artifactRoot: z.string().min(1),
      benchmarkCodeVersion: GitShaSchema.optional(),
    })
    .strict()
    .parse(passiveDataSnapshot(input));
  const benchmarkCodeVersion =
    safeInput.benchmarkCodeVersion ?? DEFAULT_BENCHMARK_CODE_VERSION;
  const workflowFixtures = createWorkflowDevelopmentMatrix();
  const pairs: Array<{
    authority: ComparisonPairAuthority;
    candidate: ComparisonCandidate;
  }> = [];

  for (const developmentCase of DEVELOPMENT_CASES) {
    const baseline = await materializeStrongBaselineSmoke({
      artifactRoot: join(
        safeInput.artifactRoot,
        `baseline-${developmentCase.benchmarkCase.id}`,
      ),
      developmentCase,
      benchmarkCodeVersion,
    });
    const parentAttempts = parseBaselineAttemptSequence(
      baseline.parentAuthority,
      baseline.parentAttempts.map(({ raw }) => raw.rawOutput),
    );
    const rerunAttempts = parseBaselineAttemptSequence(
      baseline.rerunAuthority,
      baseline.rerunAttempts.map(({ raw }) => raw.rawOutput),
    );
    const baselineEvidence = BaselineEvidenceSchema.parse({
      parentRunId: baseline.parentManifest.runId,
      rerunRunId: baseline.rerunManifest.runId,
      parentAttempts,
      rerunAttempts,
    });

    for (const workflowFixtureInput of workflowFixtures.filter(
      ({ developmentCase: candidateCase }) =>
        candidateCase.benchmarkCase.id === developmentCase.benchmarkCase.id,
    )) {
      const workflowFixture = WorkflowConditionFixtureSchema.parse(
        workflowFixtureInput,
      );
      const rightConditionId = RightConditionIdSchema.parse(
        workflowFixture.condition.id,
      );
      const trialId = z
        .enum(["trial-1", "trial-2", "trial-3"])
        .parse(workflowFixture.runConfig.trialId);
      const rightConfig = rightConfigFor(
        baseline.bundle.baseline.config,
        baseline.bundle.workflow.config,
        rightConditionId,
      );
      const leftConfig = structuredClone(baseline.bundle.baseline.config);
      const pairId = `${developmentCase.benchmarkCase.id}-baseline-vs-${rightConditionId.replaceAll("_", "-")}-${trialId}`;
      const canonicalRun = workflowFixture.attempts[0]!.parsed.canonicalRun;
      const workflowEvidence = WorkflowEvidenceSchema.parse({
        runId: workflowFixture.runConfig.runId,
        fixtureHash: workflowFixture.fixtureHash,
        conditionSpecHash: workflowFixture.condition.specHash,
        attempts: workflowFixture.attempts,
        errors: canonicalRun?.errors ?? [],
      });
      const candidate = ComparisonCandidateSchema.parse({
        schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
        pairId,
        caseId: developmentCase.benchmarkCase.id,
        leftConditionId: "strong_baseline",
        rightConditionId,
        trialId,
        leftRunId: `${pairId}-left`,
        rightRunId: `${pairId}-right`,
        classification: {
          evidenceMode: "fixture",
          workflowEvidenceMode: "simulated",
          reportingUse: "development",
          headlineEligible: false,
          trialRecordUse: "structural_eligibility_fixture_only",
        },
        leftConfig,
        rightConfig,
        leftTrial: trialRecord(leftConfig, trialId),
        rightTrial: trialRecord(rightConfig, trialId),
        baselineEvidence,
        workflowEvidence,
        preference: null,
        metrics: null,
      });
      const initialAssessment = assessComparisonPair({
        left: candidate.leftConfig,
        right: candidate.rightConfig,
        reportingUse: "development",
      });
      if (!initialAssessment.valid) {
        throw new TypeError(
          `accepted comparison fixture is invalid: ${initialAssessment.invalidationReasons.join(", ")}`,
        );
      }
      pairs.push({ authority: issuePairAuthority(candidate), candidate });
    }
  }

  pairs.sort((left, right) =>
    left.candidate.pairId.localeCompare(right.candidate.pairId),
  );
  return { schemaVersion: COMPARISON_ELIGIBILITY_VERSION, pairs };
}

const REASON_ORDER = new Map<ComparisonEligibilityReason, number>(
  COMPARISON_ELIGIBILITY_REASONS.map((reason, index) => [reason, index]),
);

function sortReasons(reasons: Iterable<ComparisonEligibilityReason>) {
  return [...new Set(reasons)].sort(
    (left, right) => REASON_ORDER.get(left)! - REASON_ORDER.get(right)!,
  );
}

export type ComparisonEligibilityResult = Readonly<{
  schemaVersion: typeof COMPARISON_ELIGIBILITY_VERSION;
  pairId: string | null;
  eligible: boolean;
  invalidationReasons: ComparisonEligibilityReason[];
  leftConfigHash: string | null;
  rightConfigHash: string | null;
  excludedFromAggregates: boolean;
  preference: "left" | "right" | "tie" | null;
  metrics: Record<string, number> | null;
  preservedEvidence: {
    baseline: ComparisonCandidate["baselineEvidence"];
    workflow: ComparisonCandidate["workflowEvidence"];
  } | null;
  preservedEligibility: {
    left: Pick<
      ComparisonCandidate["leftTrial"],
      "attempted" | "fallbackUsed" | "excluded" | "exclusionReason"
    >;
    right: Pick<
      ComparisonCandidate["rightTrial"],
      "attempted" | "fallbackUsed" | "excluded" | "exclusionReason"
    >;
  } | null;
}>;

const issuedAssessments = new WeakSet<object>();

function freezeIssuedAssessment(
  result: ComparisonEligibilityResult,
): ComparisonEligibilityResult {
  const owned = deepFreeze(passiveDataSnapshot(result));
  issuedAssessments.add(owned as object);
  return owned;
}

function unauthorizedAssessment(): ComparisonEligibilityResult {
  return deepFreeze({
    schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
    pairId: null,
    eligible: false,
    invalidationReasons: ["unauthorized_pair"],
    leftConfigHash: null,
    rightConfigHash: null,
    excludedFromAggregates: true,
    preference: null,
    metrics: null,
    preservedEvidence: null,
    preservedEligibility: null,
  });
}

function invalidRecordAssessment(trusted: TrustedPair) {
  return freezeIssuedAssessment({
    schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
    pairId: trusted.pairId,
    eligible: false,
    invalidationReasons: ["record_invalid"],
    leftConfigHash: null,
    rightConfigHash: null,
    excludedFromAggregates: true,
    preference: null,
    metrics: null,
    preservedEvidence: null,
    preservedEligibility: null,
  });
}

export function assessComparisonEligibility(
  authority: ComparisonPairAuthority,
  input: unknown,
): ComparisonEligibilityResult {
  const trusted = trustedPair(authority);
  if (!trusted) return unauthorizedAssessment();

  let candidate: ComparisonCandidate;
  try {
    candidate = ComparisonCandidateSchema.parse(passiveDataSnapshot(input));
  } catch (error) {
    if (error instanceof PassiveDataError || error instanceof z.ZodError) {
      return invalidRecordAssessment(trusted);
    }
    throw error;
  }

  const reasons: ComparisonEligibilityReason[] = [];
  const add = (reason: ComparisonEligibilityReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const addProtocolAssessment = (assessment: {
    invalidationReasons: ComparisonInvalidationReason[];
  }) => assessment.invalidationReasons.forEach(add);

  addProtocolAssessment(
    assessComparisonPair({
      left: candidate.leftConfig,
      right: candidate.rightConfig,
      reportingUse: "development",
    }),
  );
  addProtocolAssessment(
    assessComparisonPair({
      left: trusted.leftConfig,
      right: candidate.rightConfig,
      reportingUse: "development",
    }),
  );
  addProtocolAssessment(
    assessComparisonPair({
      left: candidate.leftConfig,
      right: trusted.rightConfig,
      reportingUse: "development",
    }),
  );
  addProtocolAssessment(
    assessTrialPair({
      leftConfig: candidate.leftConfig,
      rightConfig: candidate.rightConfig,
      leftTrial: candidate.leftTrial,
      rightTrial: candidate.rightTrial,
      reportingUse: "development",
    }),
  );

  if (candidate.pairId !== trusted.pairId) add("authority_pair_id_mismatch");
  if (
    candidate.caseId !== trusted.caseId ||
    candidate.leftConfig.case.id !== trusted.caseId ||
    candidate.rightConfig.case.id !== trusted.caseId
  ) {
    add("authority_case_mismatch");
  }
  if (
    candidate.leftConditionId !== trusted.leftConditionId ||
    candidate.rightConditionId !== trusted.rightConditionId ||
    candidate.leftConfig.conditionId !== trusted.leftConditionId ||
    candidate.rightConfig.conditionId !== trusted.rightConditionId
  ) {
    add("authority_condition_mismatch");
  }
  if (
    candidate.trialId !== trusted.trialId ||
    candidate.leftTrial.trialId !== trusted.trialId ||
    candidate.rightTrial.trialId !== trusted.trialId
  ) {
    add("authority_trial_mismatch");
  }
  if (
    candidate.leftRunId !== trusted.leftRunId ||
    candidate.rightRunId !== trusted.rightRunId
  ) {
    add("authority_run_mismatch");
  }
  if (
    candidate.leftConfig.benchmarkCodeVersion !==
      trusted.benchmarkCodeVersion ||
    candidate.rightConfig.benchmarkCodeVersion !==
      trusted.benchmarkCodeVersion
  ) {
    add("authority_code_mismatch");
  }
  if (
    canonicalizeJson(candidate.baselineEvidence) !==
      trusted.baselineEvidenceBytes ||
    canonicalizeJson(candidate.workflowEvidence) !== trusted.workflowEvidenceBytes
  ) {
    add("evidence_mismatch");
  }
  if (
    canonicalizeJson(candidate.classification) !== trusted.classificationBytes
  ) {
    add("classification_mismatch");
  }
  if (candidate.preference !== null || candidate.metrics !== null) {
    add("unapproved_aggregate_payload");
  }

  const invalidationReasons = sortReasons(reasons);
  const eligible = invalidationReasons.length === 0;
  return freezeIssuedAssessment({
    schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
    pairId: trusted.pairId,
    eligible,
    invalidationReasons,
    leftConfigHash: candidate.leftConfig.configHash,
    rightConfigHash: candidate.rightConfig.configHash,
    excludedFromAggregates: !eligible,
    preference: eligible ? candidate.preference : null,
    metrics: eligible ? candidate.metrics : null,
    preservedEvidence: {
      baseline: candidate.baselineEvidence,
      workflow: candidate.workflowEvidence,
    },
    preservedEligibility: {
      left: {
        attempted: candidate.leftTrial.attempted,
        fallbackUsed: candidate.leftTrial.fallbackUsed,
        excluded: candidate.leftTrial.excluded,
        exclusionReason: candidate.leftTrial.exclusionReason,
      },
      right: {
        attempted: candidate.rightTrial.attempted,
        fallbackUsed: candidate.rightTrial.fallbackUsed,
        excluded: candidate.rightTrial.excluded,
        exclusionReason: candidate.rightTrial.exclusionReason,
      },
    },
  });
}

function acceptedAssessments(
  input: readonly ComparisonEligibilityResult[],
): ComparisonEligibilityResult[] {
  const results = [...input];
  for (const result of results) {
    if (
      (typeof result !== "object" || result === null) ||
      !issuedAssessments.has(result as object)
    ) {
      throw new TypeError(
        "aggregate input must be an issued comparison assessment",
      );
    }
  }
  const sorted = results.sort((left, right) =>
    (left.pairId ?? "").localeCompare(right.pairId ?? ""),
  );
  const pairIds = sorted.map(({ pairId }) => pairId);
  if (new Set(pairIds).size !== pairIds.length) {
    throw new TypeError("aggregate input must not contain duplicate pair IDs");
  }
  return sorted;
}

export function aggregateEligibleComparisons(
  input: readonly ComparisonEligibilityResult[],
) {
  const results = acceptedAssessments(input);
  const eligible = results.filter(({ eligible }) => eligible);
  return {
    schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
    inputPairs: results.length,
    eligiblePairs: eligible.length,
    invalidPairs: results.length - eligible.length,
    includedPreferencePairIds: eligible
      .filter(({ preference }) => preference !== null)
      .map(({ pairId }) => pairId!),
    includedMetricPairIds: eligible
      .filter(({ metrics }) => metrics !== null)
      .map(({ pairId }) => pairId!),
    exclusions: results
      .filter(({ eligible: isEligible }) => !isEligible)
      .map(({ pairId, invalidationReasons }) => ({
        pairId: pairId!,
        invalidationReasons,
      })),
  };
}

export function exportComparisonEligibilityTable(
  input: readonly ComparisonEligibilityResult[],
): string {
  const results = acceptedAssessments(input);
  return `${canonicalizeJson({
    schemaVersion: COMPARISON_ELIGIBILITY_VERSION,
    rows: results.map(
      ({
        pairId,
        eligible,
        invalidationReasons,
        leftConfigHash,
        rightConfigHash,
        excludedFromAggregates,
        preference,
        metrics,
        preservedEligibility,
      }) => ({
        pairId,
        eligible,
        invalidationReasons,
        leftConfigHash,
        rightConfigHash,
        excludedFromAggregates,
        preference,
        metrics,
        preservedEligibility,
      }),
    ),
  })}\n`;
}
