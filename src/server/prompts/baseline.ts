import { z } from "zod";

import {
  GenerationSettingsSchema,
  ResearchRunSchema,
  canonicalSha256,
  canonicalizeJson,
  type NodeExecution,
  type ResearchRun,
} from "../../contracts";
import { normalizedSourceMetadata } from "./render";
import {
  WORKFLOW_BENCHMARK_OUTPUT_CONTRACT,
  parsePromptInput,
  promptRegistry,
  type PromptResource,
} from "./registry";

export const STRONG_BASELINE_REQUIRED_OUTPUT_FIELDS = Object.freeze([
  "claims",
  "evidenceCards",
  "conclusions",
  "researchGaps",
  "selectedGapId",
  "experimentPlanning",
  "review",
] as const);

export type BaselinePrimaryModel = {
  provider: string;
  modelId: string;
  developerFamily: string;
  baseFamily: string;
};

export type BaselineFairnessMaterial = {
  resolvedScopeHash: string;
  packetFingerprint: string;
  chunkHashes: string[];
  normalizedMetadataHash: string;
  primaryModel: BaselinePrimaryModel;
  generationLimits: {
    maxOutputTokens: number;
    timeoutMs: number;
    repairInvalidOutput: boolean;
    maximumAttempts: number;
  };
  generationSettings: NodeExecution["generationSettings"];
  outputSchema: {
    id: string;
    version: string;
    hash: string;
  };
  requiredOutputFields: string[];
  safetyConstraints: string[];
  constraintSetHash: string;
};

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PrimaryModelSchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    developerFamily: z.string().min(1),
    baseFamily: z.string().min(1),
  })
  .strict();
const GenerationLimitsInputSchema = z
  .object({
    maxOutputTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export const BaselineFairnessMaterialSchema = z
  .object({
    resolvedScopeHash: HashSchema,
    packetFingerprint: HashSchema,
    chunkHashes: z.array(HashSchema).min(1),
    normalizedMetadataHash: HashSchema,
    primaryModel: PrimaryModelSchema,
    generationLimits: GenerationLimitsInputSchema.extend({
      repairInvalidOutput: z.boolean(),
      maximumAttempts: z.union([z.literal(1), z.literal(2)]),
    }).strict(),
    generationSettings: GenerationSettingsSchema,
    outputSchema: z
      .object({
        id: z.string().min(1),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        hash: HashSchema,
      })
      .strict(),
    requiredOutputFields: z.array(z.string().min(1)).min(1),
    safetyConstraints: z.array(z.string().min(1)).min(1),
    constraintSetHash: HashSchema,
  })
  .strict();

type FairnessInput = {
  run: ResearchRun;
  primaryModel: BaselinePrimaryModel;
  generationLimits: {
    maxOutputTokens: number;
    timeoutMs: number;
  };
};

function assertFairnessRun(run: ResearchRun): void {
  if (
    run.scopeDecision === null ||
    run.packet === null ||
    run.sources.length === 0 ||
    run.chunks.length === 0
  ) {
    throw new TypeError(
      "Baseline fairness requires resolved scope and a nonempty frozen packet.",
    );
  }
  if (
    run.sources.some(
      ({ rights }) => rights.maySendToModel !== "allowed",
    )
  ) {
    throw new TypeError(
      "Baseline fairness cannot include sources without model-send rights.",
    );
  }
  const sourceHashes = run.sources.map(({ contentHash }) => contentHash).sort();
  const chunkHashes = run.chunks.map(({ contentHash }) => contentHash).sort();
  if (
    canonicalizeJson(sourceHashes) !==
      canonicalizeJson([...run.packet.sourceHashes].sort()) ||
    canonicalizeJson(chunkHashes) !==
      canonicalizeJson([...run.packet.chunkHashes].sort())
  ) {
    throw new TypeError(
      "Baseline fairness requires exact frozen packet membership.",
    );
  }
}

function commonFairnessMaterial(input: FairnessInput) {
  const run = ResearchRunSchema.parse(structuredClone(input.run));
  const primaryModel = PrimaryModelSchema.parse(
    structuredClone(input.primaryModel),
  );
  const requestedLimits = GenerationLimitsInputSchema.parse(
    structuredClone(input.generationLimits),
  );
  assertFairnessRun(run);
  return {
    run,
    requestedLimits,
    resolvedScopeHash: canonicalSha256({
      intake: run.intake,
      claims: run.claims,
      scopeDecision: run.scopeDecision,
    }),
    packetFingerprint: run.packet!.fingerprint,
    chunkHashes: run.chunks.map(({ contentHash }) => contentHash).sort(),
    normalizedMetadataHash: canonicalSha256(normalizedSourceMetadata(run)),
    primaryModel,
  };
}

function promptParityFields(resource: PromptResource) {
  return {
    generationLimits: {
      maxOutputTokens: resource.generationSettings.maxOutputTokens,
      timeoutMs: resource.timeoutMs,
      repairInvalidOutput: resource.repairInvalidOutput,
      maximumAttempts: resource.maximumAttempts,
    },
    generationSettings: structuredClone(resource.generationSettings),
    safetyConstraints: [...resource.safetyRules],
    constraintSetHash: resource.constraintSet.hash,
  };
}

function assertRequestedLimits(
  requested: FairnessInput["generationLimits"],
  resource: PromptResource,
  condition: string,
): void {
  if (
    requested.maxOutputTokens !==
      resource.generationSettings.maxOutputTokens ||
    requested.timeoutMs !== resource.timeoutMs
  ) {
    throw new TypeError(
      `${condition} generation limits do not match its versioned prompt resources.`,
    );
  }
}

function baselineRequiredFields(resource: PromptResource): string[] {
  const required = resource.outputSchema.jsonSchema.required;
  if (
    !Array.isArray(required) ||
    required.some((field) => typeof field !== "string")
  ) {
    throw new TypeError(
      "Baseline output schema must declare every required output field.",
    );
  }
  return [...required] as string[];
}

/**
 * Workflow benchmarking derives its parity material before any workflow
 * intermediate outputs exist. Reviewer identity and call counts are excluded.
 */
export function deriveWorkflowFairnessMaterial(
  input: FairnessInput,
): BaselineFairnessMaterial {
  const common = commonFairnessMaterial(input);
  const workflowResources = [
    "clarify-and-decompose",
    "extract-evidence",
    "assess-entailment",
    "synthesize-conclusions",
    "plan-experiment",
    "revise-experiment",
  ].map((nodeId) =>
    promptRegistry.forNode(
      nodeId as Exclude<
        Parameters<typeof promptRegistry.forNode>[0],
        "collect-sources" | "review-experiment"
      >,
    ),
  );
  const first = workflowResources[0]!;
  assertRequestedLimits(
    common.requestedLimits,
    first,
    "Workflow primary",
  );
  const expectedPolicy = canonicalizeJson(promptParityFields(first));
  for (const resource of workflowResources.slice(1)) {
    assertRequestedLimits(
      common.requestedLimits,
      resource,
      `Workflow node ${resource.nodeId}`,
    );
    if (
      canonicalizeJson(promptParityFields(resource)) !== expectedPolicy
    ) {
      throw new TypeError(
        "Workflow primary prompt resources have divergent limits, generation settings, or safety constraints.",
      );
    }
  }
  return BaselineFairnessMaterialSchema.parse({
    resolvedScopeHash: common.resolvedScopeHash,
    packetFingerprint: common.packetFingerprint,
    chunkHashes: common.chunkHashes,
    normalizedMetadataHash: common.normalizedMetadataHash,
    primaryModel: common.primaryModel,
    ...promptParityFields(first),
    outputSchema: {
      id: WORKFLOW_BENCHMARK_OUTPUT_CONTRACT.id,
      version: WORKFLOW_BENCHMARK_OUTPUT_CONTRACT.version,
      hash: WORKFLOW_BENCHMARK_OUTPUT_CONTRACT.hash,
    },
    requiredOutputFields: [...STRONG_BASELINE_REQUIRED_OUTPUT_FIELDS],
  });
}

/**
 * Baseline rendering derives parity material from the baseline's direct input,
 * independently of workflow intermediate state.
 */
export function deriveBaselineFairnessMaterial(
  input: FairnessInput,
): BaselineFairnessMaterial {
  const common = commonFairnessMaterial(input);
  const resource = promptRegistry.baseline();
  assertRequestedLimits(
    common.requestedLimits,
    resource,
    "Strong baseline",
  );
  return BaselineFairnessMaterialSchema.parse({
    resolvedScopeHash: common.resolvedScopeHash,
    packetFingerprint: common.packetFingerprint,
    chunkHashes: common.chunkHashes,
    normalizedMetadataHash: common.normalizedMetadataHash,
    primaryModel: common.primaryModel,
    ...promptParityFields(resource),
    outputSchema: {
      id: resource.outputSchema.id,
      version: resource.outputSchema.version,
      hash: resource.outputSchema.hash,
    },
    requiredOutputFields: baselineRequiredFields(resource),
  });
}

export type BaselineFairnessMismatch =
  | "resolvedScope"
  | "packetFingerprint"
  | "chunks"
  | "normalizedMetadata"
  | "primaryModel"
  | "generationLimits"
  | "generationSettings"
  | "outputSchema"
  | "requiredOutputFields"
  | "safetyConstraints";

export class BaselineFairnessError extends Error {
  readonly mismatchFields: readonly BaselineFairnessMismatch[];

  constructor(mismatchFields: readonly BaselineFairnessMismatch[]) {
    super(
      `Baseline fairness mismatch: ${mismatchFields.join(", ")}`,
    );
    this.name = "BaselineFairnessError";
    this.mismatchFields = Object.freeze([...mismatchFields]);
  }
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

export function validateBaselineFairness(input: {
  workflow: BaselineFairnessMaterial;
  baseline: BaselineFairnessMaterial;
}): { mismatchFields: readonly BaselineFairnessMismatch[] } {
  const workflow = BaselineFairnessMaterialSchema.parse(
    structuredClone(input.workflow),
  );
  const baseline = BaselineFairnessMaterialSchema.parse(
    structuredClone(input.baseline),
  );
  const mismatches: BaselineFairnessMismatch[] = [];
  if (workflow.resolvedScopeHash !== baseline.resolvedScopeHash) {
    mismatches.push("resolvedScope");
  }
  if (workflow.packetFingerprint !== baseline.packetFingerprint) {
    mismatches.push("packetFingerprint");
  }
  if (!equal(workflow.chunkHashes, baseline.chunkHashes)) {
    mismatches.push("chunks");
  }
  if (workflow.normalizedMetadataHash !== baseline.normalizedMetadataHash) {
    mismatches.push("normalizedMetadata");
  }
  if (!equal(workflow.primaryModel, baseline.primaryModel)) {
    mismatches.push("primaryModel");
  }
  if (!equal(workflow.generationLimits, baseline.generationLimits)) {
    mismatches.push("generationLimits");
  }
  if (!equal(workflow.generationSettings, baseline.generationSettings)) {
    mismatches.push("generationSettings");
  }
  if (!equal(workflow.outputSchema, baseline.outputSchema)) {
    mismatches.push("outputSchema");
  }
  if (!equal(workflow.requiredOutputFields, baseline.requiredOutputFields)) {
    mismatches.push("requiredOutputFields");
  }
  if (
    !equal(workflow.safetyConstraints, baseline.safetyConstraints) ||
    workflow.constraintSetHash !== baseline.constraintSetHash
  ) {
    mismatches.push("safetyConstraints");
  }
  if (mismatches.length > 0) {
    throw new BaselineFairnessError(mismatches);
  }
  return { mismatchFields: Object.freeze([]) };
}

export function buildStrongBaselineRequest(input: FairnessInput & {
  workflowCallCount: number;
  reviewerModelFamily: string;
}) {
  const reporting = z
    .object({
      workflowCallCount: z.number().int().positive(),
      reviewerModelFamily: z.string().min(1),
    })
    .strict()
    .parse({
      workflowCallCount: input.workflowCallCount,
      reviewerModelFamily: input.reviewerModelFamily,
    });
  if (reporting.reviewerModelFamily === input.primaryModel.baseFamily) {
    throw new TypeError(
      "Adversarial reviewer base family must differ from the primary base family.",
    );
  }
  const run = ResearchRunSchema.parse(structuredClone(input.run));
  const workflow = deriveWorkflowFairnessMaterial(input);
  const baseline = deriveBaselineFairnessMaterial(input);
  const fairness = validateBaselineFairness({ workflow, baseline });
  const resource = promptRegistry.baseline();
  const payload = {
    resolvedScope: {
      intake: run.intake,
      claims: run.claims,
      scopeDecision: run.scopeDecision,
    },
    packet: run.packet,
    normalizedMetadata: normalizedSourceMetadata(run),
    chunks: run.chunks,
    primaryModel: baseline.primaryModel,
    generationLimits: baseline.generationLimits,
    generationSettings: baseline.generationSettings,
    outputSchema: baseline.outputSchema,
    requiredOutputFields: baseline.requiredOutputFields,
    safetyConstraints: baseline.safetyConstraints,
    constraintSetHash: baseline.constraintSetHash,
  };
  const validatedInput = parsePromptInput("strong-baseline", {
    kind: "evidenceforge.prompt-input.v1",
    nodeId: "strong-baseline",
    inputRefs: [
      baseline.resolvedScopeHash,
      baseline.packetFingerprint,
      ...baseline.chunkHashes,
    ],
    payload,
  });
  return {
    promptId: resource.id,
    promptVersion: resource.version,
    promptHash: resource.hash,
    messages: [
      ...resource.messages,
      {
        role: "user" as const,
        content: canonicalizeJson(validatedInput),
      },
    ],
    settings: resource.generationSettings,
    timeoutMs: resource.timeoutMs,
    repairInvalidOutput: resource.repairInvalidOutput,
    maximumAttempts: resource.maximumAttempts,
    outputSchema: resource.outputSchema,
    fairness,
    baselineCallCount: 1 as const,
    workflowCallCount: reporting.workflowCallCount,
    reviewerModelFamily: reporting.reviewerModelFamily,
  };
}
