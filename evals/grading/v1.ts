import { createHmac } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import { z } from "zod";

import { canonicalSha256, canonicalizeJson } from "../../src/contracts";
import {
  parseBaselineAttemptSequence,
  type BaselineAttemptEvidence,
  type StrongBaselineRunAuthority,
} from "../baseline/v1";
import {
  aggregateEligibleComparisons,
  assessComparisonEligibility,
  type ComparisonPairAuthority,
} from "../comparison/parity-v1";
import {
  WorkflowConditionFixtureSchema,
  type WorkflowConditionFixture,
} from "../conditions/workflow-v1";

export const BLIND_GRADING_VERSION = "1.0.0" as const;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/u);
const ConditionIdSchema = z.enum([
  "strong_baseline",
  "complete_workflow",
  "no_verification",
  "no_adversarial_review",
]);
const ConditionLabelSchema = z.enum([
  "Condition A",
  "Condition B",
  "Condition C",
  "Condition D",
]);
const AuthorizedEvidenceModeSchema = z.enum(["fixture", "simulated"]);

const REQUIRED_CONDITIONS = Object.freeze(ConditionIdSchema.options);
const CONDITION_LABELS = Object.freeze(ConditionLabelSchema.options);

class PassiveDataError extends TypeError {}

function assertUnicodeScalarControlSafe(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PassiveDataError(`${path} contains an unpaired surrogate`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new PassiveDataError(`${path} contains an unpaired surrogate`);
    }
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      throw new PassiveDataError(`${path} contains a disallowed control character`);
    }
  }
}

function snapshotPassiveData<T>(input: T): T {
  if (
    (typeof input === "object" && input !== null && utilTypes.isProxy(input)) ||
    (typeof input === "function" && utilTypes.isProxy(input))
  ) {
    throw new PassiveDataError("input must not be a proxy");
  }
  const snapshots = new WeakMap<object, unknown>();
  const visiting = new WeakSet<object>();

  function visit(value: unknown, path: string): unknown {
    if (
      value === null ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "string") {
      assertUnicodeScalarControlSafe(value, path);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new PassiveDataError(`${path} must contain finite JSON numbers`);
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new PassiveDataError(`${path} must contain passive JSON data`);
    }
    if (utilTypes.isProxy(value)) {
      throw new PassiveDataError(`${path} must not be a proxy`);
    }
    if (visiting.has(value)) {
      throw new PassiveDataError(`${path} must not contain cycles`);
    }
    const prior = snapshots.get(value);
    if (prior !== undefined) return prior;

    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      throw new PassiveDataError(`${path} could not be inspected passively`);
    }
    const isArray = Array.isArray(value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new PassiveDataError(`${path} must use an ordinary JSON prototype`);
    }
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
      throw new PassiveDataError(`${path} must not contain symbol keys`);
    }

    visiting.add(value);
    if (isArray) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new PassiveDataError(`${path} has an invalid array length`);
      }
      const output: unknown[] = [];
      snapshots.set(value, output);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new PassiveDataError(`${path}[${index}] is not passive data`);
        }
        output.push(visit(descriptor.value, `${path}[${index}]`));
      }
      const expected = new Set([
        "length",
        ...Array.from({ length }, (_, index) => String(index)),
      ]);
      if (Object.keys(descriptors).some((key) => !expected.has(key))) {
        throw new PassiveDataError(`${path} must not contain extra array fields`);
      }
      visiting.delete(value);
      return output;
    }

    const output: Record<string, unknown> = {};
    snapshots.set(value, output);
    for (const key of Object.keys(descriptors)) {
      assertUnicodeScalarControlSafe(key, `${path} key`);
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new PassiveDataError(`${path}.${key} must be passive data`);
      }
      output[key] = visit(descriptor.value, `${path}.${key}`);
    }
    visiting.delete(value);
    return output;
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

type SafeParseResult<T> =
  | { success: true; data: T; error?: never }
  | { success: false; data?: never; error: Error };

type PassiveSchema<T> = Readonly<{
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseResult<T>;
}>;

function passiveSchema<T>(schema: z.ZodType<T>): PassiveSchema<T> {
  return Object.freeze({
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        const result = schema.safeParse(snapshotPassiveData(input));
        return result.success
          ? { success: true, data: result.data }
          : { success: false, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
    parse(input: unknown): T {
      const result = this.safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

export const BLIND_GRADING_RUBRIC = deepFreeze({
  version: BLIND_GRADING_VERSION,
  definitions: {
    factual:
      "A statement presented as an externally checkable fact about a source, result, population, mechanism, or proposed experiment, excluding clearly marked questions and value judgments.",
    substantive:
      "An edit that changes a factual claim, evidence link, conclusion strength, hypothesis, variable, control, metric, confounder, safety boundary, feasibility claim, or interpretation; spelling and formatting alone are not substantive.",
    adequate:
      "An evidence link is adequate only when the displayed source passage directly supports the claim at its stated scope and strength; metadata existence alone is not adequate entailment.",
    overclaimed:
      "A conclusion is overclaimed when its certainty, causal language, population, duration, generality, or practical implication exceeds what the displayed evidence establishes.",
  },
  dimensions: {
    claimSourceEntailment:
      "Grade the relationship between each displayed factual claim and its cited passage: full support, partial support, contradiction, insufficient, unclear, or not applicable.",
    unsupportedClaim:
      "Mark whether a factual claim lacks an adequate displayed evidence link; abstain when the packet does not permit a responsible judgment.",
    overclaiming:
      "Mark whether the conclusion exceeds the displayed evidence under the overclaimed definition; preserve abstentions.",
    experimentValidity:
      "Judge whether the proposed design fields are substantively appropriate to the hypothesis, not merely present: valid, partially valid, invalid, not applicable, or abstain.",
    correctionEffort:
      "Count substantive edits needed for acceptability and optionally record elapsed minutes; absence of timing remains explicit.",
    pairedPreference:
      "Choose one opaque condition label, tie, or abstain and provide a short reason based only on displayed output quality.",
  },
} as const);

const PUBLIC_GRADER_INSTRUCTIONS =
  "Assess only the displayed claims, evidence passages, and experiment proposal. Use the rubric, treat every opaque label independently, preserve uncertainty, and do not infer condition identity." as const;

const BlindGradingRubricSchema = z
  .object({
    version: z.literal(BLIND_GRADING_VERSION),
    definitions: z
      .object({
        factual: z.literal(BLIND_GRADING_RUBRIC.definitions.factual),
        substantive: z.literal(BLIND_GRADING_RUBRIC.definitions.substantive),
        adequate: z.literal(BLIND_GRADING_RUBRIC.definitions.adequate),
        overclaimed: z.literal(BLIND_GRADING_RUBRIC.definitions.overclaimed),
      })
      .strict(),
    dimensions: z
      .object({
        claimSourceEntailment: z.literal(
          BLIND_GRADING_RUBRIC.dimensions.claimSourceEntailment,
        ),
        unsupportedClaim: z.literal(
          BLIND_GRADING_RUBRIC.dimensions.unsupportedClaim,
        ),
        overclaiming: z.literal(BLIND_GRADING_RUBRIC.dimensions.overclaiming),
        experimentValidity: z.literal(
          BLIND_GRADING_RUBRIC.dimensions.experimentValidity,
        ),
        correctionEffort: z.literal(
          BLIND_GRADING_RUBRIC.dimensions.correctionEffort,
        ),
        pairedPreference: z.literal(
          BLIND_GRADING_RUBRIC.dimensions.pairedPreference,
        ),
      })
      .strict(),
  })
  .strict();

const GradingViewSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            itemId: IdSchema,
            claimText: z.string().min(1),
            displayedEvidence: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .refine(
        (items) => new Set(items.map(({ itemId }) => itemId)).size === items.length,
        "grading item IDs must be unique",
      ),
    experiment: z.json(),
  })
  .strict();

export type BlindGradingSource = Readonly<{
  comparisonAuthority: ComparisonPairAuthority;
  comparisonRecord: unknown;
  baselineParentAuthority: StrongBaselineRunAuthority;
  baselineRerunAuthority: StrongBaselineRunAuthority;
  workflowFixture: WorkflowConditionFixture;
}>;

type SourceRunBinding = Readonly<{
  runId: string;
  attemptIds: readonly string[];
}>;

type AuthorizedBlindCandidate = Readonly<{
  conditionId: z.infer<typeof ConditionIdSchema>;
  caseId: string;
  trialId: string;
  runId: string;
  attemptId: string;
  configHash: string;
  rawOutput: unknown;
  canonicalOutput: unknown;
  gradingView: z.infer<typeof GradingViewSchema>;
  evidenceMode: z.infer<typeof AuthorizedEvidenceModeSchema>;
  sourceRunBindings: readonly SourceRunBinding[];
  comparisonBindings: readonly {
    pairId: string;
    eligibilityHash: string;
  }[];
  sourceChainHash: string;
}>;

const PacketEntrySchema = z
  .object({
    entryId: z.enum(["entry-1", "entry-2", "entry-3", "entry-4"]),
    label: ConditionLabelSchema,
    output: GradingViewSchema,
  })
  .strict();

const BlindPacketBaseSchema = z
  .object({
    schemaVersion: z.literal(BLIND_GRADING_VERSION),
    packetId: IdSchema,
    caseId: IdSchema,
    trialId: IdSchema,
    evidenceMode: z.literal("mixed_fixture_simulated"),
    status: z.literal("fixture_blind_packet_not_human_graded"),
    headlineEligible: z.literal(false),
    graderInstructions: z.literal(PUBLIC_GRADER_INSTRUCTIONS),
    rubric: BlindGradingRubricSchema,
    entries: z.array(PacketEntrySchema).length(4),
  })
  .strict()
  .superRefine((packet, context) => {
    const labels = packet.entries.map(({ label }) => label);
    if (new Set(labels).size !== 4) {
      context.addIssue({ code: "custom", path: ["entries"], message: "labels must be unique" });
    }
    if (labels.some((label, index) => label !== CONDITION_LABELS[index])) {
      context.addIssue({ code: "custom", path: ["entries"], message: "entries must use canonical opaque-label order" });
    }
  });

const BlindPacketZodSchema = BlindPacketBaseSchema;

export type BlindPacket = z.infer<typeof BlindPacketZodSchema>;
export const BlindPacketSchema = passiveSchema(BlindPacketZodSchema);

const MappingEntrySchema = z
  .object({
    label: ConditionLabelSchema,
    conditionId: ConditionIdSchema,
    runId: IdSchema,
    attemptId: IdSchema,
    configHash: HashSchema,
    rawOutputHash: HashSchema,
    canonicalOutputHash: HashSchema,
    evidenceMode: AuthorizedEvidenceModeSchema,
    sourceChainHash: HashSchema,
    sourceRunBindings: z
      .array(
        z
          .object({
            runId: IdSchema,
            attemptIds: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    comparisonBindings: z
      .array(
        z
          .object({
            pairId: IdSchema,
            eligibilityHash: HashSchema,
          })
          .strict(),
      )
      .min(1),
    itemBindings: z
      .array(
        z
          .object({
            graderItemId: IdSchema,
            sourceItemId: IdSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const ConfidentialBlindMappingBaseSchema = z
  .object({
    schemaVersion: z.literal(BLIND_GRADING_VERSION),
    mappingId: IdSchema,
    packetId: IdSchema,
    caseId: IdSchema,
    trialId: IdSchema,
    permutationCommitment: HashSchema,
    entries: z.array(MappingEntrySchema).length(4),
  })
  .strict()
  .superRefine((mapping, context) => {
    const labels = mapping.entries.map(({ label }) => label);
    const conditions = mapping.entries.map(({ conditionId }) => conditionId);
    if (
      new Set(labels).size !== 4 ||
      labels.some((label, index) => label !== CONDITION_LABELS[index])
    ) {
      context.addIssue({ code: "custom", path: ["entries"], message: "mapping labels must be unique and canonical" });
    }
    if (
      new Set(conditions).size !== 4 ||
      [...conditions].sort().join("\0") !== [...REQUIRED_CONDITIONS].sort().join("\0")
    ) {
      context.addIssue({ code: "custom", path: ["entries"], message: "mapping must contain every required condition exactly once" });
    }
    const artifactKeys = mapping.entries.map(({ runId, attemptId }) => `${runId}\0${attemptId}`);
    if (new Set(artifactKeys).size !== artifactKeys.length) {
      context.addIssue({ code: "custom", path: ["entries"], message: "artifact bindings must be unique" });
    }
    for (const [entryIndex, entry] of mapping.entries.entries()) {
      const runIds = entry.sourceRunBindings.map(({ runId }) => runId);
      const attemptIds = entry.sourceRunBindings.flatMap(({ attemptIds }) => attemptIds);
      const pairIds = entry.comparisonBindings.map(({ pairId }) => pairId);
      if (
        new Set(runIds).size !== runIds.length ||
        new Set(attemptIds).size !== attemptIds.length ||
        new Set(pairIds).size !== pairIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex],
          message: "source run, attempt, and comparison bindings must be unique",
        });
      }
      const graderIds = entry.itemBindings.map(({ graderItemId }) => graderItemId);
      const sourceIds = entry.itemBindings.map(({ sourceItemId }) => sourceItemId);
      if (
        new Set(graderIds).size !== graderIds.length ||
        new Set(sourceIds).size !== sourceIds.length ||
        graderIds.some((id, itemIndex) => id !== `item-${itemIndex + 1}`)
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "itemBindings"],
          message: "mapping item bindings must be unique and use neutral grader IDs",
        });
      }
    }
  });

const ConfidentialBlindMappingZodSchema = ConfidentialBlindMappingBaseSchema.extend({
  mappingHash: HashSchema,
})
  .strict()
  .superRefine((mapping, context) => {
    const { mappingHash, ...withoutHash } = mapping;
    if (mappingHash !== canonicalSha256(withoutHash)) {
      context.addIssue({ code: "custom", path: ["mappingHash"], message: "mappingHash mismatch" });
    }
  });

export type ConfidentialBlindMapping = z.infer<
  typeof ConfidentialBlindMappingZodSchema
>;

declare const blindMappingAuthorityBrand: unique symbol;
export type BlindMappingAuthority = Readonly<{
  [blindMappingAuthorityBrand]: "BlindMappingAuthority";
}>;

type TrustedMappingAuthority = Readonly<{
  packetBytes: string;
  mappingBytes: string;
  mappingId: string;
  sourceChainBytes: string;
  sourceAuthorities: readonly TrustedSourceAuthorities[];
}>;

type TrustedSourceAuthorities = Readonly<{
  comparisonAuthority: object;
  baselineParentAuthority: object;
  baselineRerunAuthority: object;
  workflowFixture: object;
}>;

const trustedMappingsByAuthority = new WeakMap<object, TrustedMappingAuthority>();

function issueMappingAuthority(
  packet: BlindPacket,
  mapping: ConfidentialBlindMapping,
  sourceChainBytes: string,
  sourceAuthorities: readonly TrustedSourceAuthorities[],
): BlindMappingAuthority {
  const authority = Object.freeze({}) as BlindMappingAuthority;
  trustedMappingsByAuthority.set(authority, {
    packetBytes: canonicalizeJson(packet),
    mappingBytes: canonicalizeJson(mapping),
    mappingId: mapping.mappingId,
    sourceChainBytes,
    sourceAuthorities,
  });
  return authority;
}

function trustedMappingAuthority(input: unknown): TrustedMappingAuthority {
  if (
    typeof input !== "object" ||
    input === null ||
    utilTypes.isProxy(input)
  ) {
    throw new TypeError("mapping authority must be the exact issued capability");
  }
  const trusted = trustedMappingsByAuthority.get(input);
  if (!trusted) {
    throw new TypeError("mapping authority must be the exact issued capability");
  }
  return trusted;
}

function keyedOrder(
  fixtureSeed: string,
  packetId: string,
  packetNonce: string,
  caseId: string,
  trialId: string,
  conditionId: string,
) {
  return createHmac("sha256", fixtureSeed)
    .update(
      `evidenceforge-blind-grading-permutation-v1\0${packetId}\0${packetNonce}\0${caseId}\0${trialId}\0${conditionId}`,
      "utf8",
    )
    .digest("hex");
}

function normalizedLeakText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function assertNoMetadataLeak(
  packet: BlindPacket,
  candidates: readonly AuthorizedBlindCandidate[],
): void {
  const privateValues = candidates.flatMap((candidate) => [
    candidate.conditionId,
    candidate.runId,
    candidate.attemptId,
    candidate.configHash,
    canonicalSha256(candidate.rawOutput),
    canonicalSha256(candidate.canonicalOutput),
    ...candidate.gradingView.items.map(({ itemId }) => itemId),
  ]);
  const graderBytes = canonicalizeJson(packet);
  const normalizedGraderBytes = normalizedLeakText(graderBytes);
  const conditionAliases = [
    "strong baseline",
    "complete workflow",
    "no verification",
    "no adversarial review",
    "no review",
    "strongbaseline",
    "completeworkflow",
    "noverification",
    "noadversarialreview",
    "noreview",
  ];
  if (
    /[a-f0-9]{64}/iu.test(graderBytes) ||
    privateValues.some((value) => graderBytes.includes(value)) ||
    [...conditionAliases, ...REQUIRED_CONDITIONS]
      .map(normalizedLeakText)
      .filter((value) => value.length > 0)
      .some((value) => normalizedGraderBytes.includes(value))
  ) {
    throw new TypeError("grader-visible packet would leak condition or private artifact metadata");
  }
}

function captureExactDataObject(
  input: unknown,
  expectedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    utilTypes.isProxy(input)
  ) {
    throw new TypeError(`${path} must be a passive ordinary object`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new TypeError(`${path} could not be inspected passively`);
  }
  if (prototype !== Object.prototype) {
    throw new TypeError(`${path} must be a passive ordinary object`);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw new TypeError(`${path} must not contain symbol keys`);
  }
  const expected = new Set(expectedKeys);
  if (
    Object.keys(descriptors).length !== expected.size ||
    Object.keys(descriptors).some((key) => !expected.has(key))
  ) {
    throw new TypeError(`${path} fields do not match the accepted boundary`);
  }
  const values: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function captureSourceArray(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    utilTypes.isProxy(input) ||
    !Array.isArray(input)
  ) {
    throw new TypeError("sources must be a passive three-entry array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    input,
  ) as unknown as PropertyDescriptorMap;
  const length = descriptors.length?.value;
  if (length !== 3) {
    throw new TypeError("sources must contain the three accepted comparison pairs");
  }
  const expected = new Set(["0", "1", "2", "length"]);
  if (Object.keys(descriptors).some((key) => !expected.has(key))) {
    throw new TypeError("sources must not contain extra array fields");
  }
  return [0, 1, 2].map((index) => {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(`sources[${index}] must be an enumerable data property`);
    }
    return captureExactDataObject(
      descriptor.value,
      [
        "comparisonAuthority",
        "comparisonRecord",
        "baselineParentAuthority",
        "baselineRerunAuthority",
        "workflowFixture",
      ],
      `sources[${index}]`,
    );
  });
}

function workflowGradingView(
  fixture: WorkflowConditionFixture,
): z.infer<typeof GradingViewSchema> {
  const canonicalRun = fixture.attempts[0]!.parsed.canonicalRun;
  if (canonicalRun === null) {
    throw new TypeError("accepted workflow source has no canonical run");
  }
  return GradingViewSchema.parse({
    items: canonicalRun.claims.map((claim) => {
      const passages = canonicalRun.evidenceCards
        .filter(({ subclaimId }) => subclaimId === claim.id)
        .map(({ excerpt }) => excerpt);
      return {
        itemId: claim.id,
        claimText: claim.statement,
        displayedEvidence:
          passages.length === 0
            ? "No displayed evidence passage was produced."
            : passages.join(" — "),
      };
    }),
    experiment:
      canonicalRun.experiment ?? {
        status: "abstained",
        abstention: canonicalRun.experimentAbstention,
      },
  });
}

function baselineGradingView(): z.infer<typeof GradingViewSchema> {
  return GradingViewSchema.parse({
    items: [
      {
        itemId: "baseline-output-availability",
        claimText: "No gradeable factual claim was produced.",
        displayedEvidence:
          "The authorized source recorded no schema-valid canonical output for this entry.",
      },
    ],
    experiment: {
      status: "unavailable",
      reason: "no_valid_canonical_output",
    },
  });
}

function runBindings(attempts: readonly BaselineAttemptEvidence[]) {
  return {
    runId: attempts[0]!.runId,
    attemptIds: attempts.map(({ attemptId }) => attemptId),
  };
}

function resolveAuthorizedSources(input: unknown): {
  candidates: AuthorizedBlindCandidate[];
  sourceChainBytes: string;
  sourceAuthorities: TrustedSourceAuthorities[];
} {
  const sourceEnvelopes = captureSourceArray(input);
  const resolved = sourceEnvelopes.map((source, index) => {
    const comparisonAuthority = source.comparisonAuthority as ComparisonPairAuthority;
    const assessment = assessComparisonEligibility(
      comparisonAuthority,
      source.comparisonRecord,
    );
    try {
      aggregateEligibleComparisons([assessment]);
    } catch {
      throw new TypeError(`sources[${index}] requires an exact issued comparison authority`);
    }
    if (
      !assessment.eligible ||
      assessment.excludedFromAggregates ||
      assessment.pairId === null ||
      assessment.leftConfigHash === null ||
      assessment.rightConfigHash === null ||
      assessment.preservedEvidence === null
    ) {
      throw new TypeError(`sources[${index}] comparison is not eligible`);
    }

    const workflowFixture = WorkflowConditionFixtureSchema.parse(
      source.workflowFixture,
    );
    const preserved = assessment.preservedEvidence;
    const parentAttempts = parseBaselineAttemptSequence(
      source.baselineParentAuthority as StrongBaselineRunAuthority,
      preserved.baseline.parentAttempts,
    );
    const rerunAttempts = parseBaselineAttemptSequence(
      source.baselineRerunAuthority as StrongBaselineRunAuthority,
      preserved.baseline.rerunAttempts,
    );
    const workflowAttempt = workflowFixture.attempts[0]!;
    const canonicalRun = workflowAttempt.parsed.canonicalRun;
    const workflowEvidence = {
      runId: workflowFixture.runConfig.runId,
      fixtureHash: workflowFixture.fixtureHash,
      conditionSpecHash: workflowFixture.condition.specHash,
      attempts: workflowFixture.attempts,
      errors: canonicalRun?.errors ?? [],
    };
    const conditionId = workflowFixture.condition.id;
    const caseId = workflowFixture.developmentCase.benchmarkCase.id;
    const trialId = workflowFixture.runConfig.trialId;
    const expectedPairId = `${caseId}-baseline-vs-${conditionId.replaceAll("_", "-")}-${trialId}`;
    const baselineConfigHashes = [...parentAttempts, ...rerunAttempts].map(
      ({ parityBinding }) => parityBinding.baselineConfigHash,
    );
    if (
      assessment.pairId !== expectedPairId ||
      baselineConfigHashes.some(
        (configHash) => configHash !== assessment.leftConfigHash,
      ) ||
      preserved.baseline.parentRunId !== parentAttempts[0]!.runId ||
      preserved.baseline.rerunRunId !== rerunAttempts[0]!.runId ||
      canonicalizeJson(preserved.workflow) !==
        canonicalizeJson(workflowEvidence)
    ) {
      throw new TypeError(
        `sources[${index}] upstream case, condition, trial, run, config, or evidence binding drifted`,
      );
    }
    return {
      comparisonAuthority: source.comparisonAuthority as object,
      baselineParentAuthority: source.baselineParentAuthority as object,
      baselineRerunAuthority: source.baselineRerunAuthority as object,
      workflowFixtureAuthority: source.workflowFixture as object,
      assessment,
      parentAttempts,
      rerunAttempts,
      workflowFixture,
      conditionId,
      caseId,
      trialId,
    };
  });

  resolved.sort((left, right) => left.conditionId.localeCompare(right.conditionId));
  if (
    new Set(resolved.map(({ conditionId }) => conditionId)).size !== 3 ||
    resolved.some(
      ({ conditionId }, index) =>
        conditionId !== [
          "complete_workflow",
          "no_adversarial_review",
          "no_verification",
        ][index],
    )
  ) {
    throw new TypeError("sources must contain every accepted workflow condition once");
  }
  const first = resolved[0]!;
  const baselineBytes = canonicalizeJson({
    parent: first.parentAttempts,
    rerun: first.rerunAttempts,
  });
  if (
    resolved.some(
      (source) =>
        source.caseId !== first.caseId ||
        source.trialId !== first.trialId ||
        source.baselineParentAuthority !== first.baselineParentAuthority ||
        source.baselineRerunAuthority !== first.baselineRerunAuthority ||
        source.assessment.leftConfigHash !== first.assessment.leftConfigHash ||
        canonicalizeJson({
          parent: source.parentAttempts,
          rerun: source.rerunAttempts,
        }) !== baselineBytes,
    )
  ) {
    throw new TypeError("sources must share one exact case, trial, and baseline authority chain");
  }

  const baselineRawOutput = {
    parentAttempts: first.parentAttempts,
    rerunAttempts: first.rerunAttempts,
  };
  const baselineCanonicalOutput = {
    parentAttempts: first.parentAttempts.map(({ canonicalOutput }) => canonicalOutput),
    rerunAttempts: first.rerunAttempts.map(({ canonicalOutput }) => canonicalOutput),
  };
  const baselineRunBindings = [
    runBindings(first.parentAttempts),
    runBindings(first.rerunAttempts),
  ];
  const baselineComparisonBindings = resolved.map(({ assessment }) => ({
    pairId: assessment.pairId!,
    eligibilityHash: canonicalSha256(assessment),
  }));
  const baselineCandidateBase = {
    conditionId: "strong_baseline" as const,
    caseId: first.caseId,
    trialId: first.trialId,
    runId: first.parentAttempts[0]!.runId,
    attemptId: first.parentAttempts.at(-1)!.attemptId,
    configHash: first.assessment.leftConfigHash!,
    rawOutput: baselineRawOutput,
    canonicalOutput: baselineCanonicalOutput,
    gradingView: baselineGradingView(),
    evidenceMode: "fixture" as const,
    sourceRunBindings: baselineRunBindings,
    comparisonBindings: baselineComparisonBindings,
  };
  const baselineCandidate: AuthorizedBlindCandidate = {
    ...baselineCandidateBase,
    sourceChainHash: canonicalSha256(baselineCandidateBase),
  };
  const workflowCandidates: AuthorizedBlindCandidate[] = resolved.map((source) => {
    const attempt = source.workflowFixture.attempts[0]!;
    const candidateBase = {
      conditionId: source.conditionId,
      caseId: source.caseId,
      trialId: source.trialId,
      runId: source.workflowFixture.runConfig.runId,
      attemptId: attempt.raw.attemptId,
      configHash: source.assessment.rightConfigHash!,
      rawOutput: attempt.raw.rawOutput,
      canonicalOutput: attempt.parsed.canonicalRun,
      gradingView: workflowGradingView(source.workflowFixture),
      evidenceMode: "simulated" as const,
      sourceRunBindings: [
        {
          runId: source.workflowFixture.runConfig.runId,
          attemptIds: [attempt.raw.attemptId],
        },
      ],
      comparisonBindings: [
        {
          pairId: source.assessment.pairId!,
          eligibilityHash: canonicalSha256(source.assessment),
        },
      ],
    };
    return {
      ...candidateBase,
      sourceChainHash: canonicalSha256(candidateBase),
    };
  });
  const candidates = [baselineCandidate, ...workflowCandidates];
  return {
    candidates,
    sourceChainBytes: canonicalizeJson(candidates),
    sourceAuthorities: resolved.map((source) => ({
      comparisonAuthority: source.comparisonAuthority,
      baselineParentAuthority: source.baselineParentAuthority,
      baselineRerunAuthority: source.baselineRerunAuthority,
      workflowFixture: source.workflowFixtureAuthority,
    })),
  };
}

export function createBlindGradingPacket(input: unknown): {
  packet: BlindPacket;
  mapping: ConfidentialBlindMapping;
  authority: BlindMappingAuthority;
} {
  const captured = captureExactDataObject(
    input,
    ["packetId", "fixtureSeed", "packetNonce", "sources"],
    "packet creator input",
  );
  const parsed = z
    .object({
      packetId: IdSchema,
      fixtureSeed: HashSchema,
      packetNonce: HashSchema,
    })
    .strict()
    .parse(
      snapshotPassiveData({
        packetId: captured.packetId,
        fixtureSeed: captured.fixtureSeed,
        packetNonce: captured.packetNonce,
      }),
    );
  const resolved = resolveAuthorizedSources(captured.sources);
  const candidates = resolved.candidates;
  const caseId = candidates[0]!.caseId;
  const trialId = candidates[0]!.trialId;
  const conditions = candidates.map(({ conditionId }) => conditionId);
  if (
    new Set(conditions).size !== 4 ||
    [...conditions].sort().join("\0") !== [...REQUIRED_CONDITIONS].sort().join("\0")
  ) {
    throw new TypeError("blind packet requires every benchmark condition exactly once");
  }
  if (
    candidates.some(
      ({ caseId, trialId }) =>
        caseId !== candidates[0]!.caseId || trialId !== candidates[0]!.trialId,
    )
  ) {
    throw new TypeError("blind packet candidates must bind the exact case and trial");
  }
  const artifactKeys = candidates.map(
    ({ runId, attemptId }) => `${runId}\0${attemptId}`,
  );
  const runIds = candidates.map(({ runId }) => runId);
  const attemptIds = candidates.map(({ attemptId }) => attemptId);
  if (
    new Set(artifactKeys).size !== artifactKeys.length ||
    new Set(runIds).size !== runIds.length ||
    new Set(attemptIds).size !== attemptIds.length
  ) {
    throw new TypeError("blind packet candidates must bind distinct run attempts");
  }
  const ordered = [...candidates].sort((left, right) => {
    const order = keyedOrder(
      parsed.fixtureSeed,
      parsed.packetId,
      parsed.packetNonce,
      caseId,
      trialId,
      left.conditionId,
    ).localeCompare(
      keyedOrder(
        parsed.fixtureSeed,
        parsed.packetId,
        parsed.packetNonce,
        caseId,
        trialId,
        right.conditionId,
      ),
    );
    return order || left.conditionId.localeCompare(right.conditionId);
  });
  const packet = BlindPacketZodSchema.parse(snapshotPassiveData({
    schemaVersion: BLIND_GRADING_VERSION,
    packetId: parsed.packetId,
    caseId,
    trialId,
    evidenceMode: "mixed_fixture_simulated",
    status: "fixture_blind_packet_not_human_graded",
    headlineEligible: false,
    graderInstructions: PUBLIC_GRADER_INSTRUCTIONS,
    rubric: BLIND_GRADING_RUBRIC,
    entries: ordered.map((candidate, index) => ({
      entryId: `entry-${index + 1}`,
      label: CONDITION_LABELS[index],
      output: {
        items: candidate.gradingView.items.map((item, itemIndex) => ({
          itemId: `item-${itemIndex + 1}`,
          claimText: item.claimText,
          displayedEvidence: item.displayedEvidence,
        })),
        experiment: candidate.gradingView.experiment,
      },
    })),
  }));
  assertNoMetadataLeak(packet, candidates);

  const mappingEntries = ordered.map((candidate, index) => ({
    label: CONDITION_LABELS[index],
    conditionId: candidate.conditionId,
    runId: candidate.runId,
    attemptId: candidate.attemptId,
    configHash: candidate.configHash,
    rawOutputHash: canonicalSha256(candidate.rawOutput),
    canonicalOutputHash: canonicalSha256(candidate.canonicalOutput),
    evidenceMode: candidate.evidenceMode,
    sourceChainHash: candidate.sourceChainHash,
    sourceRunBindings: candidate.sourceRunBindings,
    comparisonBindings: candidate.comparisonBindings,
    itemBindings: candidate.gradingView.items.map(({ itemId }, itemIndex) => ({
      graderItemId: `item-${itemIndex + 1}`,
      sourceItemId: itemId,
    })),
  }));
  const permutationCommitment = canonicalSha256({
    fixtureSeed: parsed.fixtureSeed,
    packetId: parsed.packetId,
    packetNonce: parsed.packetNonce,
    caseId,
    trialId,
    orderedConditions: mappingEntries.map(({ conditionId }) => conditionId),
  });
  const mappingId = `mapping-${canonicalSha256({
    packetId: parsed.packetId,
    packetNonce: parsed.packetNonce,
    permutationCommitment,
    entries: mappingEntries,
  }).slice(0, 32)}`;
  const mappingWithoutHash = ConfidentialBlindMappingBaseSchema.parse({
    schemaVersion: BLIND_GRADING_VERSION,
    mappingId,
    packetId: packet.packetId,
    caseId: packet.caseId,
    trialId: packet.trialId,
    permutationCommitment,
    entries: mappingEntries,
  });
  const mapping = ConfidentialBlindMappingZodSchema.parse({
    ...mappingWithoutHash,
    mappingHash: canonicalSha256(mappingWithoutHash),
  });
  const authority = issueMappingAuthority(
    packet,
    mapping,
    resolved.sourceChainBytes,
    resolved.sourceAuthorities,
  );
  return deepFreeze({ packet, mapping, authority });
}

const ItemAnnotationSchema = z
  .object({
    itemId: IdSchema,
    claimSourceEntailment: z.enum([
      "full_support",
      "partial_support",
      "contradicts",
      "insufficient",
      "unclear",
      "not_applicable",
      "abstain",
    ]),
    unsupportedClaim: z.union([z.boolean(), z.literal("abstain")]),
    overclaiming: z.union([z.boolean(), z.literal("abstain")]),
    note: z.string().min(1),
  })
  .strict();

const EntryAnnotationSchema = z
  .object({
    label: ConditionLabelSchema,
    itemAnnotations: z
      .array(ItemAnnotationSchema)
      .min(1)
      .refine(
        (items) => new Set(items.map(({ itemId }) => itemId)).size === items.length,
        "annotation item IDs must be unique",
      ),
    experimentValidity: z.enum([
      "valid",
      "partially_valid",
      "invalid",
      "not_applicable",
      "abstain",
    ]),
    correctionEffort: z
      .object({
        substantiveEditCount: z.number().int().nonnegative(),
        minutes: z.number().nonnegative().nullable(),
        note: z.string().min(1),
      })
      .strict(),
    note: z.string().min(1),
  })
  .strict();

const BlindAnnotationZodSchema = z
  .object({
    schemaVersion: z.literal(BLIND_GRADING_VERSION),
    annotationId: IdSchema,
    packetId: IdSchema,
    grader: z
      .object({
        graderId: IdSchema,
        declaredExpertise: z.string().min(1),
      })
      .strict(),
    submittedAt: z.iso.datetime({ offset: true }),
    entryAnnotations: z.array(EntryAnnotationSchema).length(4),
    pairedPreference: z
      .object({
        preferredLabel: z.union([
          ConditionLabelSchema,
          z.literal("tie"),
          z.literal("abstain"),
        ]),
        reason: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((annotation, context) => {
    const labels = annotation.entryAnnotations.map(({ label }) => label);
    if (
      new Set(labels).size !== 4 ||
      [...labels].sort().join("\0") !== [...CONDITION_LABELS].sort().join("\0")
    ) {
      context.addIssue({ code: "custom", path: ["entryAnnotations"], message: "annotation must grade every opaque label exactly once" });
    }
  });

export type BlindAnnotation = z.infer<typeof BlindAnnotationZodSchema>;
export const BlindAnnotationSchema = passiveSchema(BlindAnnotationZodSchema);

function assertPacketMappingRelationship(
  packet: BlindPacket,
  mapping: ConfidentialBlindMapping,
  trusted: TrustedMappingAuthority,
): void {
  if (
    mapping.packetId !== packet.packetId ||
    mapping.caseId !== packet.caseId ||
    mapping.trialId !== packet.trialId
  ) {
    throw new TypeError("confidential mapping does not bind the exact blind packet");
  }
  if (
    trusted.packetBytes !== canonicalizeJson(packet) ||
    trusted.mappingBytes !== canonicalizeJson(mapping) ||
    trusted.mappingId !== mapping.mappingId
  ) {
    throw new TypeError("packet or mapping does not match the issued authority");
  }
  for (let index = 0; index < packet.entries.length; index += 1) {
    if (packet.entries[index]!.label !== mapping.entries[index]!.label) {
      throw new TypeError("confidential mapping label order does not match the blind packet");
    }
  }
}

function assertAnnotationRelationship(
  packet: BlindPacket,
  annotation: BlindAnnotation,
): void {
  if (annotation.packetId !== packet.packetId) {
    throw new TypeError("annotation does not bind the exact blind packet");
  }
  for (const packetEntry of packet.entries) {
    const entryAnnotation = annotation.entryAnnotations.find(
      ({ label }) => label === packetEntry.label,
    );
    const expectedItemIds = packetEntry.output.items
      .map(({ itemId }) => itemId)
      .sort();
    const observedItemIds = entryAnnotation?.itemAnnotations
      .map(({ itemId }) => itemId)
      .sort();
    if (
      entryAnnotation === undefined ||
      observedItemIds?.join("\0") !== expectedItemIds.join("\0")
    ) {
      throw new TypeError("annotation must grade every exact packet item once");
    }
  }
}

const ImportedAnnotationBaseSchema = z
  .object({
    schemaVersion: z.literal(BLIND_GRADING_VERSION),
    status: z.literal("simulated_annotation_only"),
    evidenceMode: z.literal("simulated"),
    headlineEligible: z.literal(false),
    packetId: IdSchema,
    mappingId: IdSchema,
    mappingHash: HashSchema,
    annotation: BlindAnnotationZodSchema,
    bindings: z.array(MappingEntrySchema).length(4),
  })
  .strict();

const ImportedAnnotationSchema = ImportedAnnotationBaseSchema.extend({
  importHash: HashSchema,
})
  .strict()
  .superRefine((record, context) => {
    const { importHash, ...withoutHash } = record;
    if (importHash !== canonicalSha256(withoutHash)) {
      context.addIssue({ code: "custom", path: ["importHash"], message: "importHash mismatch" });
    }
  });

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function captureCapabilityEnvelope(
  input: unknown,
  dataKeys: readonly string[],
): { authority: unknown; data: Record<string, unknown> } {
  if (
    typeof input !== "object" ||
    input === null ||
    utilTypes.isProxy(input)
  ) {
    throw new TypeError("capability envelope must be a passive ordinary object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype) {
    throw new TypeError("capability envelope must be a passive ordinary object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw new TypeError("capability envelope must not contain symbol keys");
  }
  const expectedKeys = new Set([...dataKeys, "authority"]);
  if (
    Object.keys(descriptors).length !== expectedKeys.size ||
    Object.keys(descriptors).some((key) => !expectedKeys.has(key))
  ) {
    throw new TypeError("capability envelope fields do not match the accepted boundary");
  }
  const data: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("capability envelope must contain passive data properties");
    }
    if (key !== "authority") data[key] = descriptor.value;
  }
  return { authority: descriptors.authority!.value, data };
}

function assertRetainedUpstreamSources(
  sources: unknown,
  trusted: TrustedMappingAuthority,
): void {
  const captured = captureSourceArray(sources);
  const retained = captured.every((source) =>
    trusted.sourceAuthorities.some(
      (expected) =>
        source.comparisonAuthority === expected.comparisonAuthority &&
        source.baselineParentAuthority === expected.baselineParentAuthority &&
        source.baselineRerunAuthority === expected.baselineRerunAuthority &&
        source.workflowFixture === expected.workflowFixture,
    ),
  );
  if (!retained) {
    throw new TypeError(
      "upstream source authorities must be the exact retained capabilities",
    );
  }
  const resolved = resolveAuthorizedSources(sources);
  if (
    resolved.sourceChainBytes !== trusted.sourceChainBytes ||
    resolved.sourceAuthorities.length !== trusted.sourceAuthorities.length ||
    resolved.sourceAuthorities.some((source, index) => {
      const expected = trusted.sourceAuthorities[index]!;
      return (
        source.comparisonAuthority !== expected.comparisonAuthority ||
        source.baselineParentAuthority !== expected.baselineParentAuthority ||
        source.baselineRerunAuthority !== expected.baselineRerunAuthority ||
        source.workflowFixture !== expected.workflowFixture
      );
    })
  ) {
    throw new TypeError(
      "upstream source chain does not match the mapping authority",
    );
  }
}

async function ensureAnnotationDirectory(
  artifactRootInput: string,
  segments: readonly string[],
): Promise<string> {
  const artifactRoot = resolve(z.string().min(1).parse(artifactRootInput));
  await mkdir(artifactRoot, { recursive: true });
  const canonicalRoot = await realpath(artifactRoot);
  let current = canonicalRoot;
  for (const segment of segments) {
    const next = join(current, segment);
    try {
      const stat = await lstat(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError("annotation path must contain ordinary directories only");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(next);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const stat = await lstat(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError("annotation path changed during creation");
      }
    }
    const canonicalNext = await realpath(next);
    const descendant = relative(canonicalRoot, canonicalNext);
    if (descendant.startsWith("..") || isAbsolute(descendant)) {
      throw new TypeError("annotation path escaped the artifact root");
    }
    current = canonicalNext;
  }
  return current;
}

export async function importBlindAnnotation(input: {
  artifactRoot: string;
  authority: BlindMappingAuthority;
  sources: readonly BlindGradingSource[];
  packet: unknown;
  mapping: unknown;
  annotation: unknown;
}): Promise<{ status: "created" | "already_present"; path: string; importHash: string }> {
  const captured = captureCapabilityEnvelope(input, [
    "artifactRoot",
    "packet",
    "mapping",
    "annotation",
    "sources",
  ]);
  const trusted = trustedMappingAuthority(captured.authority);
  assertRetainedUpstreamSources(captured.data.sources, trusted);
  const envelope = z
    .object({
      artifactRoot: z.string().min(1),
      packet: z.unknown(),
      mapping: z.unknown(),
      annotation: z.unknown(),
    })
    .strict()
    .parse(
      snapshotPassiveData({
        artifactRoot: captured.data.artifactRoot,
        packet: captured.data.packet,
        mapping: captured.data.mapping,
        annotation: captured.data.annotation,
      }),
    );
  const packet = BlindPacketSchema.parse(envelope.packet);
  const mapping = ConfidentialBlindMappingZodSchema.parse(envelope.mapping);
  const annotation = BlindAnnotationSchema.parse(envelope.annotation);
  assertPacketMappingRelationship(packet, mapping, trusted);
  assertAnnotationRelationship(packet, annotation);

  const withoutHash = ImportedAnnotationBaseSchema.parse({
    schemaVersion: BLIND_GRADING_VERSION,
    status: "simulated_annotation_only",
    evidenceMode: "simulated",
    headlineEligible: false,
    packetId: packet.packetId,
    mappingId: mapping.mappingId,
    mappingHash: mapping.mappingHash,
    annotation,
    bindings: mapping.entries,
  });
  const record = ImportedAnnotationSchema.parse({
    ...withoutHash,
    importHash: canonicalSha256(withoutHash),
  });
  const directory = await ensureAnnotationDirectory(envelope.artifactRoot, [
    "annotation-imports",
    BLIND_GRADING_VERSION,
    packet.packetId,
    annotation.grader.graderId,
  ]);
  const path = join(directory, `${annotation.annotationId}.json`);
  const bytes = `${canonicalizeJson(record)}\n`;
  try {
    await writeFile(path, bytes, { encoding: "utf8", flag: "wx" });
    return { status: "created", path, importHash: record.importHash };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) {
      throw new Error("annotation import conflicts with an immutable existing record");
    }
    return { status: "already_present", path, importHash: record.importHash };
  }
}

export function summarizeBlindAnnotations(input: unknown) {
  const captured = captureCapabilityEnvelope(input, [
    "packet",
    "mapping",
    "expectedGraderIds",
    "annotations",
    "sources",
  ]);
  const trusted = trustedMappingAuthority(captured.authority);
  assertRetainedUpstreamSources(captured.data.sources, trusted);
  const parsed = z
    .object({
      packet: z.unknown(),
      mapping: z.unknown(),
      expectedGraderIds: z.array(IdSchema).min(1),
      annotations: z.array(z.unknown()),
    })
    .strict()
    .parse(
      snapshotPassiveData({
        packet: captured.data.packet,
        mapping: captured.data.mapping,
        expectedGraderIds: captured.data.expectedGraderIds,
        annotations: captured.data.annotations,
      }),
    );
  const packet = BlindPacketSchema.parse(parsed.packet);
  const mapping = ConfidentialBlindMappingZodSchema.parse(parsed.mapping);
  assertPacketMappingRelationship(packet, mapping, trusted);
  const annotations = parsed.annotations.map((value) =>
    BlindAnnotationSchema.parse(value),
  );
  for (const value of annotations) assertAnnotationRelationship(packet, value);

  const annotationIds = annotations.map(({ annotationId }) => annotationId);
  if (new Set(annotationIds).size !== annotationIds.length) {
    throw new TypeError("duplicate annotation ID");
  }
  const graderIds = annotations.map(({ grader }) => grader.graderId);
  if (new Set(graderIds).size !== graderIds.length) {
    throw new TypeError("duplicate grader records are not silently reconciled");
  }
  if (new Set(parsed.expectedGraderIds).size !== parsed.expectedGraderIds.length) {
    throw new TypeError("expected grader IDs must be unique");
  }
  const expected = new Set(parsed.expectedGraderIds);
  if (graderIds.some((graderId) => !expected.has(graderId))) {
    throw new TypeError("annotation came from an undeclared grader ID");
  }
  const observed = new Set(graderIds);
  const missingGraderIds = parsed.expectedGraderIds.filter(
    (graderId) => !observed.has(graderId),
  );

  return deepFreeze({
    schemaVersion: BLIND_GRADING_VERSION,
    packetId: packet.packetId,
    mappingId: mapping.mappingId,
    evidenceMode: "simulated" as const,
    annotationSource: "authored_fixture_not_human" as const,
    headlineEligible: false as const,
    graderCount: annotations.length,
    graders: annotations.map(({ grader }) => grader),
    annotations,
    missingGraderIds,
    gradingComplete: false as const,
    blockers: [
      "human_grading_not_completed" as const,
      ...(missingGraderIds.length === 0
        ? []
        : (["missing_grader_annotations"] as const)),
    ],
  });
}
