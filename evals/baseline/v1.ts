import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  ResearchRunSchema,
  canonicalSha256,
  canonicalizeJson,
  freezePacket,
} from "../../src/contracts";
import { buildStrongBaselineRequest } from "../../src/server/prompts/baseline";
import {
  StrongBaselineOutputSchema,
  parsePromptInput,
  promptRegistry,
} from "../../src/server/prompts/registry";
import {
  DEVELOPMENT_CASES,
  DevelopmentCaseSchema,
  type DevelopmentCase,
} from "../cases/development-v1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  BenchmarkConfigSchema,
  assessComparisonPair,
  createBenchmarkConfig,
} from "../protocol/v1";
import {
  EVAL_RUNNER_VERSION,
  EvalRunConfigSchema,
  RunManifestSchema,
  createRequestMetadata,
  materializeFixtureRun,
  type RecordedAttempt,
} from "../runner/v1";

export const STRONG_BASELINE_PARITY_VERSION = "1.0.0" as const;

const BENCHMARK_CODE_BASE =
  "1bb3f08db608a9a210aa03ad8466ae3867fbc981";
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

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
        throw new PassiveDataError(`${path} must contain only finite JSON numbers`);
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new PassiveDataError(`${path} must contain only passive JSON data`);
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
      throw new PassiveDataError(`${path} must use only ordinary object or array prototypes`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
      throw new PassiveDataError(`${path} must not contain symbol keys`);
    }

    visiting.add(value);
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new PassiveDataError(`${path} has an invalid passive array length`);
      }
      const result: unknown[] = [];
      snapshots.set(value, result);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new PassiveDataError(`${path}[${index}] must be an enumerable data property`);
        }
        result.push(visit(descriptor.value, `${path}[${index}]`));
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
      ]);
      if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) {
        throw new PassiveDataError(`${path} must not contain extra array properties`);
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
        throw new PassiveDataError(`${path}.${key} must be an enumerable data property`);
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

function deepFreezeSnapshot<T>(input: T, seen = new WeakSet<object>()): T {
  if (typeof input !== "object" || input === null || seen.has(input)) {
    return input;
  }
  seen.add(input);
  for (const value of Object.values(input)) {
    deepFreezeSnapshot(value, seen);
  }
  return Object.freeze(input);
}

type PassiveSafeParseResult<T> =
  | { success: true; data: T; error?: never }
  | { success: false; data?: never; error: z.ZodError };

type PassiveSchema<T> = {
  parse(input: unknown): T;
  safeParse(input: unknown): PassiveSafeParseResult<T>;
};

function passiveSchema<T>(schema: z.ZodType<T>): PassiveSchema<T> {
  const safeParse = (input: unknown): PassiveSafeParseResult<T> => {
    try {
      return schema.safeParse(passiveDataSnapshot(input));
    } catch (error) {
      if (!(error instanceof PassiveDataError)) throw error;
      return z.never({ error: error.message }).safeParse(undefined) as PassiveSafeParseResult<T>;
    }
  };
  return Object.freeze({
    safeParse,
    parse(input: unknown) {
      const result = safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

const TRUSTED_DEVELOPMENT_CASES = deepFreezeSnapshot(
  passiveDataSnapshot(DEVELOPMENT_CASES),
);
const TRUSTED_DEVELOPMENT_CASES_BY_BYTES = new Map(
  TRUSTED_DEVELOPMENT_CASES.map((developmentCase) => [
    canonicalizeJson(developmentCase),
    developmentCase,
  ] as const),
);
function acceptedDevelopmentCase(input: unknown): DevelopmentCase {
  const candidate = DevelopmentCaseSchema.parse(passiveDataSnapshot(input));
  const trusted = TRUSTED_DEVELOPMENT_CASES_BY_BYTES.get(
    canonicalizeJson(candidate),
  );
  if (trusted === undefined) {
    throw new TypeError(
      "baseline parity requires an accepted development case from the frozen two-case set",
    );
  }
  return passiveDataSnapshot(trusted);
}

const PRIMARY_MODEL = Object.freeze({
  provider: "fixture",
  modelId: "fixture-primary-v1",
  developerFamily: "fixture-primary-family",
  baseFamily: "fixture-primary-base",
});
const REVIEWER_MODEL = Object.freeze({
  provider: "fixture",
  modelId: "fixture-reviewer-v1",
  developerFamily: "fixture-reviewer-family",
  baseFamily: "fixture-reviewer-base",
});

const ModelIdentitySchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    developerFamily: z.string().min(1),
    baseFamily: z.string().min(1),
  })
  .strict();
const PromptDescriptorSchema = z
  .object({ id: IdSchema, version: SemverSchema, hash: HashSchema })
  .strict();
const ClassificationSchema = z
  .object({
    evidenceMode: z.literal("fixture"),
    reportingUse: z.literal("development"),
    resultClass: z.literal("development_case"),
    headlineEligible: z.literal(false),
  })
  .strict();
const ProtocolBindingSchema = z
  .object({
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    protocolSchemaHash: z.literal(BENCHMARK_PROTOCOL_SCHEMA_HASH),
    conditionMatrixHash: z.literal(CONDITION_MATRIX_HASH),
    promptManifestHash: z.literal(FROZEN_CONSUMER_EDGE.promptManifestHash),
  })
  .strict();

type AcceptedBaselineInput = {
  kind: "evidenceforge.prompt-input.v1";
  nodeId: "strong-baseline";
  inputRefs: string[];
  payload: {
    resolvedScope: unknown;
    packet: {
      fingerprint: string;
      sourceHashes: string[];
      chunkHashes: string[];
    };
    normalizedMetadata: unknown[];
    chunks: Array<{
      id: string;
      sourceId: string;
      text: string;
      location: string;
      contentHash: string;
      displayPermission: string;
    }>;
    primaryModel: z.infer<typeof ModelIdentitySchema>;
    generationLimits: {
      maxOutputTokens: number;
      timeoutMs: number;
      repairInvalidOutput: boolean;
      maximumAttempts: 1 | 2;
    };
    generationSettings: {
      temperature: number;
      maxOutputTokens: number;
      topP: number | null;
      seed: number | null;
      reasoningMode: string;
      reasoningBudgetTokens: number | null;
    };
    outputSchema: { id: string; version: string; hash: string };
    requiredOutputFields: string[];
    safetyConstraints: string[];
    constraintSetHash: string;
  };
};

function acceptedBaselineInput(input: unknown): AcceptedBaselineInput {
  return parsePromptInput(
    "strong-baseline",
    structuredClone(input),
  ) as AcceptedBaselineInput;
}

function toAcceptedBaselineRun(developmentCase: DevelopmentCase) {
  const decidedAt = developmentCase.benchmarkCase.metadataSnapshot.capturedAt;
  const packet = freezePacket({
    sourceHashes: [...developmentCase.benchmarkCase.packet.sourceHashes],
    chunkHashes: [...developmentCase.benchmarkCase.packet.chunkHashes],
    frozenAt: decidedAt,
    freezeDecision: {
      id: `${developmentCase.benchmarkCase.id}-packet-decision`,
      checkpoint: "packet_freeze",
      optionsShown: ["approve", "edit", "reject"],
      decision: "approve",
      edits: [],
      decidedAt,
      unresolvedObjections: [],
    },
  });
  return ResearchRunSchema.parse({
    schemaVersion: "0.1",
    id: `${developmentCase.benchmarkCase.id}-baseline-input`,
    status: "extracting_evidence",
    evidenceMode: "fixture",
    createdAt: decidedAt,
    updatedAt: decidedAt,
    intake: {
      originalQuestion: developmentCase.benchmarkCase.originalQuestion,
      intendedApplication: developmentCase.benchmarkCase.resolvedScope.question,
      populationOrGeography: "Bounded project-authored development fixture.",
      timeHorizon: "Only the time bounds stated in the resolved constraints.",
      availableMaterialsOrBudget: "Only benign resources in the resolved constraints.",
      desiredDepth: "Auditable claim, evidence, gap, and reviewable experiment proposal.",
      constraints: developmentCase.benchmarkCase.resolvedScope.constraints,
      unansweredClarifications: [],
    },
    claims: developmentCase.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      operationalDefinition: claim.successCriterion,
      category: "bounded-development-claim",
      parentClaimId: null,
      scopeConstraints: claim.scopeConstraints,
      disposition: "approved",
      rationale: "Required to answer the approved bounded development question.",
    })),
    scopeDecision: {
      id: `${developmentCase.benchmarkCase.id}-scope-decision`,
      checkpoint: "scope",
      optionsShown: ["approve", "edit", "reject"],
      decision: "approve",
      edits: [],
      decidedAt,
      unresolvedObjections: [],
    },
    packet,
    sources: developmentCase.sources.map((source) => ({
      id: source.id,
      originalInput: source.stableIdentifier,
      canonicalDoi: null,
      canonicalUrl: null,
      doiResolution: {
        syntax: "not_provided",
        resolution: "not_checked",
        registrationAgency: null,
        checkedAt: null,
      },
      bibliographicMetadata: {
        title: source.title,
        authors: [source.creator],
        year: null,
        venue: null,
        studyType: source.authority,
      },
      access: {
        origin: "curated_fixture",
        contentScope: "full_text",
        provider: "project-authored-fixture",
        version: developmentCase.benchmarkCase.version,
        location: source.stableIdentifier,
        retrievedAt: decidedAt,
      },
      rights: {
        mayStore: "allowed",
        mayDisplay: "allowed",
        maySendToModel: "allowed",
        basis: source.rights.basis,
        checkedAt: decidedAt,
      },
      contentHash: source.sourceHash,
      metadataVerification: {
        status: "not_checked",
        method: "project-authored deterministic fixture metadata",
        checkedAt: null,
        fieldDiffs: [],
      },
      integrityNotices: [],
      mergedSourceIds: [],
      warnings: source.safetyNotes,
    })),
    chunks: developmentCase.chunks.map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      text: chunk.text,
      location: chunk.location,
      contentHash: chunk.chunkHash,
      displayPermission: "allowed",
    })),
    evidenceCards: [],
    conclusions: [],
    researchGaps: [],
    selectedGapId: null,
    experiment: null,
    experimentAbstention: null,
    review: null,
    objectionDispositionDecision: null,
    revision: null,
    finalDecision: null,
    executions: [],
    errors: [],
  });
}

function acceptedRequest(developmentCase: DevelopmentCase) {
  const resource = promptRegistry.baseline();
  return buildStrongBaselineRequest({
    run: toAcceptedBaselineRun(developmentCase),
    primaryModel: PRIMARY_MODEL,
    generationLimits: {
      maxOutputTokens: resource.generationSettings.maxOutputTokens,
      timeoutMs: resource.timeoutMs,
    },
    workflowCallCount: 8,
    reviewerModelFamily: REVIEWER_MODEL.baseFamily,
  });
}

const TRUSTED_BUNDLE_CASE_AUTHORITIES = new Map(
  TRUSTED_DEVELOPMENT_CASES.map((developmentCase) => {
    const sharedRequest = acceptedRequest(developmentCase);
    const modelInput = acceptedBaselineInput(
      JSON.parse(sharedRequest.messages[1]!.content),
    );
    return [
      developmentCase.benchmarkCase.id,
      Object.freeze({
        caseHash: developmentCase.benchmarkCase.caseHash,
        caseBytes: canonicalizeJson(developmentCase.benchmarkCase),
        modelInputBytes: canonicalizeJson(modelInput),
      }),
    ] as const;
  }),
);

function outputContract(input: AcceptedBaselineInput) {
  return {
    schemaId: input.payload.outputSchema.id,
    schemaVersion: input.payload.outputSchema.version,
    schemaHash: input.payload.outputSchema.hash,
    requiredFieldsHash: canonicalSha256(input.payload.requiredOutputFields),
    safetyConstraintsHash: canonicalSha256({
      safetyConstraints: input.payload.safetyConstraints,
      constraintSetHash: input.payload.constraintSetHash,
    }),
  };
}

function generation(input: AcceptedBaselineInput) {
  return {
    maxOutputTokens: input.payload.generationLimits.maxOutputTokens,
    timeoutMs: input.payload.generationLimits.timeoutMs,
    temperature: input.payload.generationSettings.temperature,
    topP: input.payload.generationSettings.topP ?? 1,
    responseFormat: "json_schema" as const,
    seedPolicy: "unsupported" as const,
  };
}

function benchmarkConfig(
  developmentCase: DevelopmentCase,
  input: AcceptedBaselineInput,
  conditionId: "strong_baseline" | "complete_workflow",
  benchmarkCodeVersion: string,
) {
  return createBenchmarkConfig({
    id: `${developmentCase.benchmarkCase.id}-${conditionId.replaceAll("_", "-")}-v1`,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    case: developmentCase.benchmarkCase,
    conditionId,
    primaryModel: input.payload.primaryModel,
    adversarialReviewerModel: REVIEWER_MODEL,
    generation: generation(input),
    outputContract: outputContract(input),
    promptManifest: FROZEN_CONSUMER_EDGE.promptManifest,
    benchmarkCodeVersion,
    retryPolicy: {
      maximumAttempts: input.payload.generationLimits.maximumAttempts,
      repairInvalidOutput: input.payload.generationLimits.repairInvalidOutput,
      retryableFailureKinds: [
        "provider_transport",
        "provider_timeout",
        "invalid_structured_output",
      ],
    },
    fallbackPolicy: { mode: "forbidden", configuredModel: null },
    trialPlan: {
      count: 3,
      trialIds: ["trial-1", "trial-2", "trial-3"],
      trialSeeds: [null, null, null],
      selectionPolicy: "report_all_no_best_of",
    },
    exclusionPolicy: {
      allowedReasons: [
        "safety_gate_blocked",
        "rights_gate_blocked",
        "provider_unavailable_before_attempt",
        "configuration_invalid_before_attempt",
      ],
      denominatorPolicy: "retain_failures_report_pre_run_exclusions",
    },
    evidenceMode: "fixture",
  });
}

const PARITY_FIELD_NAMES = Object.freeze([
  "resolved_scope",
  "source_packet",
  "source_chunks",
  "metadata_facts",
  "primary_model",
  "limits_and_budgets",
  "output_schema_and_required_fields",
  "safety_constraints",
  "prompt_manifest",
] as const);
const ParityFieldSchema = z
  .object({
    field: z.enum(PARITY_FIELD_NAMES),
    baselineHash: HashSchema,
    workflowHash: HashSchema,
    equal: z.literal(true),
  })
  .strict();
const AllowedDifferencesSchema = z.tuple([
  z.literal("condition_id"),
  z.literal("baseline_uses_one_comprehensive_call"),
  z.literal("workflow_uses_staged_execution_and_adversarial_review"),
]);

function parityPayloads(
  input: AcceptedBaselineInput,
  config: z.infer<typeof BenchmarkConfigSchema>,
) {
  return {
    resolved_scope: {
      evaluationScopeHash: config.case.resolvedScopeHash,
      acceptedResolvedScope: input.payload.resolvedScope,
    },
    source_packet: {
      evaluationPacket: config.case.packet,
      acceptedPacket: input.payload.packet,
    },
    source_chunks: input.payload.chunks,
    metadata_facts: {
      evaluationSnapshot: config.case.metadataSnapshot,
      acceptedNormalizedMetadata: input.payload.normalizedMetadata,
    },
    primary_model: input.payload.primaryModel,
    limits_and_budgets: {
      generationLimits: input.payload.generationLimits,
      generationSettings: input.payload.generationSettings,
    },
    output_schema_and_required_fields: {
      outputSchema: input.payload.outputSchema,
      requiredOutputFields: input.payload.requiredOutputFields,
    },
    safety_constraints: {
      safetyConstraints: input.payload.safetyConstraints,
      constraintSetHash: input.payload.constraintSetHash,
    },
    prompt_manifest: config.promptManifest,
  } as const;
}

function parityFields(
  input: AcceptedBaselineInput,
  config: z.infer<typeof BenchmarkConfigSchema>,
) {
  const payloads = parityPayloads(input, config);
  return PARITY_FIELD_NAMES.map((field) => {
    const hash = canonicalSha256(payloads[field]);
    return { field, baselineHash: hash, workflowHash: hash, equal: true as const };
  });
}

const PromptMessageSchema = z
  .object({ role: z.enum(["system", "user"]), content: z.string().min(1) })
  .strict();
const BaselineRequestSchema = z
  .object({
    prompt: PromptDescriptorSchema,
    inputSchema: PromptDescriptorSchema,
    messages: z.tuple([PromptMessageSchema, PromptMessageSchema]),
    outputSchema: PromptDescriptorSchema,
    fairness: z.object({ mismatchFields: z.array(z.never()).length(0) }).strict(),
  })
  .strict();
const ComparisonSchema = z
  .object({
    valid: z.literal(true),
    invalidationReasons: z.array(z.never()).length(0),
    leftConfigHash: HashSchema,
    rightConfigHash: HashSchema,
    pairingHash: HashSchema,
  })
  .strict();

function comparisonInvalidatingPayload(input: {
  pairingHash: string;
  contextHash: string;
  parityFields: readonly z.infer<typeof ParityFieldSchema>[];
  prompt: z.infer<typeof PromptDescriptorSchema>;
  inputSchema: z.infer<typeof PromptDescriptorSchema>;
  allowedDifferences: readonly string[];
}) {
  return {
    version: STRONG_BASELINE_PARITY_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    ...input,
  };
}

const StrongBaselineParityBundleBaseSchema = z
  .object({
    schemaVersion: z.literal(STRONG_BASELINE_PARITY_VERSION),
    caseId: IdSchema,
    classification: ClassificationSchema,
    protocolBinding: ProtocolBindingSchema,
    context: z.json(),
    parityFields: z.array(ParityFieldSchema).length(PARITY_FIELD_NAMES.length),
    allowedDifferences: AllowedDifferencesSchema,
    baseline: z
      .object({
        callCount: z.literal(1),
        config: BenchmarkConfigSchema,
        contextBytes: z.string().min(1),
        contextHash: HashSchema,
        request: BaselineRequestSchema,
      })
      .strict(),
    workflow: z
      .object({
        config: BenchmarkConfigSchema,
        contextBytes: z.string().min(1),
        contextHash: HashSchema,
      })
      .strict(),
    comparison: ComparisonSchema,
    comparisonInvalidatingHash: HashSchema,
  })
  .strict();

function bundleHashPayload(bundle: z.infer<typeof StrongBaselineParityBundleBaseSchema>) {
  return { version: STRONG_BASELINE_PARITY_VERSION, ...bundle };
}

const StrongBaselineParityBundleZodSchema =
  StrongBaselineParityBundleBaseSchema.extend({ bundleHash: HashSchema })
    .strict()
    .superRefine((bundle, context) => {
      const add = (path: Array<string | number>, message: string) =>
        context.addIssue({ code: "custom", path, message });
      const resource = promptRegistry.baseline();
      let accepted: AcceptedBaselineInput | null = null;
      try {
        accepted = acceptedBaselineInput(bundle.context);
      } catch {
        add(["context"], "context must satisfy the accepted strong-baseline registry input schema");
      }
      if (accepted === null) return;

      const trustedCase = TRUSTED_BUNDLE_CASE_AUTHORITIES.get(bundle.caseId);
      if (trustedCase === undefined) {
        add(
          ["caseId"],
          "bundle must identify an accepted development case from the frozen two-case set",
        );
      } else {
        if (
          bundle.baseline.config.case.caseHash !== trustedCase.caseHash ||
          bundle.workflow.config.case.caseHash !== trustedCase.caseHash ||
          canonicalizeJson(bundle.baseline.config.case) !== trustedCase.caseBytes ||
          canonicalizeJson(bundle.workflow.config.case) !== trustedCase.caseBytes
        ) {
          add(
            ["baseline", "config", "case"],
            "both configs must bind the private accepted development-case snapshot",
          );
        }
        if (canonicalizeJson(accepted) !== trustedCase.modelInputBytes) {
          add(
            ["context"],
            "context must equal the accepted development case model input",
          );
        }
      }

      const contextBytes = canonicalizeJson(accepted);
      const contextHash = canonicalSha256(accepted);
      if (
        bundle.baseline.contextBytes !== contextBytes ||
        bundle.workflow.contextBytes !== contextBytes ||
        bundle.baseline.request.messages[1].content !== contextBytes
      ) {
        add(["baseline", "contextBytes"], "both conditions and the actual user message require the exact accepted input bytes");
      }
      if (
        bundle.baseline.contextHash !== contextHash ||
        bundle.workflow.contextHash !== contextHash
      ) {
        add(["baseline", "contextHash"], "context hashes must bind the accepted registry input");
      }
      const prompt = { id: resource.id, version: resource.version, hash: resource.hash };
      const inputSchema = {
        id: resource.inputSchema.id,
        version: resource.inputSchema.version,
        hash: resource.inputSchema.hash,
      };
      const outputSchema = {
        id: resource.outputSchema.id,
        version: resource.outputSchema.version,
        hash: resource.outputSchema.hash,
      };
      if (
        canonicalizeJson(bundle.baseline.request.prompt) !== canonicalizeJson(prompt) ||
        canonicalizeJson(bundle.baseline.request.inputSchema) !== canonicalizeJson(inputSchema) ||
        canonicalizeJson(bundle.baseline.request.outputSchema) !== canonicalizeJson(outputSchema) ||
        canonicalizeJson(bundle.baseline.request.messages[0]) !== canonicalizeJson(resource.messages[0])
      ) {
        add(["baseline", "request"], "request must use the exact accepted prompt/input/output registry edge");
      }
      if (
        bundle.baseline.config.conditionId !== "strong_baseline" ||
        bundle.workflow.config.conditionId !== "complete_workflow" ||
        bundle.caseId !== bundle.baseline.config.case.id ||
        bundle.caseId !== bundle.workflow.config.case.id
      ) {
        add(["baseline", "config"], "bundle does not identify the required case/condition pair");
      }
      const baselineConfig = bundle.baseline.config;
      const workflowConfig = bundle.workflow.config;
      if (
        baselineConfig.pairingHash !== workflowConfig.pairingHash ||
        baselineConfig.pairingHash !== bundle.comparison.pairingHash
      ) {
        add(["comparison", "pairingHash"], "protocol pairing hashes must be identical");
      }
      if (
        canonicalizeJson(baselineConfig.case.packet.sourceHashes) !== canonicalizeJson(accepted.payload.packet.sourceHashes) ||
        canonicalizeJson(baselineConfig.case.packet.chunkHashes) !== canonicalizeJson(accepted.payload.packet.chunkHashes) ||
        canonicalizeJson(baselineConfig.primaryModel) !== canonicalizeJson(accepted.payload.primaryModel) ||
        canonicalizeJson(baselineConfig.generation) !== canonicalizeJson(generation(accepted)) ||
        canonicalizeJson(baselineConfig.outputContract) !== canonicalizeJson(outputContract(accepted)) ||
        baselineConfig.promptManifestHash !== bundle.protocolBinding.promptManifestHash
      ) {
        add(["baseline", "config"], "accepted input drifted from packet/model/limits/schema/safety/prompt comparison config");
      }
      const expectedFields = parityFields(accepted, baselineConfig);
      if (canonicalizeJson(bundle.parityFields) !== canonicalizeJson(expectedFields)) {
        add(["parityFields"], "field-by-field parity hashes do not match the accepted input");
      }
      try {
        const assessment = assessComparisonPair({
          left: baselineConfig,
          right: workflowConfig,
          reportingUse: "development",
        });
        if (canonicalizeJson(assessment) !== canonicalizeJson(bundle.comparison)) {
          add(["comparison"], "comparison assessment does not match protocol v1");
        }
      } catch {
        add(
          ["comparison"],
          "comparison configuration must retain its canonical protocol identity",
        );
      }
      const expectedComparisonHash = canonicalSha256(
        comparisonInvalidatingPayload({
          pairingHash: bundle.comparison.pairingHash,
          contextHash,
          parityFields: expectedFields,
          prompt,
          inputSchema,
          allowedDifferences: bundle.allowedDifferences,
        }),
      );
      if (bundle.comparisonInvalidatingHash !== expectedComparisonHash) {
        add(["comparisonInvalidatingHash"], "comparison-invalidating hash mismatch");
      }
      const { bundleHash, ...withoutBundleHash } = bundle;
      if (bundleHash !== canonicalSha256(bundleHashPayload(withoutBundleHash))) {
        add(["bundleHash"], "bundle hash mismatch");
      }
    });

export type StrongBaselineParityBundle = z.infer<typeof StrongBaselineParityBundleZodSchema>;
export const StrongBaselineParityBundleSchema = passiveSchema(
  StrongBaselineParityBundleZodSchema,
);

export function createStrongBaselineParityBundle(
  input: unknown,
  options: { benchmarkCodeVersion?: string } = {},
): StrongBaselineParityBundle {
  const developmentCase = acceptedDevelopmentCase(input);
  const safeOptions = z
    .object({ benchmarkCodeVersion: GitShaSchema.optional() })
    .strict()
    .parse(passiveDataSnapshot(options));
  const sharedRequest = acceptedRequest(developmentCase);
  const context = acceptedBaselineInput(
    JSON.parse(sharedRequest.messages[1]!.content),
  );
  const contextBytes = canonicalizeJson(context);
  const contextHash = canonicalSha256(context);
  const codeVersion = safeOptions.benchmarkCodeVersion ?? BENCHMARK_CODE_BASE;
  const baselineConfig = benchmarkConfig(developmentCase, context, "strong_baseline", codeVersion);
  const workflowConfig = benchmarkConfig(developmentCase, context, "complete_workflow", codeVersion);
  const comparison = assessComparisonPair({
    left: baselineConfig,
    right: workflowConfig,
    reportingUse: "development",
  });
  if (!comparison.valid || comparison.pairingHash === null) {
    throw new TypeError(`baseline parity invalid: ${comparison.invalidationReasons.join(", ")}`);
  }
  const resource = promptRegistry.baseline();
  const prompt = { id: resource.id, version: resource.version, hash: resource.hash };
  const inputSchema = {
    id: resource.inputSchema.id,
    version: resource.inputSchema.version,
    hash: resource.inputSchema.hash,
  };
  const allowedDifferences = [
    "condition_id",
    "baseline_uses_one_comprehensive_call",
    "workflow_uses_staged_execution_and_adversarial_review",
  ] as const;
  const fields = parityFields(context, baselineConfig);
  const withoutBundleHash = StrongBaselineParityBundleBaseSchema.parse({
    schemaVersion: STRONG_BASELINE_PARITY_VERSION,
    caseId: developmentCase.benchmarkCase.id,
    classification: developmentCase.classification,
    protocolBinding: developmentCase.protocolBinding,
    context,
    parityFields: fields,
    allowedDifferences,
    baseline: {
      callCount: sharedRequest.baselineCallCount,
      config: baselineConfig,
      contextBytes,
      contextHash,
      request: {
        prompt,
        inputSchema,
        messages: sharedRequest.messages,
        outputSchema: {
          id: resource.outputSchema.id,
          version: resource.outputSchema.version,
          hash: resource.outputSchema.hash,
        },
        fairness: sharedRequest.fairness,
      },
    },
    workflow: { config: workflowConfig, contextBytes, contextHash },
    comparison,
    comparisonInvalidatingHash: canonicalSha256(
      comparisonInvalidatingPayload({
        pairingHash: comparison.pairingHash,
        contextHash,
        parityFields: fields,
        prompt,
        inputSchema,
        allowedDifferences,
      }),
    ),
  });
  return StrongBaselineParityBundleSchema.parse({
    ...withoutBundleHash,
    bundleHash: canonicalSha256(bundleHashPayload(withoutBundleHash)),
  });
}

export function exportStrongBaselineParityManifest(
  input: unknown,
  options: { benchmarkCodeVersion?: string } = {},
): string {
  const developmentCase = acceptedDevelopmentCase(input);
  return `${canonicalizeJson(createStrongBaselineParityBundle(developmentCase, options))}\n`;
}

type TrustedAttemptIdentity = Readonly<{
  runId: string;
  caseId: string;
  parityBindingBytes: string;
  requestedModelBytes: string;
  validationSchemaBytes: string;
}>;

declare const strongBaselineRunAuthorityBrand: unique symbol;
export type StrongBaselineRunAuthority = Readonly<{
  [strongBaselineRunAuthorityBrand]: "StrongBaselineRunAuthority";
}>;

const trustedAttemptIdentitiesByAuthority = new WeakMap<
  object,
  TrustedAttemptIdentity
>();

function trustedAttemptIdentityFor(input: {
  bundle: StrongBaselineParityBundle;
  runId: string;
}): TrustedAttemptIdentity {
  const bundle = input.bundle;
  const resource = promptRegistry.baseline();
  return Object.freeze({
    runId: input.runId,
    caseId: bundle.caseId,
    parityBindingBytes: canonicalizeJson({
      caseId: bundle.caseId,
      benchmarkCodeVersion: bundle.baseline.config.benchmarkCodeVersion,
      contextHash: bundle.baseline.contextHash,
      pairingHash: bundle.comparison.pairingHash,
      comparisonInvalidatingHash: bundle.comparisonInvalidatingHash,
      bundleHash: bundle.bundleHash,
      baselineConfigHash: bundle.baseline.config.configHash,
      prompt: bundle.baseline.request.prompt,
    }),
    requestedModelBytes: canonicalizeJson(bundle.baseline.config.primaryModel),
    validationSchemaBytes: canonicalizeJson({
      schemaId: resource.outputSchema.id,
      schemaVersion: resource.outputSchema.version,
      schemaHash: resource.outputSchema.hash,
    }),
  });
}

function issueStrongBaselineRunAuthority(input: {
  bundle: StrongBaselineParityBundle;
  runId: string;
}): StrongBaselineRunAuthority {
  const authority = Object.freeze(Object.create(null)) as StrongBaselineRunAuthority;
  trustedAttemptIdentitiesByAuthority.set(
    authority,
    trustedAttemptIdentityFor(input),
  );
  return authority;
}

function trustedIdentityFromAuthority(
  authority: unknown,
): TrustedAttemptIdentity | undefined {
  if (
    (typeof authority !== "object" || authority === null) &&
    typeof authority !== "function"
  ) {
    return undefined;
  }
  return trustedAttemptIdentitiesByAuthority.get(authority as object);
}

function validationSchemaBytes(input: {
  schemaId: string;
  schemaVersion: string;
  schemaHash: string;
}) {
  return canonicalizeJson({
    schemaId: input.schemaId,
    schemaVersion: input.schemaVersion,
    schemaHash: input.schemaHash,
  });
}

const ReturnedModelSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), value: ModelIdentitySchema, reason: z.null() }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      value: z.null(),
      reason: z.literal("fixture_no_provider_response"),
    })
    .strict(),
]);
const UsageSchema = z
  .object({
    status: z.literal("unavailable"),
    inputTokens: z.null(),
    outputTokens: z.null(),
    totalTokens: z.null(),
    reason: z.literal("fixture_provider_usage_not_supplied"),
  })
  .strict();
const CostSchema = z
  .object({
    status: z.literal("unavailable"),
    amount: z.null(),
    currency: z.null(),
    reason: z.literal("fixture_cost_not_computed"),
  })
  .strict();
const AttemptOutcomeSchema = z.enum([
  "succeeded",
  "timeout",
  "refusal",
  "invalid_output",
  "provider_failure",
]);
const RetryReasonSchema = z.enum([
  "initial_attempt",
  "provider_timeout",
  "invalid_structured_output",
  "provider_transport",
]);
const FixtureRefusalBodySchema = z
  .object({
    fixtureKind: z.literal("authored-refusal"),
    message: z.literal("Fixture refusal: no model or provider executed."),
  })
  .strict();

const BaselineAttemptEvidenceZodSchema = z
  .object({
    kind: z.literal("evidenceforge.strong-baseline-attempt.v1"),
    schemaVersion: z.literal(STRONG_BASELINE_PARITY_VERSION),
    evidenceMode: z.literal("fixture"),
    runId: IdSchema,
    attemptId: IdSchema,
    outcome: AttemptOutcomeSchema,
    parityBinding: z
      .object({
        caseId: IdSchema,
        benchmarkCodeVersion: GitShaSchema,
        contextHash: HashSchema,
        pairingHash: HashSchema,
        comparisonInvalidatingHash: HashSchema,
        bundleHash: HashSchema,
        baselineConfigHash: HashSchema,
        prompt: PromptDescriptorSchema,
      })
      .strict(),
    requestedModel: ModelIdentitySchema,
    returnedModel: ReturnedModelSchema,
    rawProviderOutput: z.json().nullable(),
    canonicalOutput: z.json().nullable(),
    canonicalOutputHash: HashSchema.nullable(),
    validation: z
      .object({
        status: z.enum(["valid", "invalid", "not_received", "refused"]),
        schemaId: IdSchema,
        schemaVersion: SemverSchema,
        schemaHash: HashSchema,
        issues: z.array(z.string().min(1)),
      })
      .strict(),
    usage: UsageSchema,
    cost: CostSchema,
    latency: z
      .object({
        milliseconds: z.literal(0),
        measured: z.literal(false),
        evidence: z.literal("authored_fixture_zero_not_provider_latency"),
      })
      .strict(),
    retry: z
      .object({
        attemptNumber: z.union([z.literal(1), z.literal(2)]),
        maximumAttempts: z.literal(2),
        retryOfAttemptId: IdSchema.nullable(),
        willRetry: z.boolean(),
        reason: RetryReasonSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const add = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const parsedOutput =
      attempt.canonicalOutput === null
        ? null
        : StrongBaselineOutputSchema.safeParse(attempt.canonicalOutput);
    const canonicalValid = parsedOutput?.success === true;
    const acceptedOutputSchema = promptRegistry.baseline().outputSchema;
    if (
      attempt.validation.schemaId !== acceptedOutputSchema.id ||
      attempt.validation.schemaVersion !== acceptedOutputSchema.version ||
      attempt.validation.schemaHash !== acceptedOutputSchema.hash
    ) {
      add(["validation", "schemaHash"], "validation must bind the accepted strong-baseline output schema");
    }
    if (attempt.outcome === "succeeded") {
      if (
        !canonicalValid ||
        attempt.validation.status !== "valid" ||
        attempt.validation.issues.length !== 0 ||
        attempt.canonicalOutputHash !== canonicalSha256(parsedOutput.data) ||
        attempt.rawProviderOutput === null ||
        canonicalizeJson(attempt.rawProviderOutput) !==
          canonicalizeJson(parsedOutput.data) ||
        attempt.returnedModel.status !== "available"
      ) {
        add(["canonicalOutput"], "success is derived only from the exact schema-valid raw response, canonical output/hash, and returned model");
      }
    } else if (
      attempt.canonicalOutput !== null ||
      attempt.canonicalOutputHash !== null ||
      attempt.validation.status === "valid"
    ) {
      add(["canonicalOutput"], "failed/refused attempts cannot be relabeled as valid canonical success");
    }
    const expectedValidation = {
      succeeded: "valid",
      timeout: "not_received",
      refusal: "refused",
      invalid_output: "invalid",
      provider_failure: "not_received",
    } as const;
    if (attempt.validation.status !== expectedValidation[attempt.outcome]) {
      add(["validation", "status"], "validation status does not match the derived outcome");
    }
    if (attempt.outcome === "invalid_output" && attempt.validation.issues.length === 0) {
      add(["validation", "issues"], "invalid output requires schema issues");
    }
    if (attempt.outcome === "refusal") {
      if (!FixtureRefusalBodySchema.safeParse(attempt.rawProviderOutput).success) {
        add(["rawProviderOutput"], "refusal requires the preserved authored fixture refusal body");
      }
    }
    if (attempt.outcome === "invalid_output") {
      const invalid = attempt.rawProviderOutput === null
        ? null
        : validateStrongBaselineOutput(attempt.rawProviderOutput);
      if (
        invalid?.status !== "invalid" ||
        canonicalizeJson(attempt.validation.issues) !==
          canonicalizeJson(invalid.validationIssues)
      ) {
        add(["rawProviderOutput"], "invalid output requires the preserved schema-invalid raw body and its derived issues");
      }
    }
    if (
      ["timeout", "provider_failure"].includes(attempt.outcome) &&
      (attempt.rawProviderOutput !== null || attempt.returnedModel.status !== "unavailable")
    ) {
      add(["returnedModel"], "pre-response failures require null raw output and unavailable returned model");
    }
    if (
      attempt.returnedModel.status === "available" &&
      canonicalizeJson(attempt.returnedModel.value) !== canonicalizeJson(attempt.requestedModel)
    ) {
      add(["returnedModel", "value"], "fallback is forbidden; returned model must match the requested identity");
    }
    if (
      attempt.outcome !== "succeeded" &&
      attempt.returnedModel.status !== "unavailable"
    ) {
      add(["returnedModel"], "authored fixture failures cannot claim a returned provider model");
    }
    const expectedAttemptId = `${attempt.runId}-attempt-${attempt.retry.attemptNumber}`;
    if (attempt.attemptId !== expectedAttemptId) {
      add(["attemptId"], "attempt ID must bind run ID and attempt number");
    }
    if (attempt.retry.attemptNumber === 1) {
      if (
        attempt.retry.retryOfAttemptId !== null ||
        attempt.retry.reason !== "initial_attempt"
      ) {
        add(["retry"], "attempt 1 requires null parent and initial_attempt reason");
      }
    } else {
      const expectedParent = `${attempt.runId}-attempt-${attempt.retry.attemptNumber - 1}`;
      if (
        attempt.retry.retryOfAttemptId !== expectedParent ||
        attempt.retry.reason === "initial_attempt"
      ) {
        add(["retry"], "retry attempts require the exact prior attempt and its failure reason");
      }
    }
    if (
      attempt.retry.attemptNumber === attempt.retry.maximumAttempts &&
      attempt.retry.willRetry
    ) {
      add(["retry", "willRetry"], "terminal attempts cannot schedule another retry");
    }
    if (
      attempt.retry.willRetry &&
      !["timeout", "invalid_output", "provider_failure"].includes(attempt.outcome)
    ) {
      add(["retry", "willRetry"], "success and refusal are not retryable outcomes");
    }
  });

export type BaselineAttemptEvidence = z.infer<typeof BaselineAttemptEvidenceZodSchema>;

const retryReasonForOutcome = {
  timeout: "provider_timeout",
  invalid_output: "invalid_structured_output",
  provider_failure: "provider_transport",
} as const;

const BaselineAttemptSequenceZodSchema = z
  .array(BaselineAttemptEvidenceZodSchema)
  .min(1)
  .max(2)
  .superRefine((attempts, context) => {
    const first = attempts[0]!;
    for (const [index, attempt] of attempts.entries()) {
      if (
        attempt.runId !== first.runId ||
        canonicalizeJson(attempt.parityBinding) !== canonicalizeJson(first.parityBinding) ||
        canonicalizeJson(attempt.requestedModel) !== canonicalizeJson(first.requestedModel) ||
        attempt.validation.schemaId !== first.validation.schemaId ||
        attempt.validation.schemaVersion !== first.validation.schemaVersion ||
        attempt.validation.schemaHash !== first.validation.schemaHash
      ) {
        context.addIssue({ code: "custom", path: [index], message: "all attempts must share one immutable run, config, request-model, and output-schema binding" });
      }
      if (attempt.retry.attemptNumber !== index + 1) {
        context.addIssue({ code: "custom", path: [index, "retry", "attemptNumber"], message: "attempt sequence must be contiguous and ordered" });
      }
      const hasNext = index < attempts.length - 1;
      if (attempt.retry.willRetry !== hasNext) {
        context.addIssue({ code: "custom", path: [index, "retry", "willRetry"], message: "retry decision must match preserved next-attempt existence" });
      }
      const expectedReason = retryReasonForOutcome[
        attempt.outcome as keyof typeof retryReasonForOutcome
      ];
      const mustRetry =
        expectedReason !== undefined &&
        attempt.retry.attemptNumber < attempt.retry.maximumAttempts;
      if (attempt.retry.willRetry !== mustRetry) {
        context.addIssue({ code: "custom", path: [index, "retry", "willRetry"], message: "retryable nonterminal failures must continue exactly once; terminal outcomes cannot continue" });
      }
      if (hasNext) {
        const next = attempts[index + 1]!;
        if (
          next.retry.retryOfAttemptId !== attempt.attemptId ||
          expectedReason === undefined ||
          next.retry.reason !== expectedReason
        ) {
          context.addIssue({ code: "custom", path: [index + 1, "retry", "reason"], message: "retry reason must identify the immediately prior retryable failure" });
        }
      }
    }
  });

function authorizedAttemptEvidenceSchema(identity: TrustedAttemptIdentity) {
  return BaselineAttemptEvidenceZodSchema.superRefine((attempt, context) => {
    if (
      attempt.runId !== identity.runId ||
      attempt.parityBinding.caseId !== identity.caseId ||
      canonicalizeJson(attempt.parityBinding) !== identity.parityBindingBytes ||
      canonicalizeJson(attempt.requestedModel) !== identity.requestedModelBytes ||
      validationSchemaBytes(attempt.validation) !== identity.validationSchemaBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["parityBinding"],
        message:
          "attempt identity must match the separately authorized case, code version, runner run, registry prompt/schema, and configured model",
      });
    }
  });
}

function authorizedAttemptSequenceSchema(identity: TrustedAttemptIdentity) {
  return BaselineAttemptSequenceZodSchema.superRefine((attempts, context) => {
    for (const [index, attempt] of attempts.entries()) {
      if (
        attempt.runId !== identity.runId ||
        attempt.parityBinding.caseId !== identity.caseId ||
        canonicalizeJson(attempt.parityBinding) !== identity.parityBindingBytes ||
        canonicalizeJson(attempt.requestedModel) !== identity.requestedModelBytes ||
        validationSchemaBytes(attempt.validation) !== identity.validationSchemaBytes
      ) {
        context.addIssue({
          code: "custom",
          path: [index],
          message:
            "attempt sequence must match the separately authorized case, code version, run, config, request-model, and output schema",
        });
      }
    }
  });
}

function unauthorizedSafeParse<T>(): PassiveSafeParseResult<T> {
  return z
    .never({ error: "a process-local strong-baseline run authority is required" })
    .safeParse(undefined) as PassiveSafeParseResult<T>;
}

export function safeParseBaselineAttemptEvidence(
  authority: StrongBaselineRunAuthority,
  input: unknown,
): PassiveSafeParseResult<BaselineAttemptEvidence> {
  const identity = trustedIdentityFromAuthority(authority);
  if (identity === undefined) return unauthorizedSafeParse();
  return passiveSchema(authorizedAttemptEvidenceSchema(identity)).safeParse(input);
}

export function parseBaselineAttemptEvidence(
  authority: StrongBaselineRunAuthority,
  input: unknown,
): BaselineAttemptEvidence {
  const result = safeParseBaselineAttemptEvidence(authority, input);
  if (!result.success) throw result.error;
  return result.data;
}

export function safeParseBaselineAttemptSequence(
  authority: StrongBaselineRunAuthority,
  input: unknown,
): PassiveSafeParseResult<BaselineAttemptEvidence[]> {
  const identity = trustedIdentityFromAuthority(authority);
  if (identity === undefined) return unauthorizedSafeParse();
  return passiveSchema(authorizedAttemptSequenceSchema(identity)).safeParse(input);
}

export function parseBaselineAttemptSequence(
  authority: StrongBaselineRunAuthority,
  input: unknown,
): BaselineAttemptEvidence[] {
  const result = safeParseBaselineAttemptSequence(authority, input);
  if (!result.success) throw result.error;
  return result.data;
}

export function validateStrongBaselineOutput(input: unknown):
  | {
      status: "valid";
      canonicalOutput: z.output<typeof StrongBaselineOutputSchema>;
      canonicalOutputHash: string;
      validationIssues: [];
    }
  | {
      status: "invalid";
      canonicalOutput: null;
      canonicalOutputHash: null;
      validationIssues: string[];
    } {
  let snapshot: unknown;
  try {
    snapshot = passiveDataSnapshot(input);
  } catch (error) {
    if (!(error instanceof PassiveDataError)) throw error;
    return {
      status: "invalid",
      canonicalOutput: null,
      canonicalOutputHash: null,
      validationIssues: [`output: ${error.message}`],
    };
  }
  const result = StrongBaselineOutputSchema.safeParse(snapshot);
  if (result.success) {
    return {
      status: "valid",
      canonicalOutput: result.data,
      canonicalOutputHash: canonicalSha256(result.data),
      validationIssues: [],
    };
  }
  return {
    status: "invalid",
    canonicalOutput: null,
    canonicalOutputHash: null,
    validationIssues: result.error.issues
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
      .sort(),
  };
}

type FailureScenario = "timeout" | "refusal" | "invalid_output" | "provider_failure";

function fixtureAttemptEvidence(input: {
  authority: StrongBaselineRunAuthority;
  outcome: FailureScenario;
  bundle: StrongBaselineParityBundle;
  runId: string;
  attemptNumber: 1 | 2;
  retryOfAttemptId: string | null;
  retryReason: z.infer<typeof RetryReasonSchema>;
  willRetry: boolean;
}) {
  const resource = promptRegistry.baseline();
  const rawProviderOutput =
    input.outcome === "refusal"
      ? FixtureRefusalBodySchema.parse({
          fixtureKind: "authored-refusal",
          message: "Fixture refusal: no model or provider executed.",
        })
      : input.outcome === "invalid_output"
        ? { fixtureKind: "authored-invalid-output", unexpected: true }
        : null;
  const invalid = input.outcome === "invalid_output"
    ? validateStrongBaselineOutput(rawProviderOutput)
    : null;
  const validationStatus = {
    timeout: "not_received",
    refusal: "refused",
    invalid_output: "invalid",
    provider_failure: "not_received",
  } as const;
  return parseBaselineAttemptEvidence(input.authority, {
    kind: "evidenceforge.strong-baseline-attempt.v1",
    schemaVersion: STRONG_BASELINE_PARITY_VERSION,
    evidenceMode: "fixture",
    runId: input.runId,
    attemptId: `${input.runId}-attempt-${input.attemptNumber}`,
    outcome: input.outcome,
    parityBinding: {
      caseId: input.bundle.caseId,
      benchmarkCodeVersion: input.bundle.baseline.config.benchmarkCodeVersion,
      contextHash: input.bundle.baseline.contextHash,
      pairingHash: input.bundle.comparison.pairingHash,
      comparisonInvalidatingHash: input.bundle.comparisonInvalidatingHash,
      bundleHash: input.bundle.bundleHash,
      baselineConfigHash: input.bundle.baseline.config.configHash,
      prompt: input.bundle.baseline.request.prompt,
    },
    requestedModel: input.bundle.baseline.config.primaryModel,
    returnedModel: {
      status: "unavailable",
      value: null,
      reason: "fixture_no_provider_response",
    },
    rawProviderOutput,
    canonicalOutput: null,
    canonicalOutputHash: null,
    validation: {
      status: validationStatus[input.outcome],
      schemaId: resource.outputSchema.id,
      schemaVersion: resource.outputSchema.version,
      schemaHash: resource.outputSchema.hash,
      issues:
        invalid?.status === "invalid"
          ? invalid.validationIssues
          : input.outcome === "refusal"
            ? ["provider refusal preserved as fixture evidence; no output validation performed"]
            : [],
    },
    usage: {
      status: "unavailable",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reason: "fixture_provider_usage_not_supplied",
    },
    cost: {
      status: "unavailable",
      amount: null,
      currency: null,
      reason: "fixture_cost_not_computed",
    },
    latency: {
      milliseconds: 0,
      measured: false,
      evidence: "authored_fixture_zero_not_provider_latency",
    },
    retry: {
      attemptNumber: input.attemptNumber,
      maximumAttempts: 2,
      retryOfAttemptId: input.retryOfAttemptId,
      willRetry: input.willRetry,
      reason: input.retryReason,
    },
  });
}

function runnerConfig(input: {
  bundle: StrongBaselineParityBundle;
  runId: string;
  rerunOfRunId: string | null;
  createdAt: string;
}) {
  return EvalRunConfigSchema.parse({
    runnerVersion: EVAL_RUNNER_VERSION,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    runId: input.runId,
    rerunOfRunId: input.rerunOfRunId,
    createdAt: input.createdAt,
    trialId: "trial-1",
    benchmarkConfig: input.bundle.baseline.config,
    evidenceMode: "fixture",
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
  });
}

function failureAttempts(input: {
  authority: StrongBaselineRunAuthority;
  bundle: StrongBaselineParityBundle;
  runId: string;
  scenarios: readonly [FailureScenario, FailureScenario];
  timestampPrefix: "2026-08-08T05:30:0" | "2026-08-08T05:31:0";
}): RecordedAttempt[] {
  const envelopes: BaselineAttemptEvidence[] = [];
  const attempts: RecordedAttempt[] = [];
  for (const [index, outcome] of input.scenarios.entries()) {
    const attemptNumber = (index + 1) as 1 | 2;
    const attemptId = `${input.runId}-attempt-${attemptNumber}`;
    const prior = envelopes[index - 1];
    const retryReason = prior === undefined
      ? "initial_attempt"
      : retryReasonForOutcome[prior.outcome as keyof typeof retryReasonForOutcome];
    if (retryReason === undefined) throw new TypeError("non-retryable outcome cannot have a subsequent attempt");
    const timestamp = `${input.timestampPrefix}${attemptNumber}.000Z`;
    const request = createRequestMetadata({
      runId: input.runId,
      attemptId,
      trialId: "trial-1",
      evidenceMode: "fixture",
      requestedAt: timestamp,
      requestedProvider: input.bundle.baseline.config.primaryModel.provider,
      requestedModelId: input.bundle.baseline.config.primaryModel.modelId,
      providerRequestId: null,
      seed: null,
      generation: input.bundle.baseline.config.generation,
      promptManifestHash: input.bundle.protocolBinding.promptManifestHash,
    });
    const evidence = fixtureAttemptEvidence({
      authority: input.authority,
      outcome,
      bundle: input.bundle,
      runId: input.runId,
      attemptNumber,
      retryOfAttemptId: prior?.attemptId ?? null,
      retryReason,
      willRetry: index < input.scenarios.length - 1,
    });
    envelopes.push(evidence);
    const failureKind = {
      timeout: "provider_timeout",
      refusal: "fixture_failure",
      invalid_output: "invalid_structured_output",
      provider_failure: "provider_transport",
    } as const;
    attempts.push({
      raw: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId: input.runId,
        attemptId,
        attemptNumber,
        trialId: "trial-1",
        evidenceMode: "fixture",
        startedAt: timestamp,
        completedAt: timestamp,
        latencyMs: 0,
        request,
        status: "failed",
        rawOutput: evidence,
        failure: {
          kind: failureKind[outcome],
          message: `Authored fixture ${outcome.replaceAll("_", " ")}; no provider executed.`,
          retryable: ["timeout", "invalid_output", "provider_failure"].includes(outcome),
          providerCode: `FIXTURE_${outcome.toUpperCase()}`,
        },
      },
      parsed: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId: input.runId,
        attemptId,
        attemptNumber,
        trialId: "trial-1",
        evidenceMode: "fixture",
        parseStatus: outcome === "invalid_output" ? "invalid" : "not_parsed",
        canonicalRun: null,
        canonicalRunHash: null,
        validationIssues: outcome === "invalid_output" ? evidence.validation.issues : [],
      },
    });
  }
  parseBaselineAttemptSequence(input.authority, envelopes);
  return attempts;
}

async function readManifest(path: string) {
  return RunManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function materializeStrongBaselineSmoke(input: {
  artifactRoot: string;
  developmentCase: unknown;
  benchmarkCodeVersion?: string;
}) {
  const safeInput = z
    .object({
      artifactRoot: z.string().min(1),
      developmentCase: z.unknown(),
      benchmarkCodeVersion: GitShaSchema.optional(),
    })
    .strict()
    .parse(passiveDataSnapshot(input));
  const bundle = createStrongBaselineParityBundle(
    safeInput.developmentCase,
    safeInput.benchmarkCodeVersion === undefined
      ? {}
      : { benchmarkCodeVersion: safeInput.benchmarkCodeVersion },
  );
  const parentRunId = `${bundle.caseId}-strong-baseline-smoke`;
  const rerunId = `${parentRunId}-rerun`;
  const parentAuthority = issueStrongBaselineRunAuthority({
    bundle,
    runId: parentRunId,
  });
  const rerunAuthority = issueStrongBaselineRunAuthority({
    bundle,
    runId: rerunId,
  });
  const parentConfig = runnerConfig({
    bundle,
    runId: parentRunId,
    rerunOfRunId: null,
    createdAt: "2026-08-08T05:30:00.000Z",
  });
  const parentAttempts = failureAttempts({
    authority: parentAuthority,
    bundle,
    runId: parentRunId,
    scenarios: ["timeout", "refusal"],
    timestampPrefix: "2026-08-08T05:30:0",
  });
  const parent = await materializeFixtureRun({
    artifactRoot: safeInput.artifactRoot,
    config: parentConfig,
    attempts: parentAttempts,
  });
  const rerunConfig = runnerConfig({
    bundle,
    runId: rerunId,
    rerunOfRunId: parentRunId,
    createdAt: "2026-08-08T05:31:00.000Z",
  });
  const rerunAttempts = failureAttempts({
    authority: rerunAuthority,
    bundle,
    runId: rerunId,
    scenarios: ["invalid_output", "provider_failure"],
    timestampPrefix: "2026-08-08T05:31:0",
  });
  const rerun = await materializeFixtureRun({
    artifactRoot: safeInput.artifactRoot,
    config: rerunConfig,
    attempts: rerunAttempts,
  });
  return {
    bundle,
    parentAuthority,
    rerunAuthority,
    parent,
    rerun,
    parentAttempts,
    rerunAttempts,
    parentManifest: await readManifest(parent.manifestPath),
    rerunManifest: await readManifest(rerun.manifestPath),
  };
}
