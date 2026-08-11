import { z } from "zod";
import { isProxy } from "node:util/types";

import {
  canonicalSha256,
  canonicalizeJson,
} from "../../src/contracts/canonical";
import {
  ALLOWED_EXCLUSION_REASONS,
  COMPARISON_INVALIDATION_REASONS,
  ExclusionReasonSchema,
} from "../protocol/v1";
import {
  RecordedAttemptSchema,
  RunManifestSchema,
  type RecordedAttempt,
  type RunManifest,
} from "../runner/v1";
import {
  DevelopmentCaseSchema,
  type DevelopmentCase,
} from "../cases/development-v1";
import {
  parseBaselineAttemptSequence,
  safeParseBaselineAttemptSequence,
  type BaselineAttemptEvidence,
  type StrongBaselineRunAuthority,
} from "../baseline/v1";
import {
  WorkflowConditionFixtureSchema,
  type WorkflowConditionFixture,
} from "../conditions/workflow-v1";
import {
  aggregateEligibleComparisons,
  assessComparisonEligibility,
  type ComparisonCandidate,
  type ComparisonEligibilityResult,
  type ComparisonPairAuthority,
} from "../comparison/parity-v1";

export const METRICS_VERSION = "1.0.0" as const;

const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const ConditionIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[a-z0-9_]*[a-z0-9])?$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NonLiveEvidenceModeSchema = z.enum(["fixture", "mocked", "simulated"]);
const MetricIdSchema = z.enum([
  "call_count_per_attempted_run",
  "citation_existence",
  "contradiction_recall",
  "estimated_cost_micro_usd_per_attempted_run",
  "experiment_completeness",
  "latency_ms_per_attempted_run",
  "metadata_match",
  "requirement_coverage",
  "schema_error_rate",
  "token_usage_per_attempted_run",
]);

const METRIC_IDS = Object.freeze([...MetricIdSchema.options].sort());
const DENOMINATOR_POLICY =
  "retain_all_attempts_and_failures; omit_only_documented_protocol_pre_run_exclusions; comparison_invalid_attempts_remain_visible" as const;
const QUOTIENT_SCALE = 1_000_000;

const KnownContradictionSchema = z
  .object({
    id: IdSchema,
    contradictingChunkId: IdSchema,
  })
  .strict();

const ComparisonSchema = z
  .object({
    status: z.enum(["valid", "invalid"]),
    reasons: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (
      (comparison.status === "valid" && comparison.reasons.length !== 0) ||
      (comparison.status === "invalid" && comparison.reasons.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "comparison reasons must match comparison validity",
      });
    }
    if (new Set(comparison.reasons).size !== comparison.reasons.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "comparison invalidation reasons must be unique",
      });
    }
  });

const MetricRunRecordZodSchema = z
  .object({
    schemaVersion: z.literal(METRICS_VERSION),
    runId: IdSchema,
    rerunOfRunId: IdSchema.nullable(),
    caseId: IdSchema,
    conditionId: ConditionIdSchema,
    trialId: z.string().min(1),
    configHash: HashSchema,
    evidenceMode: NonLiveEvidenceModeSchema,
    reportingUse: z.literal("development"),
    resultClass: z.literal("smoke_only"),
    headlineEligible: z.literal(false),
    comparison: ComparisonSchema,
    knownContradictions: z.array(KnownContradictionSchema),
    attempts: z.array(RecordedAttemptSchema).min(1),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.runId === record.rerunOfRunId) {
      context.addIssue({
        code: "custom",
        path: ["rerunOfRunId"],
        message: "a metric run cannot be its own rerun parent",
      });
    }
    if (
      record.attempts.some(
        ({ raw }) =>
          raw.runId !== record.runId ||
          raw.trialId !== record.trialId ||
          raw.evidenceMode !== record.evidenceMode,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "attempt identity must match its metric run record",
      });
    }
    const attemptNumbers = record.attempts.map(
      ({ raw }) => raw.attemptNumber,
    );
    if (
      new Set(attemptNumbers).size !== attemptNumbers.length ||
      attemptNumbers.some((attempt, index) => attempt !== index + 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "metric attempts must be unique and contiguous from one",
      });
    }
    if (
      new Set(record.knownContradictions.map(({ id }) => id)).size !==
      record.knownContradictions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["knownContradictions"],
        message: "known contradiction IDs must be unique",
      });
    }
  });

export type MetricRunRecord = z.infer<typeof MetricRunRecordZodSchema>;

export type MetricComparisonBinding = Readonly<{
  authority: ComparisonPairAuthority;
  candidate: ComparisonCandidate;
  assessment: ComparisonEligibilityResult;
}>;

const PreRunExclusionSchema = z
  .object({
    caseId: IdSchema,
    conditionId: ConditionIdSchema,
    trialId: z.string().min(1),
    evidenceMode: NonLiveEvidenceModeSchema,
    reason: ExclusionReasonSchema,
    detail: z.string().min(1),
  })
  .strict();

const QuotientSchema = z
  .object({
    scaledInteger: z.number().int().nonnegative(),
    scale: z.literal(QUOTIENT_SCALE),
    decimal: z.string().regex(/^\d+\.\d{6}$/),
  })
  .strict();

const TelemetrySchema = z
  .object({
    observed: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ observed, expected }) => observed <= expected, {
    message: "observed telemetry cannot exceed expected telemetry",
  });

const MetricPointSchema = z
  .object({
    id: MetricIdSchema,
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    availability: z.enum(["available", "partial", "unavailable"]),
    quotient: QuotientSchema.nullable(),
    unit: z.enum([
      "ratio",
      "calls_per_run",
      "milliseconds_per_run",
      "tokens_per_run",
      "micro_usd_per_run",
    ]),
    unavailableReason: z
      .enum([
        "zero_denominator",
        "telemetry_not_reported",
        "incomplete_telemetry",
      ])
      .nullable(),
    telemetry: TelemetrySchema.nullable(),
    retainedFailedRuns: z.number().int().nonnegative(),
    preRunExcluded: z.number().int().nonnegative(),
    denominatorPolicy: z.literal(DENOMINATOR_POLICY),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.denominator === 0 && metric.numerator !== 0) {
      context.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "a zero denominator requires a zero numerator",
      });
    }
    if (metric.unit === "ratio" && metric.numerator > metric.denominator) {
      context.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "a ratio numerator cannot exceed its denominator",
      });
    }
    const expectedAvailability =
      metric.denominator === 0
        ? {
            availability: "unavailable" as const,
            reason: "zero_denominator" as const,
          }
        : metric.telemetry !== null && metric.telemetry.observed === 0
          ? {
              availability: "unavailable" as const,
              reason: "telemetry_not_reported" as const,
            }
          : metric.telemetry !== null &&
              metric.telemetry.observed < metric.telemetry.expected
            ? {
                availability: "partial" as const,
                reason: "incomplete_telemetry" as const,
              }
            : { availability: "available" as const, reason: null };
    if (
      metric.availability !== expectedAvailability.availability ||
      metric.unavailableReason !== expectedAvailability.reason
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability"],
        message:
          "metric availability must derive from denominator and telemetry coverage",
      });
    }
    const quotientAllowed =
      metric.availability === "available" && metric.denominator > 0;
    if (quotientAllowed !== (metric.quotient !== null)) {
      context.addIssue({
        code: "custom",
        path: ["quotient"],
        message: "only an available nonzero-denominator metric has a quotient",
      });
    }
    if (
      metric.quotient !== null &&
      JSON.stringify(metric.quotient) !==
        JSON.stringify(quotient(metric.numerator, metric.denominator))
    ) {
      context.addIssue({
        code: "custom",
        path: ["quotient"],
        message: "metric quotient must derive from its numerator and denominator",
      });
    }
    if (
      (metric.availability === "available" &&
        metric.unavailableReason !== null) ||
      (metric.availability !== "available" &&
        metric.unavailableReason === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "metric availability requires a coherent reason",
      });
    }
  });

const SummarySchema = z
  .object({
    attemptedRuns: z.number().int().nonnegative(),
    retainedFailedRuns: z.number().int().nonnegative(),
    preRunExcluded: z.number().int().nonnegative(),
    comparisonInvalidRuns: z.number().int().nonnegative(),
  })
  .strict();

const InvalidComparisonSchema = z
  .object({
    runId: IdSchema,
    conditionId: ConditionIdSchema,
    retainedFailure: z.boolean(),
    reasons: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ConditionMetricsSchema = z
  .object({
    conditionId: ConditionIdSchema,
    comparisonEligibleRuns: z.number().int().nonnegative(),
    retainedFailedRuns: z.number().int().nonnegative(),
    preRunExcluded: z.number().int().nonnegative(),
    metrics: z.array(MetricPointSchema).length(METRIC_IDS.length),
  })
  .strict();

const MetricArtifactPayloadSchema = z
  .object({
    schemaVersion: z.literal(METRICS_VERSION),
    evidenceMode: z.enum([
      "fixture",
      "mocked",
      "simulated",
      "mixed_non_live",
      "unavailable",
    ]),
    reportingUse: z.literal("development"),
    resultClass: z.literal("smoke_only"),
    headlineEligible: z.literal(false),
    summary: SummarySchema,
    metrics: z.array(MetricPointSchema).length(METRIC_IDS.length),
    conditionMetrics: z.array(ConditionMetricsSchema),
    exclusions: z.array(PreRunExclusionSchema),
    invalidComparisons: z.array(InvalidComparisonSchema),
  })
  .strict()
  .superRefine((artifact, context) => {
    const ids = artifact.metrics.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(METRIC_IDS)) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "metric rows must be complete, unique, and canonically sorted",
      });
    }
    const conditionIds = artifact.conditionMetrics.map(
      ({ conditionId }) => conditionId,
    );
    if (
      new Set(conditionIds).size !== conditionIds.length ||
      JSON.stringify(conditionIds) !==
        JSON.stringify([...conditionIds].sort()) ||
      artifact.conditionMetrics.some(
        ({ metrics }) =>
          JSON.stringify(metrics.map(({ id }) => id)) !==
          JSON.stringify(METRIC_IDS),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["conditionMetrics"],
        message:
          "condition metric groups and their metric rows must be canonically sorted and unique",
      });
    }
    const eligibleRuns = artifact.conditionMetrics.reduce(
      (total, condition) => total + condition.comparisonEligibleRuns,
      0,
    );
    const eligibleFailures = artifact.conditionMetrics.reduce(
      (total, condition) => total + condition.retainedFailedRuns,
      0,
    );
    const invalidFailures = artifact.invalidComparisons.filter(
      ({ retainedFailure }) => retainedFailure,
    ).length;
    const conditionExclusions = artifact.conditionMetrics.reduce(
      (total, condition) => total + condition.preRunExcluded,
      0,
    );
    if (
      artifact.summary.attemptedRuns !==
        eligibleRuns + artifact.invalidComparisons.length ||
      artifact.summary.comparisonInvalidRuns !==
        artifact.invalidComparisons.length ||
      artifact.summary.retainedFailedRuns !==
        eligibleFailures + invalidFailures ||
      artifact.summary.preRunExcluded !== artifact.exclusions.length ||
      artifact.summary.preRunExcluded !== conditionExclusions ||
      artifact.summary.retainedFailedRuns > artifact.summary.attemptedRuns
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message:
          "summary counts must reconcile to eligible, invalid, failed, and excluded source rows",
      });
    }
    for (const [index, metric] of artifact.metrics.entries()) {
      if (
        metric.retainedFailedRuns !== artifact.summary.retainedFailedRuns ||
        metric.preRunExcluded !== artifact.summary.preRunExcluded
      ) {
        context.addIssue({
          code: "custom",
          path: ["metrics", index],
          message:
            "all-attempted metric failure and exclusion counts must match summary",
        });
      }
    }
    const exclusionCounts = new Map<string, number>();
    for (const exclusion of artifact.exclusions) {
      exclusionCounts.set(
        exclusion.conditionId,
        (exclusionCounts.get(exclusion.conditionId) ?? 0) + 1,
      );
    }
    for (const [conditionIndex, condition] of artifact.conditionMetrics.entries()) {
      if (
        condition.retainedFailedRuns > condition.comparisonEligibleRuns ||
        condition.preRunExcluded !==
          (exclusionCounts.get(condition.conditionId) ?? 0) ||
        condition.metrics.some(
          (metric) =>
            metric.retainedFailedRuns !== condition.retainedFailedRuns ||
            metric.preRunExcluded !== condition.preRunExcluded,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["conditionMetrics", conditionIndex],
          message:
            "condition counts and metric rows must reconcile to eligible runs and exclusions",
        });
      }
    }
    const invalidRunIds = artifact.invalidComparisons.map(({ runId }) => runId);
    if (
      new Set(invalidRunIds).size !== invalidRunIds.length ||
      JSON.stringify(invalidRunIds) !==
        JSON.stringify([...invalidRunIds].sort()) ||
      artifact.invalidComparisons.some(
        ({ reasons }) =>
          new Set(reasons).size !== reasons.length ||
          JSON.stringify(reasons) !== JSON.stringify([...reasons].sort()),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["invalidComparisons"],
        message:
          "invalid comparison rows and reasons must be unique and canonically sorted",
      });
    }
  });

const MetricArtifactZodSchema = MetricArtifactPayloadSchema.extend({
  artifactHash: HashSchema,
})
  .strict()
  .superRefine((artifact, context) => {
    const { artifactHash, ...payload } = artifact;
    if (artifactHash !== canonicalSha256(payload)) {
      context.addIssue({
        code: "custom",
        path: ["artifactHash"],
        message: "artifact hash does not match the canonical metric payload",
      });
    }
  });

export type MetricArtifact = z.infer<typeof MetricArtifactZodSchema>;

declare const metricAuthorityBrand: unique symbol;
export type MetricArtifactAuthority = Readonly<{
  [metricAuthorityBrand]: "metric-artifact-authority";
}>;

declare const metricRunAuthorityBrand: unique symbol;
export type MetricRunRecordAuthority = Readonly<{
  [metricRunAuthorityBrand]: "metric-run-record-authority";
}>;

type MetricRunSourceState = {
  readonly authority: MetricRunRecordAuthority;
  readonly record: MetricRunRecord;
  readonly canonicalRecord: string;
  readonly rebuildFromUpstream: () => MetricRunRecord;
  revoked: boolean;
};

type ValidatedMetricComparison = Readonly<{
  authority: ComparisonPairAuthority;
  candidate: ComparisonCandidate;
  assessment: ComparisonEligibilityResult;
  canonicalCandidate: string;
  canonicalAssessment: string;
}>;

type MetricSourceSnapshot = Readonly<{
  runStates: readonly MetricRunSourceState[];
  exclusions: readonly z.output<typeof PreRunExclusionSchema>[];
}>;

type MetricAuthorityState = {
  readonly authority: MetricArtifactAuthority;
  readonly source: MetricSourceSnapshot;
  readonly canonicalArtifact: string;
  revoked: boolean;
};

type PassiveSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: TypeError };

const artifactAuthorityByIdentity = new WeakMap<object, MetricAuthorityState>();
const metricAuthorityState = new WeakMap<object, MetricAuthorityState>();
const metricRunStateByIdentity = new WeakMap<object, MetricRunSourceState>();
const metricRunStateByAuthority = new WeakMap<object, MetricRunSourceState>();
const acceptedComparisonPairAuthorities = new WeakSet<object>();
const revokedComparisonPairAuthorities = new WeakSet<object>();

export const MetricRunRecordSchema = Object.freeze({
  parse(
    input: unknown,
    authority?: MetricRunRecordAuthority,
  ): MetricRunRecord {
    return parseAuthorizedMetricRunRecord(input, authority);
  },
  safeParse(input: unknown): PassiveSafeParseResult<MetricRunRecord> {
    try {
      return { success: true, data: parseAuthorizedMetricRunRecord(input) };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof TypeError
            ? error
            : new TypeError("metric run source authority validation failed"),
      };
    }
  },
});

export const MetricArtifactSchema = Object.freeze({
  parse(input: unknown): MetricArtifact {
    return parseAuthorizedMetricIdentity(input);
  },
  safeParse(input: unknown): PassiveSafeParseResult<MetricArtifact> {
    try {
      return { success: true, data: parseAuthorizedMetricIdentity(input) };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof TypeError
            ? error
            : new TypeError("metric artifact authority validation failed"),
      };
    }
  },
});

function rejectProxy(value: unknown, label: string): void {
  if (typeof value === "object" && value !== null && isProxy(value)) {
    throw new TypeError(`${label} cannot be a proxy`);
  }
}

function requiredDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function assertPlainData(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  rejectProxy(value, label);
  if (seen.has(value)) throw new TypeError(`${label} cannot contain cycles`);
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError(`${label} must contain only plain data`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    throw new TypeError(`${label} cannot contain symbol properties: ${String(symbol)}`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw new TypeError(`${label} cannot contain accessor property ${key}`);
    }
    if (Array.isArray(value) && key === "length") continue;
    assertPlainData(descriptor.value, label, seen);
  }
  seen.delete(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

const protocolComparisonReasons = new Set<string>(
  COMPARISON_INVALIDATION_REASONS,
);

function validateMetricComparisonValues(input: {
  authority: ComparisonPairAuthority;
  candidate: ComparisonCandidate;
  assessment: ComparisonEligibilityResult;
}): void {
  if (typeof input.authority !== "object" || input.authority === null) {
    throw new TypeError("comparison pair authority is required");
  }
  rejectProxy(input.authority, "comparison pair authority");
  if (revokedComparisonPairAuthorities.has(input.authority)) {
    throw new TypeError("comparison pair authority is revoked");
  }
  if (typeof input.assessment !== "object" || input.assessment === null) {
    throw new TypeError("issued comparison assessment is required");
  }
  rejectProxy(input.assessment, "comparison assessment");
  if (typeof input.candidate !== "object" || input.candidate === null) {
    throw new TypeError("comparison candidate is required");
  }
  rejectProxy(input.candidate, "comparison candidate");

  try {
    aggregateEligibleComparisons([input.assessment]);
  } catch {
    throw new TypeError(
      "comparison assessment must be the exact comparison-parity issued result",
    );
  }
  const recomputed = assessComparisonEligibility(
    input.authority,
    input.candidate,
  );
  if (
    recomputed.pairId === null ||
    recomputed.invalidationReasons.includes("unauthorized_pair")
  ) {
    throw new TypeError("comparison pair authority is not recognized");
  }
  if (
    recomputed.invalidationReasons.some(
      (reason) => !protocolComparisonReasons.has(reason),
    )
  ) {
    throw new TypeError(
      "comparison pair does not authorize this exact case, condition, trial, run, evidence, and classification",
    );
  }
  if (
    canonicalizeJson(recomputed) !== canonicalizeJson(input.assessment)
  ) {
    throw new TypeError(
      "comparison assessment contradicts its authority and candidate",
    );
  }
}

function parseMetricComparisonBinding(
  input: MetricComparisonBinding,
): ValidatedMetricComparison {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("metric comparison binding is required");
  }
  rejectProxy(input, "metric comparison binding");
  const authority = requiredDataProperty(
    input,
    "authority",
    "comparison pair authority",
  ) as ComparisonPairAuthority;
  const candidate = requiredDataProperty(
    input,
    "candidate",
    "comparison candidate",
  ) as ComparisonCandidate;
  const assessment = requiredDataProperty(
    input,
    "assessment",
    "comparison assessment",
  ) as ComparisonEligibilityResult;
  validateMetricComparisonValues({ authority, candidate, assessment });
  const candidateSnapshot = deepFreeze(structuredClone(candidate));
  return Object.freeze({
    authority,
    candidate: candidateSnapshot,
    assessment,
    canonicalCandidate: canonicalizeJson(candidateSnapshot),
    canonicalAssessment: canonicalizeJson(assessment),
  });
}

function validateMetricComparisonBinding(
  binding: ValidatedMetricComparison,
): ValidatedMetricComparison {
  validateMetricComparisonValues(binding);
  if (
    canonicalizeJson(binding.candidate) !== binding.canonicalCandidate ||
    canonicalizeJson(binding.assessment) !== binding.canonicalAssessment
  ) {
    throw new TypeError("retained comparison binding has been altered");
  }
  return binding;
}

export function revokeMetricComparisonPairAuthority(
  authority: ComparisonPairAuthority,
): void {
  if (typeof authority !== "object" || authority === null) {
    throw new TypeError("comparison pair authority is required");
  }
  rejectProxy(authority, "comparison pair authority");
  if (!acceptedComparisonPairAuthorities.has(authority)) {
    throw new TypeError("comparison pair authority is not recognized");
  }
  if (revokedComparisonPairAuthorities.has(authority)) {
    throw new TypeError("comparison pair authority is revoked");
  }
  revokedComparisonPairAuthorities.add(authority);
}

function metricComparisonValue(binding: ValidatedMetricComparison) {
  const assessment = validateMetricComparisonBinding(binding).assessment;
  return assessment.eligible
    ? { status: "valid" as const, reasons: [] }
    : {
        status: "invalid" as const,
        reasons: [...assessment.invalidationReasons],
      };
}

function slotIdentity(record: {
  caseId: string;
  conditionId: string;
  trialId: string;
}): string {
  return `${record.caseId}\u0000${record.conditionId}\u0000${record.trialId}`;
}

function identityOf(
  record:
    | { runId: string }
    | { caseId: string; conditionId: string; trialId: string },
): string {
  return "runId" in record ? `run\u0000${record.runId}` : `slot\u0000${slotIdentity(record)}`;
}

function quotient(numerator: number, denominator: number) {
  if (denominator === 0) return null;
  const scaledInteger = Number(
    (BigInt(numerator) * BigInt(QUOTIENT_SCALE) + BigInt(Math.floor(denominator / 2))) /
      BigInt(denominator),
  );
  const whole = Math.floor(scaledInteger / QUOTIENT_SCALE);
  const fractional = String(scaledInteger % QUOTIENT_SCALE).padStart(6, "0");
  return {
    scaledInteger,
    scale: QUOTIENT_SCALE as typeof QUOTIENT_SCALE,
    decimal: `${whole}.${fractional}`,
  };
}

function metricPoint(input: {
  id: z.infer<typeof MetricIdSchema>;
  numerator: number;
  denominator: number;
  unit: z.infer<typeof MetricPointSchema>["unit"];
  retainedFailedRuns: number;
  preRunExcluded: number;
  telemetry?: { observed: number; expected: number };
}) {
  let availability: "available" | "partial" | "unavailable" = "available";
  let unavailableReason:
    | "zero_denominator"
    | "telemetry_not_reported"
    | "incomplete_telemetry"
    | null = null;
  if (input.denominator === 0) {
    availability = "unavailable";
    unavailableReason = "zero_denominator";
  } else if (input.telemetry && input.telemetry.observed === 0) {
    availability = "unavailable";
    unavailableReason = "telemetry_not_reported";
  } else if (
    input.telemetry &&
    input.telemetry.observed < input.telemetry.expected
  ) {
    availability = "partial";
    unavailableReason = "incomplete_telemetry";
  }
  return MetricPointSchema.parse({
    ...input,
    availability,
    quotient:
      availability === "available"
        ? quotient(input.numerator, input.denominator)
        : null,
    unavailableReason,
    telemetry: input.telemetry ?? null,
    denominatorPolicy: DENOMINATOR_POLICY,
  });
}

function validCanonicalRuns(record: MetricRunRecord) {
  return record.attempts.flatMap(({ parsed }) =>
    parsed.parseStatus === "valid" ? [parsed.canonicalRun] : [],
  );
}

function citedSources(run: ReturnType<typeof validCanonicalRuns>[number]) {
  const chunks = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
  const sources = new Map(run.sources.map((source) => [source.id, source]));
  const citations = run.evidenceCards.map((card) => {
    const chunk = chunks.get(card.sourceChunkId);
    return {
      exists: chunk !== undefined && sources.has(chunk.sourceId),
      source: chunk ? sources.get(chunk.sourceId) : undefined,
    };
  });
  return citations;
}

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  "claims",
  "sources",
  "chunks",
  "evidenceCards",
  "conclusions",
  "researchGaps",
  "experimentOutcome",
  "executions",
  "errors",
  "scopeDecision",
  "packet",
] as const);

function validRequiredOutputCount(run: ReturnType<typeof validCanonicalRuns>[number]) {
  return REQUIRED_OUTPUT_FIELDS.filter((field) => {
    if (field === "experimentOutcome") {
      return run.experiment !== null || run.experimentAbstention != null;
    }
    return Object.hasOwn(run, field) && run[field] !== null;
  }).length;
}

function experimentCompleteness(run: ReturnType<typeof validCanonicalRuns>[number]) {
  const experiment = run.experiment;
  if (!experiment) return 0;
  return [
    experiment.hypothesis.trim().length > 0,
    experiment.nullHypothesis.trim().length > 0,
    experiment.independentVariables.length > 0 &&
      experiment.dependentVariables.length > 0,
    experiment.controls.length > 0,
    experiment.metrics.length > 0,
    experiment.confounders.length > 0,
    experiment.hazards.length > 0 && experiment.ethics.length > 0,
    experiment.feasibility.trim().length > 0,
    experiment.failureCriteria.length > 0,
    experiment.stoppingCriteria.length > 0,
  ].filter(Boolean).length;
}

function contradictionRecall(record: MetricRunRecord) {
  const runs = validCanonicalRuns(record);
  let surfaced = 0;
  for (const run of runs) {
    const cards = new Map(run.evidenceCards.map((card) => [card.id, card]));
    const contradictingCardIds = new Set(
      run.conclusions.flatMap(({ contradictingEvidenceCardIds }) =>
        contradictingEvidenceCardIds,
      ),
    );
    for (const key of record.knownContradictions) {
      const recalled = run.evidenceCards.some(
        (card) =>
          card.sourceChunkId === key.contradictingChunkId &&
          (card.relationship === "contradicts" ||
            (contradictingCardIds.has(card.id) && cards.has(card.id))),
      );
      if (recalled) surfaced += 1;
    }
  }
  return surfaced;
}

function decimalToMicroUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("estimated cost must be a finite nonnegative number");
  }
  const scaled = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(scaled)) {
    throw new TypeError("estimated cost exceeds safe micro-USD precision");
  }
  return scaled;
}

function evidenceModeFor(
  runs: readonly MetricRunRecord[],
  exclusions: readonly z.infer<typeof PreRunExclusionSchema>[],
) {
  const modes = new Set([
    ...runs.map(({ evidenceMode }) => evidenceMode),
    ...exclusions.map(({ evidenceMode }) => evidenceMode),
  ]);
  if (modes.size === 0) return "unavailable" as const;
  if (modes.size > 1) return "mixed_non_live" as const;
  return [...modes][0]!;
}

function computeMetricSet(
  runs: readonly MetricRunRecord[],
  preRunExcluded: number,
) {
  const retainedFailedRuns = runs.filter((record) =>
    record.attempts.some(
      ({ raw, parsed }) =>
        raw.status === "failed" || parsed.parseStatus !== "valid",
    ),
  ).length;
  const canonicalRuns = runs.flatMap(validCanonicalRuns);
  const citations = canonicalRuns.flatMap(citedSources);
  const checkedMetadata = citations.filter(
    ({ source }) =>
      source?.metadataVerification.status === "match" ||
      source?.metadataVerification.status === "mismatch",
  );
  const allAttempts = runs.flatMap(({ attempts }) => attempts);
  const modelExecutions = canonicalRuns.flatMap((run) =>
    run.executions.filter(({ nodeId }) => nodeId !== "collect-sources"),
  );
  const unparsableAttempts = allAttempts.filter(
    ({ parsed }) => parsed.parseStatus !== "valid",
  );
  const callCount = modelExecutions.length + unparsableAttempts.length;
  const usageObserved = modelExecutions.filter(
    ({ usage }) => usage.totalTokens !== null,
  );
  const costObserved = modelExecutions.filter(
    ({ pricing }) => pricing.estimatedCost !== null,
  );
  const common = { retainedFailedRuns, preRunExcluded };
  const metrics = [
    metricPoint({
      id: "call_count_per_attempted_run",
      numerator: callCount,
      denominator: runs.length,
      unit: "calls_per_run",
      ...common,
    }),
    metricPoint({
      id: "citation_existence",
      numerator: citations.filter(({ exists }) => exists).length,
      denominator: citations.length,
      unit: "ratio",
      ...common,
    }),
    metricPoint({
      id: "contradiction_recall",
      numerator: runs.reduce(
        (total, record) => total + contradictionRecall(record),
        0,
      ),
      denominator: runs.reduce(
        (total, record) =>
          total + record.knownContradictions.length * record.attempts.length,
        0,
      ),
      unit: "ratio",
      ...common,
    }),
    metricPoint({
      id: "estimated_cost_micro_usd_per_attempted_run",
      numerator: costObserved.reduce(
        (total, { pricing }) =>
          total + decimalToMicroUsd(pricing.estimatedCost!),
        0,
      ),
      denominator: runs.length,
      unit: "micro_usd_per_run",
      telemetry: { observed: costObserved.length, expected: callCount },
      ...common,
    }),
    metricPoint({
      id: "experiment_completeness",
      numerator: canonicalRuns.reduce(
        (total, run) => total + experimentCompleteness(run),
        0,
      ),
      denominator: allAttempts.length * 10,
      unit: "ratio",
      ...common,
    }),
    metricPoint({
      id: "latency_ms_per_attempted_run",
      numerator: allAttempts.reduce(
        (total, { raw }) => total + raw.latencyMs,
        0,
      ),
      denominator: runs.length,
      unit: "milliseconds_per_run",
      ...common,
    }),
    metricPoint({
      id: "metadata_match",
      numerator: checkedMetadata.filter(
        ({ source }) => source!.metadataVerification.status === "match",
      ).length,
      denominator: checkedMetadata.length,
      unit: "ratio",
      telemetry: {
        observed: checkedMetadata.length,
        expected: citations.length,
      },
      ...common,
    }),
    metricPoint({
      id: "requirement_coverage",
      numerator: canonicalRuns.reduce(
        (total, run) => total + validRequiredOutputCount(run),
        0,
      ),
      denominator: allAttempts.length * REQUIRED_OUTPUT_FIELDS.length,
      unit: "ratio",
      ...common,
    }),
    metricPoint({
      id: "schema_error_rate",
      numerator: allAttempts.filter(
        ({ raw, parsed }) =>
          raw.status === "failed" || parsed.parseStatus !== "valid",
      ).length,
      denominator: allAttempts.length,
      unit: "ratio",
      ...common,
    }),
    metricPoint({
      id: "token_usage_per_attempted_run",
      numerator: usageObserved.reduce(
        (total, { usage }) => total + usage.totalTokens!,
        0,
      ),
      denominator: runs.length,
      unit: "tokens_per_run",
      telemetry: { observed: usageObserved.length, expected: callCount },
      ...common,
    }),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return { retainedFailedRuns, metrics };
}

function workflowEvidenceFromFixture(fixture: WorkflowConditionFixture) {
  return {
    runId: fixture.runConfig.runId,
    fixtureHash: fixture.fixtureHash,
    conditionSpecHash: fixture.condition.specHash,
    attempts: fixture.attempts,
    errors: fixture.attempts[0]!.parsed.canonicalRun?.errors ?? [],
  };
}

function assertWorkflowComparisonSource(
  fixture: WorkflowConditionFixture,
  comparison: ValidatedMetricComparison,
): void {
  const binding = validateMetricComparisonBinding(comparison);
  const candidate = binding.candidate;
  const caseId = fixture.developmentCase.benchmarkCase.id;
  const conditionId = fixture.condition.id;
  const trialId = fixture.runConfig.trialId;
  const expectedPairId = `${caseId}-baseline-vs-${conditionId.replaceAll("_", "-")}-${trialId}`;
  if (
    candidate.pairId !== expectedPairId ||
    candidate.caseId !== caseId ||
    candidate.rightConditionId !== conditionId ||
    candidate.trialId !== trialId ||
    candidate.rightRunId !== `${expectedPairId}-right` ||
    canonicalizeJson(candidate.workflowEvidence) !==
      canonicalizeJson(workflowEvidenceFromFixture(fixture))
  ) {
    throw new TypeError(
      "comparison pair must bind the exact accepted workflow fixture",
    );
  }
}

function workflowMetricRunRecord(
  fixture: WorkflowConditionFixture,
  comparison: ValidatedMetricComparison,
): MetricRunRecord {
  assertWorkflowComparisonSource(fixture, comparison);
  return MetricRunRecordZodSchema.parse({
    schemaVersion: METRICS_VERSION,
    runId: fixture.runConfig.runId,
    rerunOfRunId: fixture.runConfig.rerunOfRunId,
    caseId: fixture.developmentCase.benchmarkCase.id,
    conditionId: fixture.condition.id,
    trialId: fixture.runConfig.trialId,
    configHash: fixture.runConfig.benchmarkConfig.configHash,
    evidenceMode: fixture.runConfig.evidenceMode,
    reportingUse: fixture.runConfig.reportingUse,
    resultClass: fixture.runConfig.resultClass,
    headlineEligible: fixture.runConfig.headlineEligible,
    comparison: metricComparisonValue(comparison),
    knownContradictions:
      fixture.developmentCase.scoringKey.knownContradictions.map(
        ({ id, contradictingChunkId }) => ({ id, contradictingChunkId }),
      ),
    attempts: fixture.attempts,
  });
}

function issueMetricRunRecord(
  initialRecord: MetricRunRecord,
  rebuildFromUpstream: () => MetricRunRecord,
): MetricRunRecord {
  const record = deepFreeze(
    structuredClone(MetricRunRecordZodSchema.parse(initialRecord)),
  );
  const authority = Object.freeze(
    Object.create(null),
  ) as MetricRunRecordAuthority;
  const state: MetricRunSourceState = {
    authority,
    record,
    canonicalRecord: canonicalizeJson(record),
    rebuildFromUpstream,
    revoked: false,
  };
  metricRunStateByIdentity.set(record, state);
  metricRunStateByAuthority.set(authority, state);
  return record;
}

function metricRunAuthorityStateFor(
  authorityInput: unknown,
  allowRevoked = false,
): MetricRunSourceState {
  if (typeof authorityInput !== "object" || authorityInput === null) {
    throw new TypeError("metric run source authority is required");
  }
  rejectProxy(authorityInput, "metric run source authority");
  const state = metricRunStateByAuthority.get(authorityInput);
  if (!state) {
    throw new TypeError("metric run source authority is not recognized");
  }
  if (state.revoked && !allowRevoked) {
    throw new TypeError("metric run source authority is revoked");
  }
  return state;
}

function validateMetricRunSourceState(
  state: MetricRunSourceState,
): MetricRunRecord {
  if (state.revoked) {
    throw new TypeError("metric run source authority is revoked");
  }
  const rebuilt = MetricRunRecordZodSchema.parse(state.rebuildFromUpstream());
  if (
    canonicalizeJson(rebuilt) !== state.canonicalRecord ||
    canonicalizeJson(state.record) !== state.canonicalRecord
  ) {
    throw new TypeError(
      "metric run record contradicts its authorized upstream source",
    );
  }
  return state.record;
}

function parseAuthorizedMetricRunRecord(
  input: unknown,
  authorityInput?: MetricRunRecordAuthority,
): MetricRunRecord {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("metric run record requires authorized object identity");
  }
  rejectProxy(input, "metric run record");
  const state = metricRunStateByIdentity.get(input);
  if (!state) {
    throw new TypeError(
      "metric run record must be issued by an authorized source adapter",
    );
  }
  if (authorityInput !== undefined) {
    const supplied = metricRunAuthorityStateFor(authorityInput);
    if (supplied !== state) {
      throw new TypeError("metric run source authority belongs to another record");
    }
  }
  return validateMetricRunSourceState(state);
}

export function retainMetricRunRecordAuthority(
  record: MetricRunRecord,
): MetricRunRecordAuthority {
  const parsed = parseAuthorizedMetricRunRecord(record);
  return metricRunStateByIdentity.get(parsed)!.authority;
}

export function revokeMetricRunRecordAuthority(
  authority: MetricRunRecordAuthority,
): void {
  const state = metricRunAuthorityStateFor(authority, true);
  if (state.revoked) {
    throw new TypeError("metric run source authority is revoked");
  }
  state.revoked = true;
}

export function createWorkflowMetricRunRecord(
  fixtureInput: WorkflowConditionFixture,
  comparisonInput: MetricComparisonBinding,
): MetricRunRecord {
  const comparison = parseMetricComparisonBinding(comparisonInput);
  rejectProxy(fixtureInput, "workflow metric fixture");
  const fixture = WorkflowConditionFixtureSchema.parse(fixtureInput);
  const initial = workflowMetricRunRecord(fixture, comparison);
  acceptedComparisonPairAuthorities.add(comparison.authority);
  return issueMetricRunRecord(initial, () =>
    workflowMetricRunRecord(
      WorkflowConditionFixtureSchema.parse(fixtureInput),
      comparison,
    ),
  );
}

type BaselineMetricRecordInput = {
  authority: StrongBaselineRunAuthority;
  comparison: MetricComparisonBinding;
  developmentCase: DevelopmentCase;
  manifest: RunManifest;
  attempts: readonly RecordedAttempt[];
};

type ValidatedBaselineMetricRecordInput = Omit<
  BaselineMetricRecordInput,
  "comparison"
> & {
  comparison: ValidatedMetricComparison;
};

function requireStrongBaselineRunAuthority(
  authority: StrongBaselineRunAuthority,
): void {
  rejectProxy(authority, "strong-baseline run authority");
  const probe = safeParseBaselineAttemptSequence(authority, undefined);
  if (
    !probe.success &&
    probe.error.issues.some(({ message }) =>
      message.includes("process-local strong-baseline run authority"),
    )
  ) {
    throw new TypeError("accepted strong-baseline run authority is required");
  }
}

function baselineFailureKind(outcome: BaselineAttemptEvidence["outcome"]) {
  return {
    timeout: "provider_timeout",
    refusal: "fixture_failure",
    invalid_output: "invalid_structured_output",
    provider_failure: "provider_transport",
  }[outcome as "timeout" | "refusal" | "invalid_output" | "provider_failure"];
}

function assertBaselineAttemptBindings(
  manifest: RunManifest,
  attempts: readonly RecordedAttempt[],
  evidence: readonly BaselineAttemptEvidence[],
): void {
  if (
    manifest.attemptIds.length !== attempts.length ||
    attempts.length !== evidence.length
  ) {
    throw new TypeError("baseline manifest and authorized attempts must align");
  }
  for (const [index, attempt] of attempts.entries()) {
    const accepted = evidence[index]!;
    const raw = attempt.raw;
    const parsed = attempt.parsed;
    const succeeded = accepted.outcome === "succeeded";
    const expectedParseStatus = succeeded
      ? "valid"
      : accepted.outcome === "invalid_output"
        ? "invalid"
        : "not_parsed";
    const failureKind = succeeded ? undefined : baselineFailureKind(accepted.outcome);
    if (
      manifest.attemptIds[index] !== raw.attemptId ||
      raw.runId !== accepted.runId ||
      raw.attemptId !== accepted.attemptId ||
      raw.attemptNumber !== accepted.retry.attemptNumber ||
      raw.evidenceMode !== accepted.evidenceMode ||
      raw.latencyMs !== accepted.latency.milliseconds ||
      raw.status !== (succeeded ? "succeeded" : "failed") ||
      canonicalizeJson(raw.rawOutput) !== canonicalizeJson(accepted) ||
      parsed.parseStatus !== expectedParseStatus ||
      (parsed.parseStatus === "invalid" &&
        canonicalizeJson(parsed.validationIssues) !==
          canonicalizeJson(accepted.validation.issues)) ||
      (succeeded && raw.failure !== null) ||
      (!succeeded &&
        (raw.failure === null ||
          raw.failure.kind !== failureKind ||
          raw.failure.retryable !==
            ["timeout", "invalid_output", "provider_failure"].includes(
              accepted.outcome,
            ) ||
          raw.failure.providerCode !==
            `FIXTURE_${accepted.outcome.toUpperCase()}` ||
          raw.failure.message !==
            `Authored fixture ${accepted.outcome.replaceAll("_", " ")}; no provider executed.`)) ||
      raw.request.requestedProvider !== accepted.requestedModel.provider ||
      raw.request.requestedModelId !== accepted.requestedModel.modelId
    ) {
      throw new TypeError(
        "baseline runner attempts must derive from authorized attempt evidence",
      );
    }
  }
}

function assertBaselineComparisonSource(
  input: ValidatedBaselineMetricRecordInput,
  manifest: RunManifest,
  evidence: readonly BaselineAttemptEvidence[],
): void {
  const comparison = validateMetricComparisonBinding(input.comparison);
  const candidate = comparison.candidate;
  const expectedPairId = `${candidate.caseId}-baseline-vs-${candidate.rightConditionId.replaceAll("_", "-")}-${candidate.trialId}`;
  const parent = manifest.runId === candidate.baselineEvidence.parentRunId;
  const rerun = manifest.runId === candidate.baselineEvidence.rerunRunId;
  if (
    candidate.pairId !== expectedPairId ||
    candidate.leftRunId !== `${expectedPairId}-left` ||
    candidate.leftConditionId !== "strong_baseline" ||
    candidate.caseId !== manifest.caseReference.id ||
    candidate.trialId !== manifest.trialId ||
    candidate.leftTrial.caseId !== manifest.caseReference.id ||
    candidate.leftTrial.conditionId !== manifest.conditionId ||
    candidate.leftTrial.trialId !== manifest.trialId ||
    (!parent && !rerun)
  ) {
    throw new TypeError(
      "comparison pair must bind the exact accepted strong-baseline run",
    );
  }
  const candidateEvidence = parent
    ? candidate.baselineEvidence.parentAttempts
    : candidate.baselineEvidence.rerunAttempts;
  const authorizedCandidateEvidence = parseBaselineAttemptSequence(
    input.authority,
    candidateEvidence,
  );
  if (
    canonicalizeJson(authorizedCandidateEvidence) !== canonicalizeJson(evidence)
  ) {
    throw new TypeError(
      "comparison pair baseline evidence contradicts the accepted run authority",
    );
  }
}

function baselineMetricRunRecord(
  input: ValidatedBaselineMetricRecordInput,
): MetricRunRecord {
  requireStrongBaselineRunAuthority(input.authority);
  assertPlainData(input, "baseline metric record input");
  const developmentCase = DevelopmentCaseSchema.parse(
    structuredClone(input.developmentCase),
  );
  const manifest = RunManifestSchema.parse(structuredClone(input.manifest));
  const attempts = z
    .array(RecordedAttemptSchema)
    .min(1)
    .parse(structuredClone(input.attempts));
  const evidence = parseBaselineAttemptSequence(
    input.authority,
    attempts.map(({ raw }) => raw.rawOutput),
  );
  if (
    manifest.conditionId !== "strong_baseline" ||
    manifest.caseReference.id !== developmentCase.benchmarkCase.id ||
    manifest.caseReference.version !== developmentCase.benchmarkCase.version ||
    manifest.caseReference.caseHash !== developmentCase.benchmarkCase.caseHash ||
    manifest.runId !== evidence[0]!.runId ||
    manifest.caseReference.id !== evidence[0]!.parityBinding.caseId ||
    manifest.configHash !== evidence[0]!.parityBinding.baselineConfigHash
  ) {
    throw new TypeError(
      "baseline manifest must bind the supplied case and authorized run",
    );
  }
  assertBaselineAttemptBindings(manifest, attempts, evidence);
  assertBaselineComparisonSource(input, manifest, evidence);
  return MetricRunRecordZodSchema.parse({
    schemaVersion: METRICS_VERSION,
    runId: manifest.runId,
    rerunOfRunId: manifest.rerunOfRunId,
    caseId: manifest.caseReference.id,
    conditionId: manifest.conditionId,
    trialId: manifest.trialId,
    configHash: manifest.configHash,
    evidenceMode: manifest.evidenceMode,
    reportingUse: manifest.reportingUse,
    resultClass: manifest.resultClass,
    headlineEligible: manifest.headlineEligible,
    comparison: metricComparisonValue(input.comparison),
    knownContradictions:
      developmentCase.scoringKey.knownContradictions.map(
        ({ id, contradictingChunkId }) => ({ id, contradictingChunkId }),
      ),
    attempts,
  });
}

export function createBaselineMetricRunRecord(
  input: BaselineMetricRecordInput,
): MetricRunRecord {
  rejectProxy(input, "baseline metric record input");
  const authority = requiredDataProperty(
    input,
    "authority",
    "strong-baseline run authority",
  ) as StrongBaselineRunAuthority;
  requireStrongBaselineRunAuthority(authority);
  const comparison = parseMetricComparisonBinding(
    requiredDataProperty(
      input,
      "comparison",
      "metric comparison binding",
    ) as MetricComparisonBinding,
  );
  assertPlainData(input, "baseline metric record input");
  const snapshot = Object.freeze({
    authority,
    comparison,
    developmentCase: structuredClone(input.developmentCase),
    manifest: structuredClone(input.manifest),
    attempts: structuredClone(input.attempts),
  });
  const initial = baselineMetricRunRecord(snapshot);
  acceptedComparisonPairAuthorities.add(comparison.authority);
  return issueMetricRunRecord(initial, () =>
    baselineMetricRunRecord(snapshot),
  );
}

export function createMetricTestFixtureRecord(input: unknown): MetricRunRecord {
  if (process.env.NODE_ENV !== "test") {
    throw new TypeError("metric test fixture records are available only under tests");
  }
  assertPlainData(input, "metric test fixture record");
  const snapshot = deepFreeze(
    structuredClone(MetricRunRecordZodSchema.parse(structuredClone(input))),
  );
  return issueMetricRunRecord(snapshot, () =>
    MetricRunRecordZodSchema.parse(snapshot),
  );
}

function normalizeMetricSource(input: {
  runs: readonly MetricRunRecord[];
  preRunExclusions: readonly z.input<typeof PreRunExclusionSchema>[];
}): MetricSourceSnapshot {
  assertPlainData(input, "metric artifact input");
  const runStates = input.runs
    .map((record) => {
      const parsed = parseAuthorizedMetricRunRecord(record);
      return metricRunStateByIdentity.get(parsed)!;
    })
    .sort((left, right) =>
      identityOf(left.record).localeCompare(identityOf(right.record)),
    );
  const runs = runStates.map((state) => validateMetricRunSourceState(state));
  const exclusions = input.preRunExclusions
    .map((entry) => PreRunExclusionSchema.parse(entry))
    .sort((left, right) => identityOf(left).localeCompare(identityOf(right)));
  const runIdentities = runs.map(identityOf);
  const exclusionSlots = exclusions.map(slotIdentity);
  const runSlots = new Set(runs.map(slotIdentity));
  if (
    new Set(runIdentities).size !== runIdentities.length ||
    new Set(exclusionSlots).size !== exclusionSlots.length ||
    exclusionSlots.some((slot) => runSlots.has(slot))
  ) {
    throw new TypeError("duplicate run identity across attempts or exclusions");
  }
  return Object.freeze({
    runStates: Object.freeze([...runStates]),
    exclusions: deepFreeze(structuredClone(exclusions)),
  });
}

function buildMetricArtifactFromSource(
  source: MetricSourceSnapshot,
): MetricArtifact {
  const runs = source.runStates.map((state) =>
    validateMetricRunSourceState(state),
  );
  const exclusions = source.exclusions;

  const { retainedFailedRuns, metrics } = computeMetricSet(
    runs,
    exclusions.length,
  );

  const invalidComparisons = runs
    .filter(({ comparison }) => comparison.status === "invalid")
    .map(({ runId, conditionId, comparison, attempts }) => ({
      runId,
      conditionId,
      retainedFailure: attempts.some(
        ({ raw, parsed }) =>
          raw.status === "failed" || parsed.parseStatus !== "valid",
      ),
      reasons: [...comparison.reasons].sort(),
    }))
    .sort((left, right) => left.runId.localeCompare(right.runId));
  const conditionIds = [
    ...new Set([
      ...runs.map(({ conditionId }) => conditionId),
      ...exclusions.map(({ conditionId }) => conditionId),
    ]),
  ].sort();
  const conditionMetrics = conditionIds.map((conditionId) => {
    const eligibleRuns = runs.filter(
      (record) =>
        record.conditionId === conditionId &&
        record.comparison.status === "valid",
    );
    const conditionExclusionCount = exclusions.filter(
      (exclusion) => exclusion.conditionId === conditionId,
    ).length;
    const computed = computeMetricSet(eligibleRuns, conditionExclusionCount);
    return {
      conditionId,
      comparisonEligibleRuns: eligibleRuns.length,
      retainedFailedRuns: computed.retainedFailedRuns,
      preRunExcluded: conditionExclusionCount,
      metrics: computed.metrics,
    };
  });
  const payload = MetricArtifactPayloadSchema.parse({
    schemaVersion: METRICS_VERSION,
    evidenceMode: evidenceModeFor(runs, exclusions),
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
    summary: {
      attemptedRuns: runs.length,
      retainedFailedRuns,
      preRunExcluded: exclusions.length,
      comparisonInvalidRuns: invalidComparisons.length,
    },
    metrics,
    conditionMetrics,
    exclusions,
    invalidComparisons,
  });
  const artifact = MetricArtifactZodSchema.parse({
    ...payload,
    artifactHash: canonicalSha256(payload),
  });
  return deepFreeze(structuredClone(artifact));
}

export function createDeterministicMetricArtifact(input: {
  runs: readonly MetricRunRecord[];
  preRunExclusions: readonly z.input<typeof PreRunExclusionSchema>[];
}): MetricArtifact {
  const source = normalizeMetricSource(input);
  const artifact = buildMetricArtifactFromSource(source);
  const authority = Object.freeze(
    Object.create(null),
  ) as MetricArtifactAuthority;
  const state: MetricAuthorityState = {
    authority,
    source,
    canonicalArtifact: canonicalizeJson(artifact),
    revoked: false,
  };
  artifactAuthorityByIdentity.set(artifact, state);
  metricAuthorityState.set(authority, state);
  return artifact;
}

function authorityStateFor(
  authorityInput: unknown,
  allowRevoked = false,
): MetricAuthorityState {
  if (typeof authorityInput !== "object" || authorityInput === null) {
    throw new TypeError("metric artifact authority is required");
  }
  if (isProxy(authorityInput)) {
    throw new TypeError("metric artifact authority cannot be a proxy");
  }
  const state = metricAuthorityState.get(authorityInput);
  if (!state) throw new TypeError("metric artifact authority is not recognized");
  if (state.revoked && !allowRevoked) {
    throw new TypeError("metric artifact authority is revoked");
  }
  return state;
}

function assertAuthoritySource(state: MetricAuthorityState): void {
  if (state.revoked) throw new TypeError("metric artifact authority is revoked");
  const recomputed = buildMetricArtifactFromSource(state.source);
  const canonical = canonicalizeJson(recomputed);
  if (canonical !== state.canonicalArtifact) {
    throw new TypeError(
      "metric artifact authority no longer matches its validated source records",
    );
  }
}

function parseAuthorizedMetricIdentity(
  input: unknown,
  authorityInput?: MetricArtifactAuthority,
): MetricArtifact {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("metric artifact requires authorized object identity");
  }
  if (isProxy(input)) throw new TypeError("metric artifact cannot be a proxy");
  const state = artifactAuthorityByIdentity.get(input);
  if (!state) {
    throw new TypeError(
      "metric artifact requires builder identity or retained source authority",
    );
  }
  if (authorityInput !== undefined) {
    const suppliedState = authorityStateFor(authorityInput);
    if (suppliedState !== state) {
      throw new TypeError("metric artifact authority belongs to another artifact");
    }
  }
  assertAuthoritySource(state);
  if (canonicalizeJson(input) !== state.canonicalArtifact) {
    throw new TypeError(
      "metric artifact identity contradicts its validated source records",
    );
  }
  return input as MetricArtifact;
}

export function retainMetricArtifactAuthority(
  artifact: MetricArtifact,
): MetricArtifactAuthority {
  const parsed = parseAuthorizedMetricIdentity(artifact);
  return artifactAuthorityByIdentity.get(parsed)!.authority;
}

export function revokeMetricArtifactAuthority(
  authority: MetricArtifactAuthority,
): void {
  const state = authorityStateFor(authority, true);
  if (state.revoked) throw new TypeError("metric artifact authority is revoked");
  state.revoked = true;
}

function spreadsheetSafe(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null): string {
  const text = spreadsheetSafe(value === null ? "" : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_HEADERS = Object.freeze([
  "row_type",
  "condition_id",
  "metric_id",
  "numerator",
  "denominator",
  "availability",
  "scaled_integer",
  "scale",
  "unit",
  "run_id",
  "reason",
  "note",
]);

export function buildMetricExports(
  artifactInput: MetricArtifact,
  authority?: MetricArtifactAuthority,
) {
  const artifact = parseAuthorizedMetricIdentity(artifactInput, authority);
  const rows: Array<Array<string | number | null>> = artifact.metrics.map(
    (metric) => [
      "all_attempted_metric",
      null,
      metric.id,
      metric.numerator,
      metric.denominator,
      metric.availability,
      metric.quotient?.scaledInteger ?? null,
      metric.quotient?.scale ?? null,
      metric.unit,
      null,
      metric.unavailableReason,
      metric.denominatorPolicy,
    ],
  );
  for (const condition of artifact.conditionMetrics) {
    for (const metric of condition.metrics) {
      rows.push([
        "comparison_metric",
        condition.conditionId,
        metric.id,
        metric.numerator,
        metric.denominator,
        metric.availability,
        metric.quotient?.scaledInteger ?? null,
        metric.quotient?.scale ?? null,
        metric.unit,
        null,
        metric.unavailableReason,
        metric.denominatorPolicy,
      ]);
    }
  }
  for (const exclusion of artifact.exclusions) {
    rows.push([
      "pre_run_exclusion",
      exclusion.conditionId,
      null,
      null,
      null,
      "unavailable",
      null,
      null,
      null,
      `${exclusion.caseId}/${exclusion.conditionId}/${exclusion.trialId}`,
      exclusion.reason,
      exclusion.detail,
    ]);
  }
  for (const invalid of artifact.invalidComparisons) {
    rows.push([
      "comparison_invalid",
      invalid.conditionId,
      null,
      null,
      null,
      "unavailable",
      null,
      null,
      null,
      invalid.runId,
      invalid.reasons.join("|"),
      "Attempt retained in non-comparative metrics; pairwise comparison excluded.",
    ]);
  }
  const csv = [CSV_HEADERS, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
  const chart = deepFreeze({
    schemaVersion: METRICS_VERSION,
    artifactHash: artifact.artifactHash,
    evidenceMode: artifact.evidenceMode,
    reportingUse: artifact.reportingUse,
    headlineEligible: artifact.headlineEligible,
    series: artifact.conditionMetrics.flatMap((condition) =>
      condition.metrics.map((metric) => ({
        conditionId: condition.conditionId,
        comparisonEligibleRuns: condition.comparisonEligibleRuns,
        metricId: metric.id,
        numerator: metric.numerator,
        denominator: metric.denominator,
        availability: metric.availability,
        scaledInteger: metric.quotient?.scaledInteger ?? null,
        scale: metric.quotient?.scale ?? null,
        unit: metric.unit,
      })),
    ),
  });
  return deepFreeze({
    json: canonicalizeJson(artifact),
    csv,
    chart,
    chartJson: canonicalizeJson(chart),
  });
}

export function parseMetricArtifact(
  json: string,
  authority: MetricArtifactAuthority,
): MetricArtifact {
  const state = authorityStateFor(authority);
  const parsed: unknown = JSON.parse(z.string().min(1).parse(json));
  const artifact = MetricArtifactZodSchema.parse(parsed);
  assertAuthoritySource(state);
  if (canonicalizeJson(artifact) !== state.canonicalArtifact) {
    throw new TypeError(
      "persisted metric artifact contradicts retained source authority",
    );
  }
  const frozen = deepFreeze(structuredClone(artifact));
  artifactAuthorityByIdentity.set(frozen, state);
  return frozen;
}

export const METRIC_EXCLUSION_POLICY = Object.freeze({
  allowedPreRunReasons: [...ALLOWED_EXCLUSION_REASONS],
  denominatorPolicy: DENOMINATOR_POLICY,
});
