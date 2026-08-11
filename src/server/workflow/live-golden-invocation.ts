import { createHash } from "node:crypto";

import { z } from "zod";

import {
  HumanDecisionSchema,
  NodeExecutionSchema,
  PREVIOUS_CONTRACT_VERSION,
  ResearchRunSchema,
  canonicalSha256,
  type ResearchRun,
} from "../../contracts";
import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_SHA256,
  GOLDEN_PACKET_FINGERPRINT,
  goldenRunV01,
} from "../../fixtures/golden-run-v0.1";
import {
  createFeatherlessAdapter,
  MAXIMUM_PROVIDER_RETRY_BACKOFF_MS,
  type AdapterRuntime,
  type StructuredGenerationAdapter,
} from "../models";
import { promptRegistry } from "../prompts/registry";
import { createPromptRunNodeRequestBuilder } from "../prompts/render";
import {
  createLiveGoldenArtifactConfig,
  APPROVED_EVF9_RIGHTS_APPROVAL_SHA256,
  APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY,
  APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
  APPROVED_PROMPT_MANIFEST_HASH,
  LiveGoldenArtifactSession,
} from "../../../evals/live-golden/v1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
} from "../../../evals/protocol/v1";
import { RunService } from "./run-api";
import {
  ObjectionDispositionPlanSchema,
  type HumanDecision,
  type ObjectionDispositionPlan,
} from "./state-machine";
import { InMemoryWorkflowRunStore } from "./store";

export const LIVE_GOLDEN_INVOCATION_VERSION = "2.0.0" as const;
export const LIVE_GOLDEN_TIMEOUT_POLICY_VERSION = "2.0.0" as const;
export const LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS = 120_000 as const;
export const LIVE_GOLDEN_TIMEOUT_POLICY = Object.freeze({
  version: LIVE_GOLDEN_TIMEOUT_POLICY_VERSION,
  scope: "per_transport_attempt" as const,
  maximumTransportAttempts: 2 as const,
  maximumTransportBudgetMs: 240_000 as const,
  maximumRetryBackoffMs: MAXIMUM_PROVIDER_RETRY_BACKOFF_MS,
});
export const LIVE_GOLDEN_OUTPUT_LIMIT_POLICY_VERSION = "1.0.0" as const;
export const LIVE_GOLDEN_MAX_OUTPUT_TOKENS = 2_048 as const;
export const LIVE_GOLDEN_STRUCTURED_OUTPUT_TRANSPORT_POLICY = Object.freeze({
  version: "1.0.0" as const,
  responseFormat: "json_object" as const,
  promptSchemaAppended: true as const,
  applicationValidation: true as const,
});
export const EVF9_RIGHTS_APPROVAL_SHA256 =
  APPROVED_EVF9_RIGHTS_APPROVAL_SHA256;

const APPROVED_SOURCE_ORDER = Object.freeze([
  "gf-source-01",
  "gf-source-02",
  "gf-source-03",
  "gf-source-04",
  "gf-source-05",
  "gf-source-06",
  "gf-source-07",
] as const);
const APPROVED_CHUNK_ORDER = Object.freeze([
  "gf-chunk-01",
  "gf-chunk-02",
  "gf-chunk-03",
  "gf-chunk-04",
  "gf-chunk-05",
  "gf-chunk-06",
  "gf-chunk-07",
] as const);

export const APPROVED_LIVE_GOLDEN_AUTHORITY = Object.freeze({
  artifactScope: "approved_live_golden" as const,
  contractVersion: PREVIOUS_CONTRACT_VERSION,
  fixtureId: GOLDEN_FIXTURE_ID,
  fixtureSha256: GOLDEN_FIXTURE_SHA256,
  packetFingerprint: GOLDEN_PACKET_FINGERPRINT,
  rightsApprovalSha256: EVF9_RIGHTS_APPROVAL_SHA256,
  sourceOrder: APPROVED_SOURCE_ORDER,
  chunkOrder: APPROVED_CHUNK_ORDER,
  sourceHashes: Object.freeze(
    goldenRunV01.sources.map(({ contentHash }) => contentHash),
  ),
  chunkHashes: Object.freeze(
    goldenRunV01.chunks.map(({ contentHash }) => contentHash),
  ),
});

function immutableAuthorityProjection(run: ResearchRun) {
  return {
    rightsApprovalSha256: EVF9_RIGHTS_APPROVAL_SHA256,
    contractVersion: run.schemaVersion,
    fixtureId: GOLDEN_FIXTURE_ID,
    fixtureSha256: GOLDEN_FIXTURE_SHA256,
    intake: run.intake,
    claims: run.claims,
    scopeDecision: run.scopeDecision,
    packet: run.packet,
    sources: run.sources,
    chunks: run.chunks,
  };
}

export const COMPUTED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH = canonicalSha256(
  immutableAuthorityProjection(goldenRunV01),
);
export const APPROVED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH =
  "39a314781affb50826bc99f2799fba7e47a2a08faaf27a4cf39e53d09be15d34" as const;

export class LiveGoldenPreflightError extends Error {
  constructor(
    readonly code:
      | "INVALID_INVOCATION_INPUT"
      | "GOLDEN_AUTHORITY_MISMATCH"
      | "MISSING_CREDENTIALS"
      | "PROVIDER_CONFIGURATION_MISMATCH"
      | "DECISION_CALLBACK_FAILED"
      | "CREDENTIAL_EXPOSURE_BLOCKED",
  ) {
    super(`live golden invocation preflight failed: ${code}`);
    this.name = "LiveGoldenPreflightError";
  }
}

function exactOrder(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function assertApprovedLiveGoldenAuthority(
  input: unknown,
): typeof APPROVED_LIVE_GOLDEN_AUTHORITY {
  let run: ResearchRun;
  try {
    run = ResearchRunSchema.parse(structuredClone(input));
  } catch {
    throw new LiveGoldenPreflightError("GOLDEN_AUTHORITY_MISMATCH");
  }
  const packet = run.packet;
  const sourceOrder = run.sources.map(({ id }) => id);
  const chunkOrder = run.chunks.map(({ id }) => id);
  const sourceHashes = run.sources.map(({ contentHash }) => contentHash).sort();
  const chunkHashes = run.chunks.map(({ contentHash }) => contentHash).sort();
  const exactChunkHashes = run.chunks.map(({ text }) =>
    createHash("sha256").update(text, "utf8").digest("hex"),
  );
  if (
    run.id !== GOLDEN_FIXTURE_ID ||
    run.schemaVersion !== PREVIOUS_CONTRACT_VERSION ||
    canonicalSha256(run) !== GOLDEN_FIXTURE_SHA256 ||
    packet === null ||
    packet.fingerprint !== GOLDEN_PACKET_FINGERPRINT ||
    !exactOrder(sourceOrder, APPROVED_SOURCE_ORDER) ||
    !exactOrder(chunkOrder, APPROVED_CHUNK_ORDER) ||
    !exactOrder(packet.sourceHashes, sourceHashes) ||
    !exactOrder(packet.chunkHashes, chunkHashes) ||
    !exactOrder(
      run.chunks.map(({ contentHash }) => contentHash),
      exactChunkHashes,
    ) ||
    !run.sources.every(
      (source, index) => source.contentHash === run.chunks[index]?.contentHash,
    ) ||
    canonicalSha256(immutableAuthorityProjection(run)) !==
      APPROVED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH ||
    packet.freezeDecision.decision !== "approve" ||
    run.sources.some(
      ({ rights }) =>
        rights.mayStore !== "allowed" ||
        rights.mayDisplay !== "allowed" ||
        rights.maySendToModel !== "allowed",
    )
  ) {
    throw new LiveGoldenPreflightError("GOLDEN_AUTHORITY_MISMATCH");
  }
  return APPROVED_LIVE_GOLDEN_AUTHORITY;
}

const ProviderEnvironmentSchema = z
  .object({
    primaryProvider: z.literal("featherless"),
    primaryModel: z.literal("mistralai/Mistral-Large-Instruct-2411"),
    reviewerProvider: z.literal("featherless"),
    reviewerModel: z.literal("Qwen/Qwen2.5-72B-Instruct"),
    featherlessApiKey: z.string(),
  })
  .strict();

export type LiveGoldenObjectionDecision = Readonly<{
  decision: HumanDecision;
  dispositions: ObjectionDispositionPlan;
}>;

type LiveGoldenInvocationBase = Readonly<{
  artifactRoot: string;
  codeVersion: string;
  providerEnvironment: z.input<typeof ProviderEnvironmentSchema>;
  decisions: Readonly<{
    objections: (run: ResearchRun) => LiveGoldenObjectionDecision;
    final: (run: ResearchRun) => Readonly<{
      choice: "approve" | "reject";
      declaredActor: string;
      rationale: string;
    }>;
  }>;
}>;

export type LiveGoldenInvocationInput = LiveGoldenInvocationBase;

export type MockedLiveGoldenInvocationInput = LiveGoldenInvocationBase &
  Readonly<{
  runtime: Readonly<{
    primary?: Partial<AdapterRuntime>;
    reviewer?: Partial<AdapterRuntime>;
    workflow?: Readonly<{
      now: () => Date;
      makeId: (prefix: string) => string;
    }>;
  }>;
}>;

const allowedInvocationKeys = new Set([
  "artifactRoot",
  "codeVersion",
  "providerEnvironment",
  "decisions",
]);

const allowedMockedInvocationKeys = new Set([
  ...allowedInvocationKeys,
  "runtime",
]);

function containsCredential(
  value: unknown,
  credentials: readonly string[],
): boolean {
  if (typeof value === "string") {
    return credentials.some((credential) => value.includes(credential));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsCredential(item, credentials));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) =>
        containsCredential(key, credentials) ||
        containsCredential(item, credentials),
    );
  }
  return false;
}

function assertCredentialFree(
  value: unknown,
  credentials: readonly string[],
): void {
  if (containsCredential(value, credentials)) {
    throw new LiveGoldenPreflightError("CREDENTIAL_EXPOSURE_BLOCKED");
  }
}

function invokeDecision<T>(
  callback: () => T,
  credentials: readonly string[],
): T {
  try {
    const value = structuredClone(callback());
    assertCredentialFree(value, credentials);
    return value;
  } catch (error) {
    if (
      error instanceof LiveGoldenPreflightError &&
      error.code === "CREDENTIAL_EXPOSURE_BLOCKED"
    ) {
      throw error;
    }
    throw new LiveGoldenPreflightError("DECISION_CALLBACK_FAILED");
  }
}

function preflight(
  input: LiveGoldenInvocationBase,
  allowMockedRuntime: boolean,
) {
  const allowedKeys = allowMockedRuntime
    ? allowedMockedInvocationKeys
    : allowedInvocationKeys;
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.artifactRoot !== "string" ||
    input.artifactRoot.trim() === "" ||
    !/^[a-f0-9]{40}$/.test(input.codeVersion) ||
    typeof input.decisions?.objections !== "function" ||
    typeof input.decisions?.final !== "function"
  ) {
    throw new LiveGoldenPreflightError("INVALID_INVOCATION_INPUT");
  }
  let providerEnvironment: z.output<typeof ProviderEnvironmentSchema>;
  try {
    providerEnvironment = ProviderEnvironmentSchema.parse(
      structuredClone(input.providerEnvironment),
    );
  } catch {
    throw new LiveGoldenPreflightError("PROVIDER_CONFIGURATION_MISMATCH");
  }
  if (
    providerEnvironment.featherlessApiKey.trim() === ""
  ) {
    throw new LiveGoldenPreflightError("MISSING_CREDENTIALS");
  }
  if (
    providerEnvironment.featherlessApiKey.length < 16
  ) {
    throw new LiveGoldenPreflightError("PROVIDER_CONFIGURATION_MISMATCH");
  }
  const credentials = [providerEnvironment.featherlessApiKey];
  assertCredentialFree(
    {
      artifactRoot: input.artifactRoot,
      codeVersion: input.codeVersion,
    },
    credentials,
  );
  assertApprovedLiveGoldenAuthority(goldenRunV01);
  if (
    COMPUTED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH !==
      APPROVED_LIVE_GOLDEN_IMMUTABLE_AUTHORITY_HASH ||
    COMPUTED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH !==
      APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH ||
    FROZEN_CONSUMER_EDGE.promptManifestHash !==
      APPROVED_PROMPT_MANIFEST_HASH ||
    canonicalSha256(FROZEN_CONSUMER_EDGE.promptManifest) !==
      APPROVED_PROMPT_MANIFEST_HASH
  ) {
    throw new LiveGoldenPreflightError("PROVIDER_CONFIGURATION_MISMATCH");
  }
  return {
    artifactRoot: input.artifactRoot,
    codeVersion: input.codeVersion,
    providerEnvironment,
  };
}

function executionWithoutMonetaryPricing(executionInput: unknown) {
  const execution = NodeExecutionSchema.parse(structuredClone(executionInput));
  return NodeExecutionSchema.parse({
    ...execution,
    pricing: {
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      estimatedCost: null,
      snapshotDate: null,
    },
  });
}

function strictAuditedAdapter(
  adapter: StructuredGenerationAdapter,
): StructuredGenerationAdapter {
  return {
    identity: Object.freeze({ ...adapter.identity }),
    async generate(request) {
      const result = await adapter.generate({
        ...request,
        settings: {
          ...request.settings,
          maxOutputTokens: LIVE_GOLDEN_MAX_OUTPUT_TOKENS,
        },
        timeoutMs: LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS,
      });
      const attempts = result.attempts.map((attempt) =>
        executionWithoutMonetaryPricing(attempt),
      );
      return { ...result, attempts };
    },
  };
}

function approvedNodeConfigurations() {
  const configuration = promptRegistry
      .list()
      .filter(({ providerCapabilities }) =>
        providerCapabilities.modelInvocation === "allowed",
      )
      .map((resource) => ({
        id: resource.id,
        version: resource.version,
        hash: resource.hash,
        nodeId: resource.nodeId,
        inputSchema: {
          id: resource.inputSchema.id,
          version: resource.inputSchema.version,
          hash: resource.inputSchema.hash,
        },
        outputSchema: {
          id: resource.outputSchema.id,
          version: resource.outputSchema.version,
          hash: resource.outputSchema.hash,
        },
        generationSettings: {
          ...resource.generationSettings,
          maxOutputTokens: LIVE_GOLDEN_MAX_OUTPUT_TOKENS,
        },
        outputLimitPolicyVersion: LIVE_GOLDEN_OUTPUT_LIMIT_POLICY_VERSION,
        structuredOutputTransportPolicy:
          LIVE_GOLDEN_STRUCTURED_OUTPUT_TRANSPORT_POLICY,
        timeoutMs: LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS,
        timeoutPolicyVersion: LIVE_GOLDEN_TIMEOUT_POLICY_VERSION,
        timeoutScope: LIVE_GOLDEN_TIMEOUT_POLICY.scope,
        maximumTransportBudgetMs:
          LIVE_GOLDEN_FEATHERLESS_TIMEOUT_MS * resource.maximumAttempts,
        maximumRetryBackoffMs:
          LIVE_GOLDEN_TIMEOUT_POLICY.maximumRetryBackoffMs,
        maximumAttempts: resource.maximumAttempts,
        repairInvalidOutput: resource.repairInvalidOutput,
        providerCapabilities: resource.providerCapabilities,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.parse(JSON.stringify(configuration));
}

export const COMPUTED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH = canonicalSha256(
  {
    nodeConfigurations: approvedNodeConfigurations(),
    reviewerModel: {
      provider: "featherless",
      modelId: "Qwen/Qwen2.5-72B-Instruct",
      developerFamily: "qwen",
      baseFamily: "qwen2.5",
    },
  },
);

async function runApprovedGoldenInvocation(
  input: LiveGoldenInvocationBase,
  evidenceMode: "live" | "mocked",
  runtime?: MockedLiveGoldenInvocationInput["runtime"],
): Promise<{
  ok: boolean;
  run: ResearchRun;
  manifestPath: string;
  comparisonInvalidatingHash: string;
}> {
  const checked = preflight(input, evidenceMode === "mocked");
  const credentials = [checked.providerEnvironment.featherlessApiKey];
  const nodeConfigurations = approvedNodeConfigurations();
  const config = createLiveGoldenArtifactConfig({
    schemaVersion: LIVE_GOLDEN_INVOCATION_VERSION,
    artifactScope: "approved_live_golden",
    evidenceMode,
    contractVersion: PREVIOUS_CONTRACT_VERSION,
    benchmarkProtocolVersion: "1.0.0",
    benchmarkProtocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: APPROVED_PROMPT_MANIFEST_HASH,
    promptManifest: FROZEN_CONSUMER_EDGE.promptManifest.map((item) => ({ ...item })),
    codeVersion: checked.codeVersion,
    authority: {
      ...APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY,
      sourceOrder: [...APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY.sourceOrder],
      chunkOrder: [...APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY.chunkOrder],
      sourceHashes: [...APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY.sourceHashes],
      chunkHashes: [...APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY.chunkHashes],
    },
    primaryModel: {
      provider: "featherless",
      modelId: checked.providerEnvironment.primaryModel,
      developerFamily: "mistralai",
      baseFamily: "mistral-large",
    },
    reviewerModel: {
      provider: "featherless",
      modelId: checked.providerEnvironment.reviewerModel,
      developerFamily: "qwen",
      baseFamily: "qwen2.5",
    },
    costBasis: null,
    nodeConfigurations,
    nodeConfigurationHash: APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
  });
  assertCredentialFree(config, credentials);
  const primary = strictAuditedAdapter(
    createFeatherlessAdapter(
      {
        apiKey: checked.providerEnvironment.featherlessApiKey,
        modelId: checked.providerEnvironment.primaryModel,
        developerFamily: "mistralai",
        baseFamily: "mistral-large",
        evidenceMode,
      },
      runtime?.primary,
    ),
  );
  const reviewer = strictAuditedAdapter(
    createFeatherlessAdapter(
      {
        apiKey: checked.providerEnvironment.featherlessApiKey,
        modelId: checked.providerEnvironment.reviewerModel,
        developerFamily: "qwen",
        baseFamily: "qwen2.5",
        evidenceMode,
      },
      runtime?.reviewer,
    ),
  );
  let artifactSession: LiveGoldenArtifactSession | null = null;
  const service = new RunService({
    store: new InMemoryWorkflowRunStore(),
    primaryAdapter: primary,
    reviewerAdapter: reviewer,
    evidenceMode,
    requestBuilder: createPromptRunNodeRequestBuilder(),
    codeVersion: checked.codeVersion,
    historySink: {
      async append({ attempt, errors }) {
        assertCredentialFree({ attempt, errors }, credentials);
        if (artifactSession === null) {
          throw new Error("live golden durable history is not initialized");
        }
        await artifactSession.appendAttempt(attempt, errors);
      },
    },
    runtime: runtime?.workflow,
  });
  let snapshot = service.bootstrapApprovedGoldenInvocation();
  assertCredentialFree(snapshot.run, credentials);
  artifactSession = await LiveGoldenArtifactSession.initialize({
    artifactRoot: checked.artifactRoot,
    config,
    runId: snapshot.run.id,
  });
  let ok = true;
  while (true) {
    const progress = service.progress(snapshot.run.id);
    if (progress.nextAction === "continue") {
      const continued = await service.continue({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
      });
      snapshot = continued.snapshot;
      if (!continued.advanced) {
        ok = false;
        break;
      }
      continue;
    }
    if (progress.nextAction === "objection_dispositions") {
      const provided = invokeDecision(
        () =>
          input.decisions.objections(
            ResearchRunSchema.parse(structuredClone(snapshot.run)),
          ),
        credentials,
      );
      const decision = HumanDecisionSchema.parse(
        structuredClone(provided.decision),
      );
      const dispositions = ObjectionDispositionPlanSchema.parse(
        structuredClone(provided.dispositions),
      );
      snapshot = service.submitObjections({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        decision,
        dispositions,
      });
      continue;
    }
    if (progress.nextAction === "final_decision") {
      const decision = structuredClone(
        invokeDecision(
          () =>
            input.decisions.final(
              ResearchRunSchema.parse(structuredClone(snapshot.run)),
            ),
          credentials,
        ),
      );
      snapshot = service.decideFinal({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        decision,
      });
      continue;
    }
    if (progress.terminal) {
      ok = snapshot.run.status === "approved" || snapshot.run.status === "rejected";
      break;
    }
    ok = false;
    break;
  }
  assertCredentialFree(snapshot.run, credentials);
  const artifact = await artifactSession.finalize(snapshot.run);
  return {
    ok,
    run: ResearchRunSchema.parse(structuredClone(snapshot.run)),
    manifestPath: artifact.manifestPath,
    comparisonInvalidatingHash: config.comparisonInvalidatingHash,
  };
}

export function runApprovedLiveGoldenInvocation(
  input: LiveGoldenInvocationInput,
) {
  return runApprovedGoldenInvocation(input, "live");
}

export function runMockedApprovedLiveGoldenInvocation(
  input: MockedLiveGoldenInvocationInput,
) {
  return runApprovedGoldenInvocation(input, "mocked", input.runtime);
}
