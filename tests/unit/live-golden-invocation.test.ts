import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  canonicalSha256,
  canonicalizeJson,
  freezePacket,
  type ResearchRun,
} from "../../src/contracts";
import {
  APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
  COMPACT_EVIDENCE_PREDECESSOR_NODE_CONFIGURATION_HASH,
  COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST,
  COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH,
  COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_VERSION,
  COMPUTED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH,
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS,
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST,
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_VERSION,
  HISTORICAL_PROMPT_MANIFEST,
  HISTORICAL_PROMPT_MANIFEST_HASH,
  HISTORICAL_PROMPT_MANIFEST_VERSION,
  MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
  MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS,
  MISTRAL_SHARED_TIMEOUT_PREDECESSOR_PROMPT_MANIFEST,
  MISTRAL_SHARED_TIMEOUT_PREDECESSOR_VERSION,
  R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH,
  R10_PLANNING_PREDECESSOR_COMPARISON_HASH,
  R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH,
  R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS,
  R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST,
  R11_DEEPSEEK_PREDECESSOR_COMPARISON_HASH,
  R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH,
  R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS,
  R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST,
  R11_DEEPSEEK_PREDECESSOR_VERSION,
  createLiveGoldenArtifactConfig,
  materializeLiveGoldenArtifact,
  reopenLiveGoldenArtifact,
  type LiveGoldenArtifactConfig,
} from "../../evals/live-golden/v1";
import type { AdapterRuntime } from "../../src/server/models";
import { promptRegistry } from "../../src/server/prompts/registry";
import {
  APPROVED_LIVE_GOLDEN_AUTHORITY,
  COMPUTED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH,
  COMPUTED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
  LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS,
  LIVE_GOLDEN_MAX_OUTPUT_TOKENS,
  LIVE_GOLDEN_OUTPUT_LIMIT_POLICY_VERSION,
  LIVE_GOLDEN_STRUCTURED_OUTPUT_TRANSPORT_POLICY,
  LIVE_GOLDEN_TIMEOUT_POLICY,
  LIVE_GOLDEN_TIMEOUT_POLICY_VERSION,
  LiveGoldenPreflightError,
  runMockedApprovedLiveGoldenInvocation,
  assertApprovedLiveGoldenAuthority,
  runApprovedLiveGoldenInvocation,
} from "../../src/server/workflow/live-golden-invocation";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function artifactRoot() {
  const root = await mkdtemp(join(tmpdir(), "evidenceforge-live-golden-"));
  roots.push(root);
  return root;
}

const primarySecret = "offline-primary-secret";
const reviewerSecret = "offline-reviewer-secret";

function providerResponse(
  model: string,
  output: unknown,
  overrides: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      id: "response-id",
      model,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(output), refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      request_id: "provider-request-id",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function adapterRuntime(
  transport: AdapterRuntime["transport"],
  namespace: string,
): Partial<AdapterRuntime> {
  let id = 0;
  let tick = 0;
  return {
    transport,
    now: () => new Date(1_786_246_400_000 + tick++ * 1_000),
    monotonicNow: () => tick++ * 10,
    makeId: (prefix) => `${namespace}-${prefix}-${++id}`,
    sleep: async () => {},
  };
}

function invocationInput(
  root: string,
  transports: {
    primary: AdapterRuntime["transport"];
    reviewer: AdapterRuntime["transport"];
  },
) {
  let workflowTick = 0;
  let workflowId = 0;
  return {
    artifactRoot: root,
    codeVersion: "a".repeat(40),
    providerEnvironment: {
      primaryProvider: "featherless" as const,
      primaryModel: "mistralai/Mistral-Large-Instruct-2411" as const,
      reviewerProvider: "featherless" as const,
      reviewerModel: "Qwen/Qwen2.5-72B-Instruct" as const,
      featherlessApiKey: primarySecret,
    },
    decisions: {
      objections: (run: typeof goldenRunV01) => {
        const dispositions = run.review!.objections.map((objection) => {
          const frozen = goldenRunV01.revision!.decisions.find(
            ({ objectionId }) => objectionId === objection.id,
          )!;
          return {
            objectionId: objection.id,
            disposition: frozen.disposition,
            basis: frozen.basis,
          };
        });
        return {
          decision: {
            id: "live-objection-decision",
            checkpoint: "objection_dispositions" as const,
            optionsShown: ["approve", "request revision", "reject"],
            decision: "approve",
            edits: [],
            decidedAt: new Date(Date.parse(run.updatedAt) + 1).toISOString(),
            unresolvedObjections: dispositions
              .filter(({ disposition }) => disposition === "unresolved")
              .map(({ objectionId }) => objectionId),
          },
          dispositions,
        };
      },
      final: () => ({
        choice: "approve" as const,
        declaredActor: "authorized live-golden operator",
        rationale: "Approve only the bounded reviewed educational artifact.",
      }),
    },
    runtime: {
      primary: adapterRuntime(transports.primary, "featherless-primary"),
      reviewer: adapterRuntime(transports.reviewer, "featherless-reviewer"),
      workflow: {
        now: () => new Date(1_786_246_400_000 + workflowTick++ * 1_000),
        makeId: (prefix: string) => `${prefix}-${++workflowId}`,
      },
    },
  };
}

function successfulPrimaryOutputs() {
  const evidenceIdMap = new Map(
    goldenRunV01.evidenceCards.map((card) => [
      card.id,
      `evidence-${canonicalSha256({
        subclaimId: card.subclaimId,
        sourceChunkId: card.sourceChunkId,
        excerpt: card.excerpt,
      })}`,
    ]),
  );
  const currentId = (id: string) => evidenceIdMap.get(id) ?? id;
  const gapCandidates = goldenRunV01.researchGaps.map(
    ({
      affectedSubclaimIds,
      type,
      impactRationale,
      tractabilityRationale,
      evidenceCardIds,
    }) => ({
      affectedSubclaimIds,
      type,
      impactRationale,
      tractabilityRationale,
      evidenceCardIds: evidenceCardIds.map(currentId),
    }),
  );
  const selectedGapIndex = goldenRunV01.researchGaps.findIndex(
    ({ id }) => id === goldenRunV01.selectedGapId,
  );
  const planningExperiment = structuredClone(
    goldenRunV01.experiment!,
  ) as Record<string, unknown>;
  delete planningExperiment.selectedGapId;
  delete planningExperiment.qualifiedReviewRequired;
  planningExperiment.supportingEvidenceCardIds =
    gapCandidates[selectedGapIndex]!.evidenceCardIds;
  return [
    {
      evidenceCandidates: goldenRunV01.evidenceCards.map(
        ({
          subclaimId,
          sourceChunkId,
          excerpt,
          extractedResult,
          settingAndSample,
          studyType,
          limitation,
          extractionIssues,
        }) => ({
          subclaimId,
          sourceChunkId,
          excerpt,
          extractedResult,
          settingAndSample,
          studyType,
          limitation,
          extractionIssues,
        }),
      ),
    },
    {
      entailmentDeltas: goldenRunV01.evidenceCards.map((card) => ({
        evidenceCardId: currentId(card.id),
        relationship: card.relationship,
        entailment: card.modelAssessment.entailment,
        rationale: card.modelAssessment.rationale,
        conclusionStrengthWarning: card.conclusionStrengthWarning,
      })),
    },
    {
      conclusions: goldenRunV01.conclusions.map(
        ({
          subclaimId,
          strength,
          conclusion,
          disagreementSummary,
          limitations,
          changeEvidence,
          overclaimingWarnings,
        }) => ({
          subclaimId,
          strength,
          conclusion,
          disagreementSummary,
          limitations,
          changeEvidence,
          overclaimingWarnings,
        }),
      ),
      researchGaps: gapCandidates,
      selectedGapIndex,
    },
    {
      disposition: "proposed",
      experiment: planningExperiment,
      abstention: null,
    },
    { revision: goldenRunV01.revision },
  ];
}

function successfulReviewerOutput() {
  const evidenceIdMap = new Map(
    goldenRunV01.evidenceCards.map((card) => [
      card.id,
      `evidence-${canonicalSha256({
        subclaimId: card.subclaimId,
        sourceChunkId: card.sourceChunkId,
        excerpt: card.excerpt,
      })}`,
    ]),
  );
  return {
    review: {
      ...goldenRunV01.review!,
      objections: goldenRunV01.review!.objections.map((objection) => ({
        ...objection,
        evidenceCardIds: objection.evidenceCardIds.map(
          (id) => evidenceIdMap.get(id) ?? id,
        ),
      })),
    },
  };
}

function historicalPromptManifest(
  manifestInput: unknown,
): Array<Record<string, unknown>> {
  return (manifestInput as Array<Record<string, unknown>>).map((item) =>
    item.id === "extract-grounded-evidence"
      ? {
          id: item.id,
          version: "1.0.0",
          hash: "e1129746a245922b8843522d0853921b9d4b37fc3a820abc19dc5d24e75bd0d4",
        }
      : item.id === "assess-evidence-entailment"
        ? {
            id: item.id,
            version: "1.0.0",
            hash: "ca4924bb6987012a9b79ef59e3cd9c50d8a44f256b34ae7c3e358a4ab03a2cc2",
          }
        : item.id === "synthesize-conclusions-gaps"
          ? {
              id: item.id,
              version: "1.0.0",
              hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
            }
          : item.id === "design-reviewable-experiment"
            ? {
                id: item.id,
                version: "1.0.0",
                hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
              }
          : item,
  );
}

function historicalEvidenceResource(
  item: Record<string, unknown>,
): Record<string, unknown> {
  item = sharedTimeoutPredecessorResource(item);
  const history =
    item.nodeId === "extract-evidence"
      ? {
          hash: "e1129746a245922b8843522d0853921b9d4b37fc3a820abc19dc5d24e75bd0d4",
        }
      : item.nodeId === "assess-entailment"
        ? {
            hash: "ca4924bb6987012a9b79ef59e3cd9c50d8a44f256b34ae7c3e358a4ab03a2cc2",
          }
        : item.nodeId === "synthesize-conclusions"
          ? {
              hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
            }
          : null;
  return history === null
    ? item
    : {
        ...item,
        version: "1.0.0",
        hash: history.hash,
        outputSchema: {
          ...(item.outputSchema as Record<string, unknown>),
          version: "1.0.0",
          hash:
            item.nodeId === "synthesize-conclusions"
              ? "2ac519b4c1d61df9e2e20bf6450954c7fb9fa3c1200b9e4cb45b1bcbeedde975"
              : "9aa9120dfa686dd40edb4a28f6b5b825b239749a0c45daf2b8136c328aa508ea",
        },
      };
}

function sharedTimeoutPredecessorResource(
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (item.nodeId === "plan-experiment") {
    return structuredClone(
      MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS.find(
        ({ nodeId }) => nodeId === "plan-experiment",
      )!,
    );
  }
  const predecessor = Object.fromEntries(
    Object.entries(item).filter(
      ([key]) =>
        key !== "timeoutScope" &&
        key !== "maximumTransportBudgetMs" &&
        key !== "maximumRetryBackoffMs",
    ),
  );
  return { ...predecessor, timeoutPolicyVersion: "1.0.0" };
}

function historicalExecutionPrompt<T extends Record<string, unknown>>(
  execution: T,
): T {
  const prompt =
    execution.nodeId === "extract-evidence"
      ? {
          promptVersion: "1.0.0",
          promptHash:
            "e1129746a245922b8843522d0853921b9d4b37fc3a820abc19dc5d24e75bd0d4",
        }
      : execution.nodeId === "assess-entailment"
        ? {
            promptVersion: "1.0.0",
            promptHash:
              "ca4924bb6987012a9b79ef59e3cd9c50d8a44f256b34ae7c3e358a4ab03a2cc2",
          }
        : execution.nodeId === "synthesize-conclusions"
          ? {
              promptVersion: "1.0.0",
              promptHash:
                "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
            }
          : execution.nodeId === "plan-experiment"
            ? {
                promptVersion: "1.0.0",
                promptHash:
                  "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
              }
          : null;
  return (prompt === null ? execution : { ...execution, ...prompt }) as T;
}

function planningPredecessorPrompt<T extends Record<string, unknown>>(
  execution: T,
): T {
  return (execution.nodeId === "plan-experiment"
    ? {
        ...execution,
        promptVersion: "1.0.0",
        promptHash:
          "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
      }
    : execution) as T;
}

function withHistoricalDeepSeekReviewerConfig<
  T extends Record<string, unknown>,
>(config: T): T & { reviewerModel: Record<string, string> } {
  return {
    ...config,
    reviewerModel: {
      provider: "featherless",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      developerFamily: "deepseek",
      baseFamily: "deepseek-v4",
    },
  };
}

function withHistoricalDeepSeekReviewerExecution<
  T extends ResearchRun["executions"][number],
>(execution: T): T {
  if (execution.nodeId !== "review-experiment") return execution;
  return {
    ...execution,
    requestedModelId: "deepseek-ai/DeepSeek-V4-Flash",
    returnedModelId:
      execution.returnedModelId === null
        ? null
        : "deepseek-ai/DeepSeek-V4-Flash",
    requestedDeveloperFamily: "deepseek",
    returnedDeveloperFamily:
      execution.returnedDeveloperFamily === null ? null : "deepseek",
    requestedBaseFamily: "deepseek-v4",
    returnedBaseFamily:
      execution.returnedBaseFamily === null ? null : "deepseek-v4",
  };
}

function withHistoricalConfiguredCostBasis(configInput: unknown) {
  return {
    ...(structuredClone(configInput) as Record<string, unknown>),
    costBasis: {
      primary: {
        currency: "USD",
        inputPerMillionTokens: 0.15,
        cachedInputPerMillionTokens: 0.075,
        outputPerMillionTokens: 0.6,
        snapshotDate: "2026-08-06",
      },
      reviewer: {
        currency: "CRD",
        inputPerMillionTokens: 1,
        cachedInputPerMillionTokens: null,
        outputPerMillionTokens: 1,
        snapshotDate: "2026-08-09",
      },
    },
  };
}

function historicalQwenConfig(
  configInput: unknown,
  timeoutMs: 30_000 | 120_000,
) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const nodeConfigurations = config.nodeConfigurations.map((item) => {
    const historical = {
      ...historicalEvidenceResource(item),
      generationSettings: {
        ...(item.generationSettings as Record<string, unknown>),
        maxOutputTokens: 4096,
      },
      timeoutMs,
    };
    return Object.fromEntries(
      Object.entries(historical).filter(
        ([key]) =>
          key !== "outputLimitPolicyVersion" &&
          key !== "structuredOutputTransportPolicy" &&
          key !== "timeoutScope" &&
          key !== "maximumTransportBudgetMs" &&
          key !== "maximumRetryBackoffMs" &&
          (timeoutMs === 120_000 || key !== "timeoutPolicyVersion"),
      ),
    );
  });
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash:
      "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e",
    promptManifest: historicalPromptManifest(config.promptManifest),
    primaryModel: {
      provider: "featherless",
      modelId: "Qwen/Qwen3.5-397B-A17B",
      developerFamily: "qwen",
      baseFamily: "qwen3.5",
    },
    nodeConfigurations,
    nodeConfigurationHash:
      timeoutMs === 30_000
        ? "d3a34da9017151599d34c1971a004264e9886c8e1ced6f6cbd392f52dd3e9ffb"
        : "09819024f1e35457c0af7198b7a501064c3c069e66987b5cb724779954c4570f",
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function historicalGptOssConfig(configInput: unknown) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const nodeConfigurations = config.nodeConfigurations.map((item) =>
    Object.fromEntries(
      Object.entries({
        ...historicalEvidenceResource(item),
        generationSettings: {
          ...(item.generationSettings as Record<string, unknown>),
          maxOutputTokens: 4096,
        },
      }).filter(
        ([key]) =>
          key !== "outputLimitPolicyVersion" &&
          key !== "structuredOutputTransportPolicy",
      ),
    ),
  );
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash:
      "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e",
    promptManifest: historicalPromptManifest(config.promptManifest),
    primaryModel: {
      provider: "featherless",
      modelId: "openai/gpt-oss-120b",
      developerFamily: "openai",
      baseFamily: "gpt-oss",
    },
    nodeConfigurations,
    nodeConfigurationHash:
      "09819024f1e35457c0af7198b7a501064c3c069e66987b5cb724779954c4570f",
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function immediatePredecessorConfig(configInput: unknown) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash:
      "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e",
    promptManifest: historicalPromptManifest(config.promptManifest),
    primaryModel: {
      provider: "featherless",
      modelId: "openai/gpt-oss-120b",
      developerFamily: "openai",
      baseFamily: "gpt-oss",
    },
    nodeConfigurations: config.nodeConfigurations.map((item) =>
      Object.fromEntries(
        Object.entries(historicalEvidenceResource(item)).filter(
          ([key]) => key !== "structuredOutputTransportPolicy",
        ),
      ),
    ),
    nodeConfigurationHash:
      "3347ac013a0ce0af3cf2b8ef1e35abb75217422d3d782d9066e6c724bd375215",
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function compactEvidencePredecessorConfig(configInput: unknown) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const nodeConfigurations = config.nodeConfigurations.map((item) => {
    const sharedTimeoutPredecessor = sharedTimeoutPredecessorResource(item);
    const predecessor = item.nodeId === "synthesize-conclusions"
      ? {
          ...sharedTimeoutPredecessor,
          id: "synthesize-conclusions-gaps",
          version: "1.0.0",
          hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
          outputSchema: {
            id: "synthesis-and-gap-output",
            version: "1.0.0",
            hash: "2ac519b4c1d61df9e2e20bf6450954c7fb9fa3c1200b9e4cb45b1bcbeedde975",
          },
        }
      : sharedTimeoutPredecessor;
    return Object.fromEntries(
      Object.entries(predecessor).filter(
        ([key]) => key !== "structuredOutputTransportPolicy",
      ),
    );
  });
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash:
      COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH,
    promptManifest: COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST,
    primaryModel: {
      provider: "featherless",
      modelId: "openai/gpt-oss-120b",
      developerFamily: "openai",
      baseFamily: "gpt-oss",
    },
    nodeConfigurations,
    nodeConfigurationHash:
      COMPACT_EVIDENCE_PREDECESSOR_NODE_CONFIGURATION_HASH,
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function gptOssStructuredOutputPredecessorConfig(configInput: unknown) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash: R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH,
    promptManifest: GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST,
    primaryModel: {
      provider: "featherless",
      modelId: "openai/gpt-oss-120b",
      developerFamily: "openai",
      baseFamily: "gpt-oss",
    },
    nodeConfigurations: config.nodeConfigurations.map((item) =>
      Object.fromEntries(
        Object.entries(sharedTimeoutPredecessorResource(item)).filter(
          ([key]) => key !== "structuredOutputTransportPolicy",
        ),
      ),
    ),
    nodeConfigurationHash:
      GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function mistralSharedTimeoutPredecessorConfig(configInput: unknown) {
  const config = withHistoricalConfiguredCostBasis(configInput) as unknown as Record<string, unknown> & {
    nodeConfigurations: Array<Record<string, unknown>>;
  };
  const payload: Record<string, unknown> = {
    ...config,
    ...withHistoricalDeepSeekReviewerConfig(config),
    promptManifestHash: R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH,
    promptManifest: MISTRAL_SHARED_TIMEOUT_PREDECESSOR_PROMPT_MANIFEST,
    nodeConfigurations: config.nodeConfigurations.map(
      sharedTimeoutPredecessorResource,
    ),
    nodeConfigurationHash:
      MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function compactEvidencePredecessorRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.executions = run.executions.map((executionInput) => {
    const execution = planningPredecessorPrompt(
      gptOssExecutionIdentity(executionInput),
    );
    return execution.nodeId === "synthesize-conclusions"
      ? {
          ...execution,
          promptVersion: "1.0.0",
          promptHash:
            "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
        }
      : execution;
  });
  return run;
}

function immediatePredecessorRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.executions = run.executions.map((execution) =>
    gptOssExecutionIdentity(historicalExecutionPrompt(execution)),
  );
  return run;
}

function historicalQwenRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.executions = run.executions.map((executionInput) => {
    const execution = historicalExecutionPrompt(executionInput);
    return (
    execution.nodeId === "review-experiment"
      ? {
          ...withHistoricalDeepSeekReviewerExecution(execution),
          generationSettings: {
            ...execution.generationSettings,
            maxOutputTokens: 4096,
          },
        }
      : {
          ...execution,
          requestedModelId: "Qwen/Qwen3.5-397B-A17B",
          returnedModelId:
            execution.returnedModelId === null
              ? null
              : "Qwen/Qwen3.5-397B-A17B",
          requestedDeveloperFamily: "qwen",
          returnedDeveloperFamily:
            execution.returnedDeveloperFamily === null ? null : "qwen",
          requestedBaseFamily: "qwen3.5",
          returnedBaseFamily:
            execution.returnedBaseFamily === null ? null : "qwen3.5",
          generationSettings: {
            ...execution.generationSettings,
            maxOutputTokens: 4096,
          },
        }
    );
  });
  return run;
}

function gptOssExecutionIdentity<T extends ResearchRun["executions"][number]>(
  execution: T,
): T {
  if (execution.nodeId === "review-experiment") {
    return withHistoricalDeepSeekReviewerExecution(execution);
  }
  return {
    ...execution,
    requestedModelId: "openai/gpt-oss-120b",
    returnedModelId:
      execution.returnedModelId === null ? null : "openai/gpt-oss-120b",
    requestedDeveloperFamily: "openai",
    returnedDeveloperFamily:
      execution.returnedDeveloperFamily === null ? null : "openai",
    requestedBaseFamily: "gpt-oss",
    returnedBaseFamily:
      execution.returnedBaseFamily === null ? null : "gpt-oss",
  };
}

function gptOssStructuredOutputPredecessorRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.executions = run.executions.map((execution) =>
    planningPredecessorPrompt(gptOssExecutionIdentity(execution)),
  );
  return run;
}

function r10PlanningPredecessorConfig(configInput: unknown) {
  const payload: Record<string, unknown> = {
    ...(structuredClone(configInput) as Record<string, unknown>),
    reviewerModel: {
      provider: "featherless",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      developerFamily: "deepseek",
      baseFamily: "deepseek-v4",
    },
    evidenceMode: "live",
    codeVersion: "db460a29f284f6cb813c370ed2a1846a46c0e0a5",
    costBasis: {
      primary: {
        cachedInputPerMillionTokens: null,
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
      reviewer: {
        cachedInputPerMillionTokens: null,
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
    },
    promptManifestHash: R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH,
    promptManifest: R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST,
    nodeConfigurations: R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS,
    nodeConfigurationHash: R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH,
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function r10PlanningPredecessorRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.evidenceMode = "live";
  run.executions = run.executions.map((execution) => ({
    ...withHistoricalDeepSeekReviewerExecution(
      planningPredecessorPrompt(execution),
    ),
    evidenceMode: "live" as const,
  }));
  return run;
}

function r11DeepSeekPredecessorConfig(configInput: unknown) {
  const payload: Record<string, unknown> = {
    ...(structuredClone(configInput) as Record<string, unknown>),
    evidenceMode: "live",
    codeVersion: "17969fec472a8641a765b03366f85944324693af",
    costBasis: {
      primary: {
        cachedInputPerMillionTokens: null,
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
      reviewer: {
        cachedInputPerMillionTokens: null,
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
    },
    reviewerModel: {
      provider: "featherless",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      developerFamily: "deepseek",
      baseFamily: "deepseek-v4",
    },
    promptManifestHash:
      "f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2",
    promptManifest: R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST,
    nodeConfigurations: R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS,
    nodeConfigurationHash:
      R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH,
  };
  delete payload.comparisonInvalidatingHash;
  return {
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  };
}

function r11DeepSeekPredecessorRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.evidenceMode = "live";
  run.executions = run.executions.map((execution) => ({
    ...execution,
    evidenceMode: "live" as const,
    codeVersion: "17969fec472a8641a765b03366f85944324693af",
    ...(execution.nodeId === "review-experiment"
      ? {
          requestedModelId: "deepseek-ai/DeepSeek-V4-Flash",
          returnedModelId:
            execution.returnedModelId === null
              ? null
              : "deepseek-ai/DeepSeek-V4-Flash",
          requestedDeveloperFamily: "deepseek",
          returnedDeveloperFamily:
            execution.returnedDeveloperFamily === null ? null : "deepseek",
          requestedBaseFamily: "deepseek-v4",
          returnedBaseFamily:
            execution.returnedBaseFamily === null ? null : "deepseek-v4",
        }
      : {}),
    pricing: {
      currency: "USD",
      inputPerMillionTokens: 0,
      outputPerMillionTokens: 0,
      estimatedCost: 0,
      snapshotDate: "2026-08-11",
    },
  }));
  return run;
}

function historicalGptOssRun(runInput: ResearchRun) {
  const run = structuredClone(runInput);
  run.executions = run.executions.map((executionInput) => ({
    ...gptOssExecutionIdentity(historicalExecutionPrompt(executionInput)),
    generationSettings: {
      ...executionInput.generationSettings,
      maxOutputTokens: 4096,
    },
  }));
  return run;
}

async function rewriteAsHistoricalQwenArtifact(
  manifestPath: string,
  configInput: unknown,
  runInput: ResearchRun,
  timeoutMs: 30_000 | 120_000,
) {
  const config = historicalQwenConfig(configInput, timeoutMs);
  const run = historicalQwenRun(runInput);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runPath = dirname(manifestPath);
  for (const entry of manifest.artifacts as Array<{
    kind: string;
    path: string;
    sha256: string;
  }>) {
    let value: unknown;
    if (entry.kind === "config") {
      value = config;
    } else if (entry.kind === "canonical_run") {
      value = run;
    } else if (entry.kind === "attempt") {
      const index = Number(entry.path.match(/(\d+)\.json$/)?.[1]) - 1;
      value = run.executions[index];
    } else {
      continue;
    }
    const content = `${canonicalizeJson(value)}\n`;
    await writeFile(join(runPath, ...entry.path.split("/")), content, "utf8");
    entry.sha256 = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
  }
  manifest.configHash = canonicalSha256(config);
  manifest.canonicalRunHash = canonicalSha256(run);
  manifest.comparisonInvalidatingHash = config.comparisonInvalidatingHash;
  await writeFile(manifestPath, `${canonicalizeJson(manifest)}\n`, "utf8");
}

async function rewriteArtifactConfigAndRun(
  manifestPath: string,
  config: Record<string, unknown>,
  run: ResearchRun,
) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const entry of manifest.artifacts as Array<{
    kind: string;
    path: string;
    sha256: string;
  }>) {
    const value =
      entry.kind === "config"
        ? config
        : entry.kind === "canonical_run"
          ? run
          : entry.kind === "attempt"
            ? run.executions[
                Number(entry.path.match(/(\d+)\.json$/)?.[1]) - 1
              ]
            : undefined;
    if (value === undefined) continue;
    const content = `${canonicalizeJson(value)}\n`;
    await writeFile(
      join(dirname(manifestPath), ...entry.path.split("/")),
      content,
      "utf8",
    );
    entry.sha256 = createHash("sha256").update(content).digest("hex");
  }
  manifest.configHash = canonicalSha256(config);
  manifest.canonicalRunHash = canonicalSha256(run);
  manifest.comparisonInvalidatingHash = config.comparisonInvalidatingHash;
  manifest.evidenceMode = config.evidenceMode;
  await writeFile(
    manifestPath,
    `${canonicalizeJson(manifest)}\n`,
    "utf8",
  );
}

describe("approved live golden invocation preflight", () => {
  it("keeps the complete predecessor prompt manifest independent of unrelated current resources", () => {
    const mutatedCurrent = structuredClone(
      promptRegistry.list().map(({ id, version, hash }) => ({
        id,
        version,
        hash,
      })),
    );
    const unrelated = mutatedCurrent.find(
      ({ id }) => id === "clarify-decompose",
    )!;
    unrelated.version = "99.0.0";
    unrelated.hash = "f".repeat(64);

    expect(HISTORICAL_PROMPT_MANIFEST_VERSION).toBe("1.0.0");
    expect(canonicalSha256(HISTORICAL_PROMPT_MANIFEST)).toBe(
      HISTORICAL_PROMPT_MANIFEST_HASH,
    );
    expect(HISTORICAL_PROMPT_MANIFEST_HASH).toBe(
      "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e",
    );
    expect(
      HISTORICAL_PROMPT_MANIFEST.find(
        ({ id }) => id === "clarify-decompose",
      ),
    ).toEqual({
      id: "clarify-decompose",
      version: "1.0.0",
      hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e",
    });
    expect(canonicalSha256(mutatedCurrent)).not.toBe(
      HISTORICAL_PROMPT_MANIFEST_HASH,
    );
    expect(
      canonicalSha256(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST),
    ).toBe(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH);
    expect(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_VERSION).toBe(
      "2.0.0",
    );
    expect(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH).toBe(
      "da10bd36100bb22decedde6951fbaec8cc88d98fe14f92d0d14b582890f442ca",
    );
    expect(
      COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST.find(
        ({ id }) => id === "synthesize-conclusions-gaps",
      ),
    ).toEqual({
      id: "synthesize-conclusions-gaps",
      version: "1.0.0",
      hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
    });
  });

  it("reopens a historical Groq/NVIDIA 1.0.0 artifact under its original identity", async () => {
    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const current = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", outputs.shift()),
        reviewer: async () =>
            providerResponse("Qwen/Qwen2.5-72B-Instruct", successfulReviewerOutput()),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(current.manifestPath);
    const legacyRun = historicalGptOssRun(reopened.run);
    legacyRun.executions = legacyRun.executions.map((execution) => {
      const reviewer = execution.nodeId === "review-experiment";
      return {
        ...execution,
        requestedProvider: reviewer ? "nvidia_nim" : "groq",
        returnedProvider:
          execution.returnedProvider === null
            ? null
            : reviewer
              ? "nvidia_nim"
              : "groq",
        requestedModelId: reviewer
          ? "nvidia/nemotron-3-super-120b-a12b"
          : "openai/gpt-oss-120b",
        returnedModelId:
          execution.returnedModelId === null
            ? null
            : reviewer
              ? "nvidia/nemotron-3-super-120b-a12b"
              : "openai/gpt-oss-120b",
        requestedDeveloperFamily: reviewer ? "nvidia" : "openai",
        returnedDeveloperFamily:
          execution.returnedDeveloperFamily === null
            ? null
            : reviewer
              ? "nvidia"
              : "openai",
        requestedBaseFamily: reviewer ? "nemotron-3" : "gpt-oss",
        returnedBaseFamily:
          execution.returnedBaseFamily === null
            ? null
            : reviewer
              ? "nemotron-3"
              : "gpt-oss",
      };
    });
    const historicalConfig = historicalQwenConfig(reopened.config, 30_000);
    const currentPayload = Object.fromEntries(
      Object.entries(historicalConfig).filter(
        ([key]) => key !== "comparisonInvalidatingHash",
      ),
    );
    const legacyPayload = {
      ...currentPayload,
      schemaVersion: "1.0.0" as const,
      primaryModel: {
        provider: "groq" as const,
        modelId: "openai/gpt-oss-120b" as const,
        developerFamily: "openai",
        baseFamily: "gpt-oss",
      },
      reviewerModel: {
        provider: "nvidia_nim" as const,
        modelId: "nvidia/nemotron-3-super-120b-a12b" as const,
        developerFamily: "nvidia",
        baseFamily: "nemotron-3",
      },
    };
    const legacyConfig = {
      ...legacyPayload,
      comparisonInvalidatingHash: canonicalSha256(legacyPayload),
    };
    const runRoot = join(root, "approved-live-golden", "1.0.0", legacyRun.id);
    const artifacts: Array<{
      path: string;
      sha256: string;
      kind: "config" | "canonical_run" | "attempt" | "error";
    }> = [];
    async function persist(path: string, value: unknown, kind: (typeof artifacts)[number]["kind"]) {
      const content = `${canonicalizeJson(value)}\n`;
      const target = join(runRoot, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      artifacts.push({
        path,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        kind,
      });
    }
    await persist("config.json", legacyConfig, "config");
    for (const [index, attempt] of legacyRun.executions.entries()) {
      await persist(
        `attempts/${String(index + 1).padStart(3, "0")}.json`,
        attempt,
        "attempt",
      );
    }
    for (const [index, error] of legacyRun.errors.entries()) {
      await persist(
        `errors/${String(index + 1).padStart(3, "0")}.json`,
        error,
        "error",
      );
    }
    await persist("canonical/run.json", legacyRun, "canonical_run");
    const manifest = {
      schemaVersion: "1.0.0",
      artifactScope: "approved_live_golden",
      runId: legacyRun.id,
      status: legacyRun.status,
      evidenceMode: legacyRun.evidenceMode,
      configHash: canonicalSha256(legacyConfig),
      canonicalRunHash: canonicalSha256(legacyRun),
      comparisonInvalidatingHash: legacyConfig.comparisonInvalidatingHash,
      complete: legacyRun.status === "approved" || legacyRun.status === "rejected",
      attemptIds: legacyRun.executions.map(({ id }) => id),
      errorIds: legacyRun.errors.map(({ id }) => id),
      artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestPath = join(runRoot, "manifest.json");
    await writeFile(manifestPath, `${canonicalizeJson(manifest)}\n`, "utf8");

    const historical = await reopenLiveGoldenArtifact(manifestPath);
    expect(historical.config.schemaVersion).toBe("1.0.0");
    expect(historical.run.executions[0]).toMatchObject({
      requestedProvider: "groq",
      requestedModelId: "openai/gpt-oss-120b",
    });
    expect(historical.run.executions.find(({ nodeId }) => nodeId === "review-experiment")).toMatchObject({
      requestedProvider: "nvidia_nim",
      requestedModelId: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it.each([
    [30_000, "d3a34da9017151599d34c1971a004264e9886c8e1ced6f6cbd392f52dd3e9ffb"],
    [120_000, "09819024f1e35457c0af7198b7a501064c3c069e66987b5cb724779954c4570f"],
  ] as const)("reopens immutable Qwen Featherless 2.0.0 artifacts with the historical %i ms policy", async (timeoutMs, nodeHash) => {
    const currentRoot = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const current = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(currentRoot, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", outputs.shift()),
        reviewer: async () =>
            providerResponse("Qwen/Qwen2.5-72B-Instruct", successfulReviewerOutput()),
      }),
    );
    const reopenedCurrent = await reopenLiveGoldenArtifact(current.manifestPath);
    await rewriteAsHistoricalQwenArtifact(
      current.manifestPath,
      reopenedCurrent.config,
      reopenedCurrent.run,
      timeoutMs,
    );
    const reopenedHistorical = await reopenLiveGoldenArtifact(
      current.manifestPath,
    );

    expect(reopenedHistorical.config.nodeConfigurationHash).toBe(
      nodeHash,
    );
    expect(
      reopenedHistorical.config.nodeConfigurations.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).timeoutMs === timeoutMs &&
          (timeoutMs === 120_000 || !("timeoutPolicyVersion" in item)),
      ),
    ).toBe(true);
    expect(reopenedHistorical.config.primaryModel).toMatchObject({
      modelId: "Qwen/Qwen3.5-397B-A17B",
      developerFamily: "qwen",
      baseFamily: "qwen3.5",
    });
  });

  it("binds the exact reviewed fixture identity, source order, rights decision, and hashes", () => {
    const authority = assertApprovedLiveGoldenAuthority(goldenRunV01);

    expect(authority).toEqual(APPROVED_LIVE_GOLDEN_AUTHORITY);
    expect(authority.sourceOrder).toEqual(
      goldenRunV01.sources.map(({ id }) => id),
    );
    expect(authority.chunkOrder).toEqual(
      goldenRunV01.chunks.map(({ id }) => id),
    );
    expect(COMPUTED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH).toBe(
      "39a314781affb50826bc99f2799fba7e47a2a08faaf27a4cf39e53d09be15d34",
    );
    expect(COMPUTED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH).toBe(
      "aca24c0d26695e54a2d22986363e5ee7193366bc24fcd7a4432e02877de05b29",
    );
    expect(
      canonicalSha256({
        nodeConfigurations: R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS,
        reviewerModel: {
          provider: "featherless",
          modelId: "Qwen/Qwen2.5-72B-Instruct",
          developerFamily: "qwen",
          baseFamily: "qwen2.5",
        },
      }),
    ).toBe(APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH);
    expect(
      canonicalSha256({
        nodeConfigurations: R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS,
        reviewerModel: {
          provider: "featherless",
          modelId: "deepseek-ai/DeepSeek-V4-Flash",
          developerFamily: "deepseek",
          baseFamily: "deepseek-v4",
        },
      }),
    ).not.toBe(APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH);
    expect(COMPUTED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH).toBe(
      "0f284f3740446cb4b782be98b449cfdf4acbbc1d57d5eacb261bc91925123b87",
    );
  });

  it("freezes a live-only 2,048-token output policy while the shared registry stays at 4,096", () => {
    expect(LIVE_GOLDEN_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(LIVE_GOLDEN_OUTPUT_LIMIT_POLICY_VERSION).toBe("1.0.0");
    expect(
      promptRegistry
        .list()
        .filter(
          ({ providerCapabilities }) =>
            providerCapabilities.modelInvocation === "allowed",
        )
        .every(({ generationSettings }) =>
          generationSettings.maxOutputTokens === 4096,
        ),
    ).toBe(true);
  });

  it("freezes Featherless JSON mode without replacing prompt schema or application validation", () => {
    expect(LIVE_GOLDEN_STRUCTURED_OUTPUT_TRANSPORT_POLICY).toEqual({
      version: "1.0.0",
      responseFormat: "json_object",
      promptSchemaAppended: true,
      applicationValidation: true,
    });
  });

  it("reopens the complete literal a2cdf/747dee GPT-OSS predecessor", async () => {
    expect(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_VERSION).toBe("2.0.0");
    expect(
      canonicalSha256(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST),
    ).toBe(
      "a2cdf4c65368d99ac1f48171338c77cf9ebb51b0631829ebf4e2411d67a4c174",
    );
    expect(Object.isFrozen(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST)).toBe(true);
    expect(
      canonicalSha256(
        GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS,
      ),
    ).toBe(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH);
    expect(Object.isFrozen(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS)).toBe(true);
    expect(
      GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS.every(
        (configuration) =>
          Object.isFrozen(configuration) &&
          Object.isFrozen(configuration.generationSettings) &&
          Object.isFrozen(configuration.providerCapabilities),
      ),
    ).toBe(true);

    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse(
            "mistralai/Mistral-Large-Instruct-2411",
            outputs.shift(),
          ),
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );
    const current = await reopenLiveGoldenArtifact(result.manifestPath);
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      gptOssStructuredOutputPredecessorConfig(current.config),
      gptOssStructuredOutputPredecessorRun(current.run),
    );

    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(reopened.config).toMatchObject({
      promptManifestHash:
        "a2cdf4c65368d99ac1f48171338c77cf9ebb51b0631829ebf4e2411d67a4c174",
      primaryModel: { modelId: "openai/gpt-oss-120b" },
      nodeConfigurationHash:
        "747dee0c54252db00aca26f31fd5aa9e62ee6474b3ab90bea87f46e4ab0a366c",
    });
    expect(reopened.config.nodeConfigurations).toEqual(
      GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS,
    );
  });

  it("reopens the exact a2cdf/134710 Mistral shared-timeout predecessor", async () => {
    expect(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_VERSION).toBe("2.0.0");
    expect(
      canonicalSha256(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_PROMPT_MANIFEST),
    ).toBe(
      "a2cdf4c65368d99ac1f48171338c77cf9ebb51b0631829ebf4e2411d67a4c174",
    );
    expect(
      canonicalSha256(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS),
    ).toBe(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH);
    expect(
      MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS.every(
        (configuration) =>
          Object.isFrozen(configuration) &&
          Object.isFrozen(configuration.generationSettings) &&
          Object.isFrozen(configuration.structuredOutputTransportPolicy),
      ),
    ).toBe(true);

    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse(
            "mistralai/Mistral-Large-Instruct-2411",
            outputs.shift(),
          ),
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );
    const current = await reopenLiveGoldenArtifact(result.manifestPath);
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      mistralSharedTimeoutPredecessorConfig(current.config),
      {
        ...current.run,
        executions: current.run.executions.map((execution) =>
          withHistoricalDeepSeekReviewerExecution(
            planningPredecessorPrompt(execution),
          ),
        ),
      },
    );

    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(reopened.config).toMatchObject({
      promptManifestHash:
        "a2cdf4c65368d99ac1f48171338c77cf9ebb51b0631829ebf4e2411d67a4c174",
      primaryModel: {
        modelId: "mistralai/Mistral-Large-Instruct-2411",
      },
      nodeConfigurationHash:
        "1347106d3f16087832c49d7b4e5b53f759898a65e7e65959d5e7cf7e41f346eb",
    });
    expect(reopened.config.nodeConfigurations).toEqual(
      MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS,
    );
  });

  it("reopens the immutable exact r10 Mistral planning predecessor", async () => {
    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const input = invocationInput(root, {
      primary: async () =>
        providerResponse(
          "mistralai/Mistral-Large-Instruct-2411",
          outputs.shift(),
        ),
      reviewer: async () =>
        providerResponse(
          "Qwen/Qwen2.5-72B-Instruct",
          successfulReviewerOutput(),
        ),
    });
    const result = await runMockedApprovedLiveGoldenInvocation({
      ...input,
      codeVersion: "db460a29f284f6cb813c370ed2a1846a46c0e0a5",
    });
    const current = await reopenLiveGoldenArtifact(result.manifestPath);
    const predecessor = r10PlanningPredecessorConfig(current.config);
    expect(R10_PLANNING_PREDECESSOR_COMPARISON_HASH).toBe(
      "c8a088630ca8b09bf791db62613c89bb2032b0381e984165c18fb4c29ac42f14",
    );
    expect(predecessor.comparisonInvalidatingHash).toBe(
      R10_PLANNING_PREDECESSOR_COMPARISON_HASH,
    );
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      predecessor,
      r10PlanningPredecessorRun(current.run),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(reopened.config).toMatchObject({
      promptManifestHash: R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH,
      nodeConfigurationHash:
        R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH,
      comparisonInvalidatingHash: predecessor.comparisonInvalidatingHash,
    });
    expect(reopened.config.nodeConfigurations).toEqual(
      R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS,
    );

    const alternate = structuredClone(predecessor) as Record<string, unknown>;
    alternate.codeVersion = "f".repeat(40);
    const alternatePayload = structuredClone(alternate);
    delete alternatePayload.comparisonInvalidatingHash;
    alternate.comparisonInvalidatingHash = canonicalSha256(alternatePayload);
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      alternate,
      r10PlanningPredecessorRun(current.run),
    );
    await expect(reopenLiveGoldenArtifact(result.manifestPath)).rejects.toThrow();
  });

  it("reopens only the exact live r11 Mistral/DeepSeek predecessor", async () => {
    expect(R11_DEEPSEEK_PREDECESSOR_VERSION).toBe("2.0.0");
    expect(canonicalSha256(R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST)).toBe(
      "f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2",
    );
    expect(canonicalSha256(R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS)).toBe(
      R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH,
    );
    expect(Object.isFrozen(R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST)).toBe(true);
    expect(Object.isFrozen(R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS)).toBe(true);

    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse(
            "mistralai/Mistral-Large-Instruct-2411",
            outputs.shift(),
          ),
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );
    const current = await reopenLiveGoldenArtifact(result.manifestPath);
    const predecessor = r11DeepSeekPredecessorConfig(current.config);
    expect(predecessor.comparisonInvalidatingHash).toBe(
      R11_DEEPSEEK_PREDECESSOR_COMPARISON_HASH,
    );
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      predecessor,
      r11DeepSeekPredecessorRun(current.run),
    );

    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(reopened.config).toMatchObject({
      evidenceMode: "live",
      codeVersion: "17969fec472a8641a765b03366f85944324693af",
      promptManifestHash:
        "f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2",
      nodeConfigurationHash:
        "768d5bd15a146206fec01a618b2b6dfe471c60c902b6a0c81033132ea66c02c8",
      comparisonInvalidatingHash:
        "687b4798de3becf7a99996c0051a199a5f9e8116b33e1492ee55b4a96a1a72ad",
      reviewerModel: {
        provider: "featherless",
        modelId: "deepseek-ai/DeepSeek-V4-Flash",
        developerFamily: "deepseek",
        baseFamily: "deepseek-v4",
      },
      costBasis: {
        primary: {
          currency: "USD",
          inputPerMillionTokens: 0,
          cachedInputPerMillionTokens: null,
          outputPerMillionTokens: 0,
          snapshotDate: "2026-08-11",
        },
        reviewer: {
          currency: "USD",
          inputPerMillionTokens: 0,
          cachedInputPerMillionTokens: null,
          outputPerMillionTokens: 0,
          snapshotDate: "2026-08-11",
        },
      },
    });
    expect(
      reopened.run.executions.find(
        ({ nodeId }) => nodeId === "review-experiment",
      ),
    ).toMatchObject({
      evidenceMode: "live",
      codeVersion: "17969fec472a8641a765b03366f85944324693af",
      requestedModelId: "deepseek-ai/DeepSeek-V4-Flash",
      requestedDeveloperFamily: "deepseek",
      requestedBaseFamily: "deepseek-v4",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        estimatedCost: 0,
        snapshotDate: "2026-08-11",
      },
    });

    const alternate = structuredClone(predecessor) as Record<string, unknown>;
    alternate.codeVersion = "f".repeat(40);
    const alternatePayload = structuredClone(alternate);
    delete alternatePayload.comparisonInvalidatingHash;
    alternate.comparisonInvalidatingHash = canonicalSha256(alternatePayload);
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      alternate,
      r11DeepSeekPredecessorRun(current.run),
    );
    await expect(reopenLiveGoldenArtifact(result.manifestPath)).rejects.toThrow();
  });

  it("freezes the bounded Featherless timeout policy and journals one typed timeout", async () => {
    const root = await artifactRoot();
    const primaryTransport = vi.fn(async () => {
      throw new DOMException("mocked provider deadline", "TimeoutError");
    });
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: primaryTransport,
        reviewer: vi.fn(),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);

    expect(LIVE_GOLDEN_TIMEOUT_POLICY).toEqual({
      version: "2.0.0",
      scope: "per_transport_attempt",
      maximumTransportAttempts: 2,
      maximumTransportBudgetMs: 240_000,
      maximumRetryBackoffMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(reopened.run.executions).toHaveLength(1);
    expect(reopened.run.errors).toHaveLength(1);
    expect(reopened.run.executions[0]).toMatchObject({
      attempt: 1,
      status: "timed_out",
      errorIds: [reopened.run.errors[0]!.id],
    });
    expect(reopened.run.errors[0]).toMatchObject({ kind: "timeout" });
    expect(reopened.manifest.attemptIds).toEqual([
      reopened.run.executions[0]!.id,
    ]);
    expect(reopened.manifest.errorIds).toEqual([reopened.run.errors[0]!.id]);
    expect(reopened.config.nodeConfigurations.every((item) => {
      const configuration = item as Record<string, unknown>;
      return (
        configuration.timeoutMs === LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS &&
        configuration.timeoutPolicyVersion ===
          LIVE_GOLDEN_TIMEOUT_POLICY_VERSION &&
        configuration.timeoutScope === "per_transport_attempt" &&
        configuration.maximumTransportBudgetMs === 240_000 &&
        configuration.maximumRetryBackoffMs === 1_000 &&
        configuration.outputLimitPolicyVersion ===
          LIVE_GOLDEN_OUTPUT_LIMIT_POLICY_VERSION &&
        canonicalizeJson(configuration.structuredOutputTransportPolicy) ===
          canonicalizeJson(LIVE_GOLDEN_STRUCTURED_OUTPUT_TRANSPORT_POLICY) &&
        (
          configuration.generationSettings as Record<string, unknown>
        ).maxOutputTokens === LIVE_GOLDEN_MAX_OUTPUT_TOKENS
      );
    })).toBe(true);
    expect(primaryTransport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["source order", (run: typeof goldenRunV01) => run.sources.reverse()],
    [
      "rights",
      (run: typeof goldenRunV01) => {
        run.sources[0]!.rights.maySendToModel = "denied";
      },
    ],
    [
      "packet hash",
      (run: typeof goldenRunV01) => {
        run.packet!.fingerprint = "0".repeat(64);
      },
    ],
  ])("fails closed on %s drift", (_name, mutate) => {
    const candidate = structuredClone(goldenRunV01);
    mutate(candidate);

    expect(() => assertApprovedLiveGoldenAuthority(candidate)).toThrow(
      LiveGoldenPreflightError,
    );
  });

  it("rejects forged source/chunk contents even when every claimed hash is recomputed", () => {
    const candidate = structuredClone(goldenRunV01) as ResearchRun;
    const changedText = `${candidate.chunks[0]!.text} Altered after approval.`;
    const changedHash = createHash("sha256")
      .update(changedText, "utf8")
      .digest("hex");
    candidate.chunks[0]!.text = changedText;
    candidate.chunks[0]!.contentHash = changedHash;
    candidate.sources[0]!.contentHash = changedHash;
    candidate.packet = freezePacket({
      packetVersion: candidate.packet!.packetVersion,
      sourceHashes: candidate.sources.map(
        ({ contentHash }: { contentHash: string }) => contentHash,
      ),
      chunkHashes: candidate.chunks.map(
        ({ contentHash }: { contentHash: string }) => contentHash,
      ),
      frozenAt: candidate.packet!.frozenAt,
      freezeDecision: candidate.packet!.freezeDecision,
    });

    expect(() => assertApprovedLiveGoldenAuthority(candidate)).toThrow(
      LiveGoldenPreflightError,
    );
  });

  it("rejects missing credentials and arbitrary packet input before transport", async () => {
    const groqTransport = vi.fn();
    const nvidiaTransport = vi.fn();
    const root = await artifactRoot();

    await expect(
      runApprovedLiveGoldenInvocation({
        artifactRoot: root,
        codeVersion: "a".repeat(40),
        providerEnvironment: {
          primaryProvider: "featherless",
          primaryModel: "mistralai/Mistral-Large-Instruct-2411",
          reviewerProvider: "featherless",
          reviewerModel: "Qwen/Qwen2.5-72B-Instruct",
          featherlessApiKey: "",
        },
        decisions: {
          objections: vi.fn(),
          final: vi.fn(),
        },
        runtime: {
          primary: { transport: groqTransport },
          reviewer: { transport: nvidiaTransport },
        },
        packet: structuredClone(goldenRunV01.packet),
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INVOCATION_INPUT" });

    expect(groqTransport).not.toHaveBeenCalled();
    expect(nvidiaTransport).not.toHaveBeenCalled();

    await expect(
      runApprovedLiveGoldenInvocation({
        artifactRoot: root,
        codeVersion: "a".repeat(40),
        providerEnvironment: {
          primaryProvider: "featherless",
          primaryModel: "mistralai/Mistral-Large-Instruct-2411",
          reviewerProvider: "featherless",
          reviewerModel: "Qwen/Qwen2.5-72B-Instruct",
          featherlessApiKey: "",
        },
        decisions: {
          objections: vi.fn(),
          final: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIALS" });

    expect(groqTransport).not.toHaveBeenCalled();
    expect(nvidiaTransport).not.toHaveBeenCalled();
  });

  it("does not let a caller-injected transport mint live evidence", async () => {
    const primaryTransport = vi.fn(async () =>
      providerResponse("mistralai/Mistral-Large-Instruct-2411", {}),
    );
    const reviewerTransport = vi.fn(async () =>
      providerResponse("Qwen/Qwen2.5-72B-Instruct", {}),
    );
    const root = await artifactRoot();
    const injected = invocationInput(root, {
      primary: primaryTransport,
      reviewer: reviewerTransport,
    });

    await expect(
      runApprovedLiveGoldenInvocation(injected as never),
    ).rejects.toMatchObject({ code: "INVALID_INVOCATION_INPUT" });
    expect(primaryTransport).not.toHaveBeenCalled();
    expect(reviewerTransport).not.toHaveBeenCalled();

    const mocked = await runMockedApprovedLiveGoldenInvocation(injected);
    const reopened = await reopenLiveGoldenArtifact(mocked.manifestPath);

    expect(mocked.run.evidenceMode).toBe("mocked");
    expect(
      mocked.run.executions.every(
        ({ evidenceMode }) => evidenceMode === "mocked",
      ),
    ).toBe(true);
    expect(reopened.manifest.evidenceMode).toBe("mocked");
    expect(JSON.stringify(reopened)).not.toContain('"evidenceMode":"live"');
  });

  it("rejects credential collisions before serializing config or creating artifact paths", async () => {
    const transport = vi.fn(async () => {
      throw new Error("offline transport must not run");
    });
    const configRoot = await artifactRoot();
    const configCollision = invocationInput(configRoot, {
      primary: transport,
      reviewer: transport,
    });
    configCollision.providerEnvironment.featherlessApiKey =
      configCollision.codeVersion;

    await expect(
      runMockedApprovedLiveGoldenInvocation(configCollision),
    ).rejects.toMatchObject({ code: "CREDENTIAL_EXPOSURE_BLOCKED" });
    expect(await readdir(configRoot)).toEqual([]);

    const pathParent = await artifactRoot();
    const credentialPath = join(pathParent, primarySecret);
    const pathCollision = invocationInput(credentialPath, {
      primary: transport,
      reviewer: transport,
    });

    await expect(
      runMockedApprovedLiveGoldenInvocation(pathCollision),
    ).rejects.toMatchObject({ code: "CREDENTIAL_EXPOSURE_BLOCKED" });
    expect(await readdir(pathParent)).toEqual([]);

    const generatedPathRoot = await artifactRoot();
    const generatedPathCollision = invocationInput(generatedPathRoot, {
      primary: transport,
      reviewer: transport,
    });
    generatedPathCollision.runtime.workflow.makeId = () => primarySecret;

    await expect(
      runMockedApprovedLiveGoldenInvocation(generatedPathCollision),
    ).rejects.toMatchObject({ code: "CREDENTIAL_EXPOSURE_BLOCKED" });
    expect(await readdir(generatedPathRoot)).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("runs the exact packet through primary/reviewer adapters and reopens the append-only artifact", async () => {
    const primaryOutputs = successfulPrimaryOutputs();
    const primaryBodies: Array<Record<string, unknown>> = [];
    const reviewerBodies: Array<Record<string, unknown>> = [];
    const primaryTransport = vi.fn(async (_url: string, init: RequestInit) => {
      primaryBodies.push(JSON.parse(String(init.body)));
      return providerResponse("mistralai/Mistral-Large-Instruct-2411", primaryOutputs.shift());
    });
    const reviewerTransport = vi.fn(async (_url: string, init: RequestInit) => {
      reviewerBodies.push(JSON.parse(String(init.body)));
        return providerResponse(
          "Qwen/Qwen2.5-72B-Instruct",
          successfulReviewerOutput(),
        );
    });
    const root = await artifactRoot();

    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: primaryTransport,
        reviewer: reviewerTransport,
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);

    expect(result.ok).toBe(true);
    expect(result.run.status).toBe("approved");
    expect(result.run.evidenceMode).toBe("mocked");
    expect(result.run.executions).toHaveLength(6);
    expect(
      result.run.executions.every(
        ({ codeVersion }) => codeVersion === "a".repeat(40),
      ),
    ).toBe(true);
    expect(primaryTransport).toHaveBeenCalledTimes(5);
    expect(reviewerTransport).toHaveBeenCalledTimes(1);
    for (const [body, nodeId, model] of [
      [primaryBodies[0]!, "extract-evidence", "mistralai/Mistral-Large-Instruct-2411"],
      [reviewerBodies[0]!, "review-experiment", "Qwen/Qwen2.5-72B-Instruct"],
    ] as const) {
      expect(Object.keys(body).sort()).toEqual([
        "max_tokens",
        "messages",
        "model",
        "response_format",
        "stream",
        "temperature",
      ]);
      expect(body).toMatchObject({
        model,
        max_tokens: 2048,
        stream: false,
        temperature: 0,
        response_format: { type: "json_object" },
      });
      const messages = body.messages as Array<{ role: string; content: string }>;
      const resource = promptRegistry.forNode(nodeId);
      expect(messages[0]).toEqual(resource.messages[0]);
      const instruction = messages.at(-1)!.content.match(
        /\n\nReturn only one JSON object matching this schema\.\n(.+)\nDo not add markdown fences or explanatory text\.$/s,
      );
      expect(instruction).not.toBeNull();
      const requestSchema = JSON.parse(instruction![1]!);
      expect(requestSchema).toMatchObject({
        type: resource.outputSchema.jsonSchema.type,
        required: resource.outputSchema.jsonSchema.required,
        additionalProperties:
          resource.outputSchema.jsonSchema.additionalProperties,
      });
      expect(Object.keys(requestSchema.properties).sort()).toEqual(
        Object.keys(
          resource.outputSchema.jsonSchema.properties as Record<
            string,
            unknown
          >,
        ).sort(),
      );
    }
    expect(reopened.run).toEqual(result.run);
    expect(reopened.manifest.attemptIds).toEqual(
      result.run.executions.map(({ id }) => id),
    );
    expect(reopened.config.comparisonInvalidatingHash).toBe(
      result.comparisonInvalidatingHash,
    );
    const currentConfigPayload = structuredClone(
      reopened.config,
    ) as unknown as Record<string, unknown>;
    delete currentConfigPayload.comparisonInvalidatingHash;
    const preRemovalPayload = withHistoricalConfiguredCostBasis(
      currentConfigPayload,
    );
    expect(reopened.config.comparisonInvalidatingHash).toBe(
      canonicalSha256(currentConfigPayload),
    );
    expect(reopened.config.comparisonInvalidatingHash).toBe(
      "a121784edba49e366da9e8e68c097fc1a45ab1941ec40c57d8a43cc2cfb7a23c",
    );
    expect(reopened.config.comparisonInvalidatingHash).not.toBe(
      canonicalSha256(preRemovalPayload),
    );
    expect(canonicalSha256(preRemovalPayload)).toBe(
      "185e7e93768ede3e6c47bff0252931089aaf3f9d7a64506a32e3074fc12d681c",
    );
    expect(() =>
      createLiveGoldenArtifactConfig(preRemovalPayload as never),
    ).toThrow();
    expect(reopened.config.primaryModel).toEqual({
      provider: "featherless",
      modelId: "mistralai/Mistral-Large-Instruct-2411",
      developerFamily: "mistralai",
      baseFamily: "mistral-large",
    });
    expect(reopened.config.reviewerModel).toMatchObject({
      modelId: "Qwen/Qwen2.5-72B-Instruct",
      developerFamily: "qwen",
      baseFamily: "qwen2.5",
    });
    expect(reopened.config.costBasis).toBeNull();
    expect(
      reopened.run.executions.every(
        ({ usage, pricing }) =>
          usage.inputTokens === 100 &&
          usage.outputTokens === 20 &&
          usage.totalTokens === 120 &&
          usage.cachedInputTokens === 0 &&
          pricing.currency === "USD" &&
          pricing.inputPerMillionTokens === null &&
          pricing.outputPerMillionTokens === null &&
          pricing.estimatedCost === null &&
          pricing.snapshotDate === null,
      ),
    ).toBe(true);
    expect(reopened.config.nodeConfigurationHash).toBe(
      APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
    );
    expect(
      reopened.run.executions.every(
        ({ generationSettings }) =>
          generationSettings.maxOutputTokens ===
          LIVE_GOLDEN_MAX_OUTPUT_TOKENS,
      ),
    ).toBe(true);
    expect(reopened.config.comparisonInvalidatingHash).not.toBe(
      historicalQwenConfig(reopened.config, 120_000)
        .comparisonInvalidatingHash,
    );
    expect(
      reopened.run.executions
        .filter(({ nodeId }) => nodeId !== "review-experiment")
        .every(
          ({
            requestedModelId,
            requestedDeveloperFamily,
            requestedBaseFamily,
            fallbackFromExecutionId,
          }) =>
            requestedModelId === "mistralai/Mistral-Large-Instruct-2411" &&
            requestedDeveloperFamily === "mistralai" &&
            requestedBaseFamily === "mistral-large" &&
            fallbackFromExecutionId === null,
        ),
    ).toBe(true);
    expect(JSON.stringify(reopened)).not.toContain(primarySecret);
    expect(JSON.stringify(reopened)).not.toContain(reviewerSecret);
  });

  it("rejects caller-invented monetary pricing as a current invocation field", async () => {
    const root = await artifactRoot();
    const transport = vi.fn();
    const input = invocationInput(root, {
      primary: transport,
      reviewer: transport,
    }) as unknown as Record<string, unknown>;
    input.costBasis = {
      primary: {
        currency: "USD",
        inputPerMillionTokens: 0,
        cachedInputPerMillionTokens: null,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
      reviewer: {
        currency: "USD",
        inputPerMillionTokens: 0,
        cachedInputPerMillionTokens: null,
        outputPerMillionTokens: 0,
        snapshotDate: "2026-08-11",
      },
    };

    await expect(
      runMockedApprovedLiveGoldenInvocation(input as never),
    ).rejects.toMatchObject({ code: "INVALID_INVOCATION_INPUT" });
    expect(transport).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("reopens the immutable GPT-OSS Featherless 2.0.0 4,096-token history", async () => {
    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", outputs.shift()),
        reviewer: async () =>
            providerResponse("Qwen/Qwen2.5-72B-Instruct", successfulReviewerOutput()),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    const historicalConfig = historicalGptOssConfig(reopened.config);
    const historicalRun = historicalGptOssRun(reopened.run);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    for (const entry of manifest.artifacts as Array<{
      kind: string;
      path: string;
      sha256: string;
    }>) {
      let value: unknown;
      if (entry.kind === "config") {
        value = historicalConfig;
      } else if (entry.kind === "canonical_run") {
        value = historicalRun;
      } else if (entry.kind === "attempt") {
        const index = Number(entry.path.match(/(\d+)\.json$/)?.[1]) - 1;
        value = historicalRun.executions[index];
      } else {
        continue;
      }
      const content = `${canonicalizeJson(value)}\n`;
      await writeFile(
        join(dirname(result.manifestPath), ...entry.path.split("/")),
        content,
        "utf8",
      );
      entry.sha256 = createHash("sha256").update(content).digest("hex");
    }
    manifest.configHash = canonicalSha256(historicalConfig);
    manifest.canonicalRunHash = canonicalSha256(historicalRun);
    manifest.comparisonInvalidatingHash =
      historicalConfig.comparisonInvalidatingHash;
    await writeFile(
      result.manifestPath,
      `${canonicalizeJson(manifest)}\n`,
      "utf8",
    );

    const history = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(history.config.nodeConfigurationHash).toBe(
      "09819024f1e35457c0af7198b7a501064c3c069e66987b5cb724779954c4570f",
    );
    expect(
      history.config.nodeConfigurations.every((item) => {
        const configuration = item as Record<string, unknown>;
        return (
          (configuration.generationSettings as Record<string, unknown>)
            .maxOutputTokens === 4096 &&
          !("outputLimitPolicyVersion" in configuration)
        );
      }),
    ).toBe(true);
  });

  it("reopens the exact compact-evidence predecessor without current synthesis identity", async () => {
    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", outputs.shift()),
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    const historicalConfig = compactEvidencePredecessorConfig(
      reopened.config,
    );
    const historicalRun = compactEvidencePredecessorRun(reopened.run);
    await rewriteArtifactConfigAndRun(
      result.manifestPath,
      historicalConfig,
      historicalRun,
    );

    const history = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(history.config).toMatchObject({
      promptManifestHash:
        "da10bd36100bb22decedde6951fbaec8cc88d98fe14f92d0d14b582890f442ca",
      nodeConfigurationHash:
        "685c145a7c57cb23fe2ff684c11b2bce1f8f0aa71589111ece48088c67f853e2",
    });
    expect(canonicalSha256(history.config.promptManifest)).toBe(
      COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH,
    );
  });

  it("reopens the exact immediate GPT-OSS pre-compact manifest and node configuration", async () => {
    const root = await artifactRoot();
    const outputs = successfulPrimaryOutputs();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", outputs.shift()),
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    const historicalConfig = immediatePredecessorConfig(reopened.config);
    const historicalRun = immediatePredecessorRun(reopened.run);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    for (const entry of manifest.artifacts as Array<{
      kind: string;
      path: string;
      sha256: string;
    }>) {
      const value = entry.kind === "config"
        ? historicalConfig
        : entry.kind === "canonical_run"
          ? historicalRun
          : entry.kind === "attempt"
            ? historicalRun.executions[
                Number(entry.path.match(/(\d+)\.json$/)?.[1]) - 1
              ]
            : undefined;
      if (value === undefined) continue;
      const content = `${canonicalizeJson(value)}\n`;
      await writeFile(
        join(dirname(result.manifestPath), ...entry.path.split("/")),
        content,
        "utf8",
      );
      entry.sha256 = createHash("sha256").update(content).digest("hex");
    }
    manifest.configHash = canonicalSha256(historicalConfig);
    manifest.canonicalRunHash = canonicalSha256(historicalRun);
    manifest.comparisonInvalidatingHash = historicalConfig.comparisonInvalidatingHash;
    await writeFile(
      result.manifestPath,
      `${canonicalizeJson(manifest)}\n`,
      "utf8",
    );

    const history = await reopenLiveGoldenArtifact(result.manifestPath);
    expect(history.config).toMatchObject({
      promptManifestHash:
        "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e",
      nodeConfigurationHash:
        "3347ac013a0ce0af3cf2b8ef1e35abb75217422d3d782d9066e6c724bd375215",
    });
  });

  it.each([
    {
      name: "refusal",
      responses: [
        () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", {}, {
            choices: [
              {
                finish_reason: "stop",
                message: { content: null, refusal: "bounded refusal" },
              },
            ],
          }),
      ],
      attempts: 1,
      status: "refused",
    },
    {
      name: "invalid output retry exhaustion",
      responses: [
        () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", {}, {
            choices: [
              {
                finish_reason: "stop",
                message: { content: "{invalid-json", refusal: null },
              },
            ],
          }),
        () => providerResponse("mistralai/Mistral-Large-Instruct-2411", "still-not-the-schema"),
      ],
      attempts: 2,
      status: "failed",
    },
    {
      name: "returned model mismatch",
      responses: [() => providerResponse("unexpected/model", {})],
      attempts: 1,
      status: "failed",
    },
  ])("preserves $name attempts without fabricating success", async ({
    responses,
    attempts,
    status,
  }) => {
    const queue = [...responses];
    const transport = vi.fn(async () => queue.shift()!());
    const root = await artifactRoot();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: transport,
        reviewer: vi.fn(),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);

    expect(result.ok).toBe(false);
    expect(result.run.executions).toHaveLength(attempts);
    expect(result.run.executions.at(-1)?.status).toBe(status);
    expect(reopened.manifest.complete).toBe(false);
    expect(reopened.manifest.attemptIds).toEqual(
      result.run.executions.map(({ id }) => id),
    );
  });

  it("retains unavailable returned usage without synthesizing pricing zeroes", async () => {
    const outputs = successfulPrimaryOutputs();
    let first = true;
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(await artifactRoot(), {
        primary: async () => {
          const output = outputs.shift();
          if (first) {
            first = false;
            return providerResponse(
              "mistralai/Mistral-Large-Instruct-2411",
              output,
              { usage: undefined },
            );
          }
          return providerResponse(
            "mistralai/Mistral-Large-Instruct-2411",
            output,
          );
        },
        reviewer: async () =>
          providerResponse(
            "Qwen/Qwen2.5-72B-Instruct",
            successfulReviewerOutput(),
          ),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.run.executions[0]).toMatchObject({
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
      },
      pricing: {
        inputPerMillionTokens: null,
        outputPerMillionTokens: null,
        estimatedCost: null,
        snapshotDate: null,
      },
    });
  });

  it("redacts credential-bearing transport failures from errors and artifacts", async () => {
    const root = await artifactRoot();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () => {
          throw new Error(`socket failed near ${primarySecret}`);
        },
        reviewer: vi.fn(),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(reopened)).not.toContain(primarySecret);
    expect(JSON.stringify(reopened)).not.toContain(reviewerSecret);
  });

  it("durably appends every attempt before decision callbacks and blocks callback secret persistence", async () => {
    const root = await artifactRoot();
    const primaryOutputs = successfulPrimaryOutputs();
    const input = invocationInput(root, {
      primary: async () =>
        providerResponse("mistralai/Mistral-Large-Instruct-2411", primaryOutputs.shift()),
      reviewer: async () =>
          providerResponse("Qwen/Qwen2.5-72B-Instruct", successfulReviewerOutput()),
    });
    const approvedObjections = input.decisions.objections;
    let durableAttemptsObserved = 0;
    input.decisions.objections = (run) => {
      const versionRoot = join(root, "approved-live-golden", "2.0.0");
      const runDirectory = readdirSync(versionRoot)[0]!;
      durableAttemptsObserved = readdirSync(
        join(versionRoot, runDirectory, "attempts"),
      ).length;
      const provided = approvedObjections(run);
      return {
        ...provided,
        dispositions: provided.dispositions.map((disposition, index) => ({
          ...disposition,
          basis:
            index === 0
              ? `attempt to persist ${primarySecret}`
              : disposition.basis,
        })),
      };
    };

    await expect(
      runMockedApprovedLiveGoldenInvocation(input),
    ).rejects.toMatchObject({ code: "CREDENTIAL_EXPOSURE_BLOCKED" });

    expect(durableAttemptsObserved).toBe(5);
    const versionRoot = join(root, "approved-live-golden", "2.0.0");
    const runDirectory = (await readdir(versionRoot))[0]!;
    const runPath = join(versionRoot, runDirectory);
    expect((await readdir(join(runPath, "attempts"))).length).toBe(5);
    expect(existsSync(join(runPath, "manifest.json"))).toBe(false);
    expect(existsSync(join(runPath, "canonical", "run.json"))).toBe(false);
  });

  it("does not propagate credential-bearing decision callback exceptions", async () => {
    const root = await artifactRoot();
    const primaryOutputs = successfulPrimaryOutputs();
    const input = invocationInput(root, {
      primary: async () =>
        providerResponse("mistralai/Mistral-Large-Instruct-2411", primaryOutputs.shift()),
      reviewer: async () =>
          providerResponse("Qwen/Qwen2.5-72B-Instruct", successfulReviewerOutput()),
    });
    input.decisions.objections = () => {
      throw new Error(`callback failed with ${reviewerSecret}`);
    };

    const rejection = await runMockedApprovedLiveGoldenInvocation(input).catch(
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ code: "DECISION_CALLBACK_FAILED" });
    expect(String(rejection)).not.toContain(reviewerSecret);
  });

  it("owns caller data and rejects materializer/config drift", async () => {
    const root = await artifactRoot();
    const input = invocationInput(root, {
      primary: async () =>
        providerResponse("mistralai/Mistral-Large-Instruct-2411", {}, {
          choices: [
            {
              finish_reason: "stop",
              message: { content: null, refusal: "bounded refusal" },
            },
          ],
        }),
      reviewer: vi.fn(),
    });
    const before = structuredClone(input.providerEnvironment);
    const result = await runMockedApprovedLiveGoldenInvocation(input);
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    if (
      reopened.config.schemaVersion !== "2.0.0" ||
      reopened.config.primaryModel.modelId !== "mistralai/Mistral-Large-Instruct-2411" ||
      reopened.config.nodeConfigurationHash !==
        APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH
    ) {
      throw new Error("expected current Featherless artifact configuration");
    }
    const currentConfig = reopened.config as LiveGoldenArtifactConfig;
    const drifted = structuredClone(reopened.run);
    drifted.sources.reverse();

    expect(input.providerEnvironment).toEqual(before);
    await expect(
      materializeLiveGoldenArtifact({
        artifactRoot: await artifactRoot(),
        config: currentConfig,
        run: drifted,
      }),
    ).rejects.toThrow("does not match its config");
  });

  it("rejects a self-consistent but unapproved node configuration", async () => {
    const root = await artifactRoot();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () =>
          providerResponse("mistralai/Mistral-Large-Instruct-2411", {}, {
            choices: [
              {
                finish_reason: "stop",
                message: { content: null, refusal: "bounded refusal" },
              },
            ],
          }),
        reviewer: vi.fn(),
      }),
    );
    const reopened = await reopenLiveGoldenArtifact(result.manifestPath);
    const forged = structuredClone(reopened.config) as unknown as {
      nodeConfigurations: Array<Record<string, unknown>>;
      nodeConfigurationHash: string;
      comparisonInvalidatingHash?: string;
      [key: string]: unknown;
    };
    const firstConfiguration = forged.nodeConfigurations[0]!;
    firstConfiguration.timeoutMs = Number(firstConfiguration.timeoutMs) + 1;
    forged.nodeConfigurationHash = canonicalSha256(
      forged.nodeConfigurations,
    );
    const payload = structuredClone(forged);
    delete payload.comparisonInvalidatingHash;
    forged.comparisonInvalidatingHash = canonicalSha256(payload);

    await expect(
      materializeLiveGoldenArtifact({
        artifactRoot: await artifactRoot(),
        config: forged as never,
        run: reopened.run,
      }),
    ).rejects.toThrow();
  });

  it("detects any post-write attempt mutation when reopening", async () => {
    const root = await artifactRoot();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () => {
          throw new Error("offline transport failure");
        },
        reviewer: vi.fn(),
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const attemptPath = join(
      result.manifestPath,
      "..",
      manifest.artifacts.find(
        (artifact: { kind: string }) => artifact.kind === "attempt",
      ).path,
    );
    await writeFile(attemptPath, "{}\n", "utf8");

    await expect(reopenLiveGoldenArtifact(result.manifestPath)).rejects.toThrow(
      "hash mismatch",
    );
  });

  it("rejects manifest artifact paths that cross a reparse-point boundary", async () => {
    const root = await artifactRoot();
    const result = await runMockedApprovedLiveGoldenInvocation(
      invocationInput(root, {
        primary: async () => {
          throw new Error("offline transport failure");
        },
        reviewer: vi.fn(),
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const attempt = manifest.artifacts.find(
      (artifact: { kind: string }) => artifact.kind === "attempt",
    );
    const runPath = dirname(result.manifestPath);
    const attemptContent = await readFile(
      join(runPath, ...attempt.path.split("/")),
      "utf8",
    );
    const outside = await mkdtemp(join(tmpdir(), "evidenceforge-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "attempt.json"), attemptContent, "utf8");
    await symlink(outside, join(runPath, "escape"), "junction");
    attempt.path = "escape/attempt.json";
    await writeFile(
      result.manifestPath,
      `${canonicalizeJson(manifest)}\n`,
      "utf8",
    );

    await expect(reopenLiveGoldenArtifact(result.manifestPath)).rejects.toThrow(
      /reparse|artifact path/i,
    );
  });
});
