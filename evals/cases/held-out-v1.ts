import { z } from "zod";

import { canonicalSha256 } from "../../src/contracts";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  BenchmarkCaseSchema,
  createBenchmarkCase,
  createBenchmarkConfig,
} from "../protocol/v1";
import {
  EVAL_RUNNER_VERSION,
  EvalRunConfigSchema,
  createRequestMetadata,
  materializeFixtureRun,
  type RecordedAttempt,
} from "../runner/v1";
import publicPack from "./held-out-public-v1.json";

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

function detachedFrozen<T>(input: T): T {
  return ownAndDeepFreeze(structuredClone(input));
}

const CASE_VERSION = "1.0.0" as const;
const FREEZE_TIMESTAMP = "2026-08-08T10:51:38.000Z" as const;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/);

const ProtocolBindingSchema = z
  .object({
    protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    protocolSchemaHash: z.literal(BENCHMARK_PROTOCOL_SCHEMA_HASH),
    conditionMatrixHash: z.literal(CONDITION_MATRIX_HASH),
    promptManifestHash: z.literal(FROZEN_CONSUMER_EDGE.promptManifestHash),
  })
  .strict();

const ClassificationSchema = z
  .object({
    evidenceMode: z.literal("fixture"),
    reportingUse: z.literal("heldout_freeze"),
    resultClass: z.literal("heldout_case"),
    measurementStatus: z.literal("unmeasured"),
    headlineEligible: z.literal(false),
  })
  .strict();

const RightsSchema = z
  .object({
    state: z.literal("approved"),
    licenseId: z.literal("CC0-1.0"),
    basis: z.string().min(1),
    decisionAuthority: z.string().min(1),
    mayStore: z.literal(true),
    mayDisplay: z.literal(true),
    maySendToModel: z.literal(true),
    attributionRequired: z.literal(false),
    externalLicenseVerificationRequired: z.literal(false),
    rightsDecisionHash: HashSchema,
  })
  .strict();

const SourceSchema = z
  .object({
    schemaVersion: z.literal(CASE_VERSION),
    id: IdSchema,
    title: z.string().min(1),
    origin: z.literal("project_authored_fixture"),
    creator: z.string().min(1),
    stableIdentifier: z.string().min(1),
    trustBoundary: z.literal("untrusted_source_content"),
    externalCitation: z.null(),
    externalAuthorityClaimed: z.literal(false),
    rights: RightsSchema,
    permissionNotes: z.array(z.string().min(1)).min(1),
    safetyNotes: z.array(z.string().min(1)).min(1),
    sourceHash: HashSchema,
  })
  .strict();

const ChunkSchema = z
  .object({
    schemaVersion: z.literal(CASE_VERSION),
    id: IdSchema,
    sourceId: IdSchema,
    location: z.string().min(1),
    text: z.string().min(1),
    chunkHash: HashSchema,
  })
  .strict();

const RightsApprovalSchema = z
  .object({
    schemaVersion: z.literal(CASE_VERSION),
    state: z.literal("approved"),
    basis: z.literal("project_authored_cc0"),
    caseId: IdSchema,
    caseVersion: z.literal(CASE_VERSION),
    packetFingerprint: HashSchema,
    approvedSourceIds: z.array(IdSchema).min(1),
    rightsDecisionHashes: z.array(HashSchema).min(1),
    approvalHash: HashSchema,
  })
  .strict();

const PublicModelInputSchema = z
  .object({
    schemaVersion: z.literal(CASE_VERSION),
    protocolBinding: ProtocolBindingSchema,
    classification: ClassificationSchema,
    benchmarkCase: BenchmarkCaseSchema,
    permissionNotes: z.array(z.string().min(1)).min(1),
    rightsApproval: RightsApprovalSchema,
    claims: z
      .array(
        z
          .object({
            id: IdSchema,
            statement: z.string().min(1),
            successCriterion: z.string().min(1),
            scopeConstraints: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    sources: z.array(SourceSchema).min(1),
    chunks: z.array(ChunkSchema).min(1),
  })
  .strict();

const PublicPackSchema = z
  .object({
    formatVersion: z.literal(CASE_VERSION),
    evidenceMode: z.literal("fixture"),
    cases: z.array(z.record(z.string(), z.unknown())).length(6),
  })
  .strict();

function buildPublicHeldOutCase(input: unknown) {
  const raw = z.record(z.string(), z.unknown()).parse(structuredClone(input));
  const benchmarkCase = createBenchmarkCase(raw.benchmarkCase);
  if (benchmarkCase.role !== "heldout") {
    throw new Error("public held-out pack contains a non-held-out case");
  }
  const modelInput = PublicModelInputSchema.parse({ ...raw, benchmarkCase });
  const sourceIds = new Set(modelInput.sources.map(({ id }) => id));
  if (sourceIds.size !== modelInput.sources.length) {
    throw new Error("public held-out source IDs must be distinct");
  }
  const chunkIds = new Set(modelInput.chunks.map(({ id }) => id));
  if (chunkIds.size !== modelInput.chunks.length) {
    throw new Error("public held-out chunk IDs must be distinct");
  }

  for (const source of modelInput.sources) {
    const { sourceHash, rights, ...sourceWithoutHashAndRights } = source;
    const { rightsDecisionHash, ...rightsWithoutHash } = rights;
    if (
      rightsDecisionHash !==
      canonicalSha256({
        schemaVersion: CASE_VERSION,
        sourceId: source.id,
        rights: rightsWithoutHash,
      })
    ) {
      throw new Error("public held-out rights decision hash mismatch");
    }
    if (
      sourceHash !==
      canonicalSha256({
        ...sourceWithoutHashAndRights,
        rights,
      })
    ) {
      throw new Error("public held-out source hash mismatch");
    }
  }
  for (const chunk of modelInput.chunks) {
    const { chunkHash, ...withoutHash } = chunk;
    if (!sourceIds.has(chunk.sourceId)) {
      throw new Error("public held-out chunk references an unknown source");
    }
    if (chunkHash !== canonicalSha256(withoutHash)) {
      throw new Error("public held-out chunk hash mismatch");
    }
  }

  const sourceHashes = modelInput.sources.map(({ sourceHash }) => sourceHash);
  const chunkHashes = modelInput.chunks.map(({ chunkHash }) => chunkHash);
  const rightsDecisionHashes = modelInput.sources.map(
    ({ rights }) => rights.rightsDecisionHash,
  );
  const packetFingerprint = canonicalSha256({
    schemaVersion: CASE_VERSION,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    caseId: benchmarkCase.id,
    caseVersion: benchmarkCase.version,
    sourceHashes,
    chunkHashes,
    rightsDecisionHashes,
  });
  if (
    benchmarkCase.packet.fingerprint !== packetFingerprint ||
    JSON.stringify(benchmarkCase.packet.sourceHashes) !==
      JSON.stringify(sourceHashes) ||
    JSON.stringify(benchmarkCase.packet.chunkHashes) !==
      JSON.stringify(chunkHashes)
  ) {
    throw new Error("public held-out packet identity mismatch");
  }
  if (
    benchmarkCase.metadataSnapshot.hash !==
    canonicalSha256({
      schemaVersion: CASE_VERSION,
      caseId: benchmarkCase.id,
      contentOrigin: "project_authored_fixture",
      sourceHashes,
      chunkHashes,
      rightsDecisionHashes,
    })
  ) {
    throw new Error("public held-out metadata snapshot hash mismatch");
  }

  const { approvalHash, ...rightsApprovalWithoutHash } =
    modelInput.rightsApproval;
  if (
    rightsApprovalWithoutHash.caseId !== benchmarkCase.id ||
    rightsApprovalWithoutHash.packetFingerprint !== packetFingerprint ||
    JSON.stringify(rightsApprovalWithoutHash.approvedSourceIds) !==
      JSON.stringify([...sourceIds].sort()) ||
    JSON.stringify(rightsApprovalWithoutHash.rightsDecisionHashes) !==
      JSON.stringify(rightsDecisionHashes) ||
    approvalHash !== canonicalSha256(rightsApprovalWithoutHash)
  ) {
    throw new Error("public held-out rights approval mismatch");
  }

  const manifest = {
    caseId: benchmarkCase.id,
    caseVersion: benchmarkCase.version,
    role: "heldout" as const,
    domain: benchmarkCase.domain,
    caseHash: benchmarkCase.caseHash,
    packetFingerprint,
    rightsApprovalHash: approvalHash,
    modelInputHash: canonicalSha256(modelInput),
    evidenceMode: "fixture" as const,
    measurementStatus: "unmeasured" as const,
    headlineEligible: false as const,
  };
  return ownAndDeepFreeze({ benchmarkCase, modelInput, manifest });
}

const parsedPublicPack = PublicPackSchema.parse(publicPack);
const INTERNAL_CASES = ownAndDeepFreeze(
  parsedPublicPack.cases
    .map((input) => buildPublicHeldOutCase(input))
    .sort((left, right) =>
      left.manifest.caseId.localeCompare(right.manifest.caseId),
    ),
);

const heldOutIds = new Set(
  INTERNAL_CASES.map(({ manifest }) => manifest.caseId),
);
if (INTERNAL_CASES.length !== 6 || heldOutIds.size !== 6) {
  throw new Error("public held-out set must contain six distinct cases");
}
const domainCounts = new Map<string, number>();
for (const { manifest } of INTERNAL_CASES) {
  domainCounts.set(
    manifest.domain,
    (domainCounts.get(manifest.domain) ?? 0) + 1,
  );
}
if (
  domainCounts.size !== 3 ||
  [...domainCounts.values()].some((count) => count !== 2)
) {
  throw new Error("public held-out set must contain two cases per safe domain");
}

const publicSetWithoutHash = {
  schemaVersion: CASE_VERSION,
  setVersion: CASE_VERSION,
  caseCount: 6 as const,
  evidenceMode: "fixture" as const,
  measurementStatus: "unmeasured" as const,
  headlineEligible: false as const,
  headlineBlockers: [
    "human_grading_incomplete",
    "measured_runs_absent",
  ] as const,
  cases: INTERNAL_CASES.map(({ manifest }) => manifest),
};

export const HELD_OUT_CASE_SET_MANIFEST = ownAndDeepFreeze({
  ...publicSetWithoutHash,
  setHash: canonicalSha256(publicSetWithoutHash),
});

export const HELD_OUT_CASE_MODEL_INPUTS = detachedFrozen(
  INTERNAL_CASES.map(({ modelInput }) => modelInput),
);

const caseById = new Map(
  INTERNAL_CASES.map((heldOutCase) => [heldOutCase.manifest.caseId, heldOutCase]),
);

function acceptedCase(caseId: string) {
  const parsedId = IdSchema.parse(caseId);
  const heldOutCase = caseById.get(parsedId);
  if (!heldOutCase) throw new Error(`unknown held-out case: ${parsedId}`);
  return heldOutCase;
}

export function getHeldOutCaseModelInput(caseId: string) {
  return detachedFrozen(acceptedCase(caseId).modelInput);
}

const HELD_OUT_CASE_CODE_VERSION =
  "545a2291fca45238f2394b8195d26666f5bb1f12";

function heldOutSmokeInput(heldOutCase: (typeof INTERNAL_CASES)[number]) {
  const caseId = heldOutCase.manifest.caseId;
  const runId = `${caseId}-freeze-smoke`;
  const attemptId = `${caseId}-freeze-smoke-attempt`;
  const benchmarkConfig = createBenchmarkConfig({
    id: `${caseId}-complete-workflow-smoke`,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    case: heldOutCase.benchmarkCase,
    conditionId: "complete_workflow",
    primaryModel: {
      provider: "fixture",
      modelId: "fixture-primary-v1",
      developerFamily: "fixture-primary-family",
      baseFamily: "fixture-primary-base",
    },
    adversarialReviewerModel: {
      provider: "fixture",
      modelId: "fixture-reviewer-v1",
      developerFamily: "fixture-reviewer-family",
      baseFamily: "fixture-reviewer-base",
    },
    generation: {
      maxOutputTokens: 4096,
      timeoutMs: 30_000,
      temperature: 0,
      topP: 1,
      responseFormat: "json_schema",
      seedPolicy: "unsupported",
    },
    outputContract: {
      schemaId: "heldout-case-smoke-output",
      schemaVersion: CASE_VERSION,
      schemaHash: canonicalSha256({ schema: "no-provider-heldout-smoke" }),
      requiredFieldsHash: canonicalSha256({ required: [] }),
      safetyConstraintsHash: canonicalSha256({
        safety: "fixture-heldout-no-provider",
      }),
    },
    promptManifest: FROZEN_CONSUMER_EDGE.promptManifest.map((prompt) => ({
      ...prompt,
    })),
    benchmarkCodeVersion: HELD_OUT_CASE_CODE_VERSION,
    retryPolicy: {
      maximumAttempts: 1,
      repairInvalidOutput: false,
      retryableFailureKinds: [],
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
  const runConfig = EvalRunConfigSchema.parse({
    runnerVersion: EVAL_RUNNER_VERSION,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    runId,
    rerunOfRunId: null,
    createdAt: FREEZE_TIMESTAMP,
    trialId: "trial-1",
    benchmarkConfig,
    evidenceMode: "fixture",
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
  });
  const request = createRequestMetadata({
    runId,
    attemptId,
    trialId: "trial-1",
    evidenceMode: "fixture",
    requestedAt: "2026-08-08T10:51:39.000Z",
    requestedProvider: benchmarkConfig.primaryModel.provider,
    requestedModelId: benchmarkConfig.primaryModel.modelId,
    providerRequestId: null,
    seed: null,
    generation: benchmarkConfig.generation,
    promptManifestHash: benchmarkConfig.promptManifestHash,
  });
  const attempts: RecordedAttempt[] = [
    {
      raw: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId,
        attemptNumber: 1,
        trialId: "trial-1",
        evidenceMode: "fixture",
        startedAt: "2026-08-08T10:51:39.000Z",
        completedAt: "2026-08-08T10:51:39.000Z",
        latencyMs: 0,
        request,
        status: "failed",
        rawOutput: null,
        failure: {
          kind: "fixture_failure",
          message:
            "No model or provider executed; this is deterministic held-out case freeze smoke only.",
          retryable: false,
          providerCode: null,
        },
      },
      parsed: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId,
        attemptNumber: 1,
        trialId: "trial-1",
        evidenceMode: "fixture",
        parseStatus: "not_parsed",
        canonicalRun: null,
        canonicalRunHash: null,
        validationIssues: [],
      },
    },
  ];
  return { runConfig, attempts };
}

export async function materializeHeldOutCaseSmoke(
  artifactRoot: string,
  caseId: string,
) {
  const heldOutCase = acceptedCase(caseId);
  const { runConfig, attempts } = heldOutSmokeInput(heldOutCase);
  return materializeFixtureRun({
    artifactRoot,
    config: runConfig,
    attempts,
  });
}
