import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { ExperimentReviewSchema } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  createFeatherlessAdapter,
  type AdapterRuntime,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "../../src/server/models";
import { promptRegistry } from "../../src/server/prompts/registry";
import { createPromptRunNodeRequestBuilder } from "../../src/server/prompts/render";

const candidates = [
  {
    modelId: "Qwen/Qwen2.5-72B-Instruct",
    slug: "qwen2.5-72b",
    developerFamily: "qwen",
    baseFamily: "qwen2.5",
  },
  {
    modelId: "meta-llama/Llama-3.3-70B-Instruct",
    slug: "llama-3.3-70b",
    developerFamily: "meta",
    baseFamily: "llama-3.3",
  },
] as const;

const smallSchema = z.object({ status: z.literal("ok") }).strict();
const reviewSchema = z.object({ review: ExperimentReviewSchema }).strict();
const artifactBase = resolve(
  process.cwd(),
  "artifacts",
  "submission",
  "reviewer-probes",
);

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

function artifactRoot(value: string | undefined) {
  if (!value) throw new Error("reviewer probe artifact root is required");
  const candidate = resolve(value);
  const fromBase = relative(artifactBase, candidate);
  if (
    candidate === artifactBase ||
    fromBase === "" ||
    fromBase.startsWith("..") ||
    isAbsolute(fromBase)
  ) {
    throw new Error("reviewer probe artifact root is outside the approved directory");
  }
  return candidate;
}

async function appendJson(root: string, name: string, value: unknown) {
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function safeAttempt(result: StructuredGenerationResult<z.ZodType>) {
  const attempt = result.attempts.at(-1);
  if (!attempt) throw new Error("provider probe returned no attempt record");
  const kinds = result.errors.map(({ kind }) => kind);
  return {
    ok: result.ok,
    nodeId: attempt.nodeId,
    attempt: attempt.attempt,
    status: attempt.status,
    requestedProvider: attempt.requestedProvider,
    returnedProvider: attempt.returnedProvider,
    requestedModelId: attempt.requestedModelId,
    returnedModelId: attempt.returnedModelId,
    requestIds: attempt.requestIds,
    finishReason: attempt.finishReason,
    refusal: attempt.refusal,
    clientLatencyMs: attempt.clientLatencyMs,
    providerTiming: attempt.providerTiming,
    usage: attempt.usage,
    pricing: attempt.pricing,
    validationIssueCount: attempt.validation.issues.length,
    errorKinds: kinds,
    jsonParseStatus:
      result.ok ? "valid" : kinds.includes("invalid_model_json") ? "invalid" : "not_proven",
    applicationSchemaStatus:
      result.ok
        ? "valid"
        : kinds.includes("invalid_model_output")
          ? "invalid"
          : "not_evaluated",
  };
}

function safeRequestShape(body: unknown) {
  const parsed = z
    .object({
      model: z.string(),
      messages: z.array(
        z.object({ role: z.string(), content: z.string() }).passthrough(),
      ),
      temperature: z.number(),
      max_tokens: z.number(),
      stream: z.boolean(),
      response_format: z.object({ type: z.string() }).passthrough(),
    })
    .passthrough()
    .parse(body);
  const serialized = JSON.stringify(parsed);
  return {
    fields: Object.keys(parsed).sort(),
    model: parsed.model,
    messageCount: parsed.messages.length,
    messageRoles: parsed.messages.map(({ role }) => role),
    messageContentCharacters: parsed.messages.map(({ content }) => content.length),
    serializedCharacters: serialized.length,
    serializedUtf8Bytes: Buffer.byteLength(serialized, "utf8"),
    temperature: parsed.temperature,
    maxTokens: parsed.max_tokens,
    stream: parsed.stream,
    responseFormat: parsed.response_format,
  };
}

function smallRequest(codeVersion: string) {
  return {
    nodeId: "reviewer-probe-small",
    inputRefs: ["sanitized-small-json-object"],
    outputRefs: ["sanitized-small-json-object-result"],
    promptId: "reviewer-json-object-probe",
    promptVersion: "1.0.0",
    promptHash: "7d5e190d2068d660824a27efebea9d0cc21ea429102736502a0c188a49c6232c",
    schemaVersion: "1.0.0",
    schemaName: "reviewer_json_object_probe",
    outputSchema: smallSchema,
    outputJsonSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["ok"] } },
      required: ["status"],
      additionalProperties: false,
    },
    messages: [
      {
        role: "system" as const,
        content: "Return only the requested JSON object.",
      },
      {
        role: "user" as const,
        content: 'Return exactly one JSON object whose status is "ok".',
      },
    ],
    settings: {
      temperature: 0,
      maxOutputTokens: 256,
      topP: null,
      seed: null,
      reasoningMode: "disabled" as const,
      reasoningBudgetTokens: null,
    },
    timeoutMs: 120_000,
    measured: false,
    repairInvalidOutput: false,
    maximumAttempts: 1 as const,
    codeVersion,
  } satisfies StructuredGenerationRequest<typeof smallSchema>;
}

function representativeRequest(codeVersion: string) {
  const resource = promptRegistry.forNode("review-experiment");
  const rendered = createPromptRunNodeRequestBuilder()({
    run: goldenRunV01,
    nodeId: "review-experiment",
    inputRefs: [
      goldenRunV01.packet!.fingerprint,
      goldenRunV01.selectedGapId!,
    ],
    objectionDispositions: null,
  });
  return {
    nodeId: "review-experiment",
    inputRefs: [
      goldenRunV01.packet!.fingerprint,
      goldenRunV01.selectedGapId!,
    ],
    outputRefs: ["sanitized-representative-review"],
    promptId: rendered.promptId,
    promptVersion: rendered.promptVersion,
    promptHash: rendered.promptHash,
    schemaVersion: resource.outputSchema.version,
    schemaName: resource.outputSchema.id.replaceAll("-", "_"),
    outputSchema: reviewSchema,
    outputJsonSchema: resource.outputSchema.jsonSchema,
    messages: rendered.messages,
    settings: { ...rendered.settings, maxOutputTokens: 2_048 },
    timeoutMs: 120_000,
    measured: false,
    repairInvalidOutput: false,
    maximumAttempts: 1 as const,
    codeVersion,
  } satisfies StructuredGenerationRequest<typeof reviewSchema>;
}

async function runProbe(
  candidate: typeof candidates[number],
  request: StructuredGenerationRequest<z.ZodType>,
  apiKey: string,
  fetchFn: Fetch,
) {
  let requestShape: ReturnType<typeof safeRequestShape> | null = null;
  const runtime: Partial<AdapterRuntime> = {
    transport: async (url, init) => {
      requestShape = safeRequestShape(JSON.parse(String(init.body)));
      return fetchFn(url, init);
    },
  };
  const adapter = createFeatherlessAdapter(
    {
      apiKey,
      modelId: candidate.modelId,
      developerFamily: candidate.developerFamily,
      baseFamily: candidate.baseFamily,
      evidenceMode: "live",
    },
    runtime,
  );
  const result = await adapter.generate(request);
  if (requestShape === null) throw new Error("provider transport was not invoked");
  return { requestShape, result: safeAttempt(result) };
}

export async function runReviewerProbeOperator(
  environment: Environment,
  fetchFn: Fetch = fetch,
) {
  if (
    environment.REVIEWER_PROBE_AUTHORIZED !== "1" ||
    environment.REVIEWER_PROBE_ZERO_PAID_SPEND !== "1" ||
    environment.REVIEWER_PROBE_FIXED_PLAN_CONFIRMED !== "1"
  ) {
    throw new Error("reviewer probe authorization is missing");
  }
  const apiKey = environment.FEATHERLESS_API_KEY;
  if (!apiKey) throw new Error("Featherless credential is missing");
  const codeVersion = environment.REVIEWER_PROBE_CODE_VERSION;
  if (!codeVersion || !/^[a-f0-9]{40}$/.test(codeVersion)) {
    throw new Error("reviewer probe code version is invalid");
  }
  const root = artifactRoot(environment.REVIEWER_PROBE_ARTIFACT_ROOT);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
  };
  const planResponse = await fetchFn("https://api.featherless.ai/v1/plan", {
    headers,
  });
  if (!planResponse.ok) throw new Error(`plan preflight HTTP ${planResponse.status}`);
  const plan = await planResponse.json() as Record<string, unknown>;
  if ((plan.id ?? plan.plan_id) !== "feather_pro_plus") {
    throw new Error("reviewer probe requires the approved fixed plan");
  }
  const catalogResponse = await fetchFn(
    "https://api.featherless.ai/v1/models?available_on_current_plan=true&per_page=1000",
    { headers },
  );
  if (!catalogResponse.ok) {
    throw new Error(`catalog preflight HTTP ${catalogResponse.status}`);
  }
  const catalogBody = await catalogResponse.json() as
    | readonly Record<string, unknown>[]
    | { data?: readonly Record<string, unknown>[]; models?: readonly Record<string, unknown>[] };
  const rows: readonly Record<string, unknown>[] = Array.isArray(catalogBody)
    ? catalogBody
    : (
        catalogBody as {
          data?: readonly Record<string, unknown>[];
          models?: readonly Record<string, unknown>[];
        }
      ).data ??
      (
        catalogBody as {
          models?: readonly Record<string, unknown>[];
        }
      ).models ??
      [];
  const metadata = candidates.map((candidate) => {
    const row = rows.find(
      (item) => (item.id ?? item.model ?? item.name) === candidate.modelId,
    );
    return {
      ...candidate,
      availableOnCurrentPlan: row?.available_on_current_plan === true,
      contextLength: row?.context_length ?? row?.max_context_length ?? null,
      maxCompletionTokens: row?.max_completion_tokens ?? null,
      heterogeneousFromPrimary:
        String(candidate.developerFamily) !== "mistralai" &&
        String(candidate.baseFamily) !== "mistral-large",
    };
  });
  await appendJson(root, "000-preflight.json", {
    schemaVersion: "1.0.0",
    evidenceMode: "live",
    codeVersion,
    plan: {
      id: plan.id ?? plan.plan_id,
      maxContextLength:
        plan.max_context_length ?? plan.context_length ?? plan.max_context ?? null,
    },
    catalogRowCount: rows.length,
    candidates: metadata,
    strictZeroIncrementalSpend: true,
    candidateOrder: candidates.map(({ modelId }) => modelId),
  });

  const outcomes = [];
  let selectedModelId: string | null = null;
  let sequence = 1;
  for (const candidate of candidates) {
    const candidateMetadata = metadata.find(
      ({ modelId }) => modelId === candidate.modelId,
    )!;
    if (
      !candidateMetadata.availableOnCurrentPlan ||
      !candidateMetadata.heterogeneousFromPrimary ||
      (typeof candidateMetadata.contextLength === "number" &&
        candidateMetadata.contextLength < 7_137) ||
      (typeof candidateMetadata.maxCompletionTokens === "number" &&
        candidateMetadata.maxCompletionTokens < 2_048)
    ) {
      outcomes.push({
        modelId: candidate.modelId,
        classification: "metadata_preflight_failed",
      });
      continue;
    }

    const small = await runProbe(
      candidate,
      smallRequest(codeVersion),
      apiKey,
      fetchFn,
    );
    await appendJson(
      root,
      `${String(sequence++).padStart(3, "0")}-${candidate.slug}-small.json`,
      { schemaVersion: "1.0.0", modelId: candidate.modelId, probe: "small", ...small },
    );
    if (!small.result.ok) {
      outcomes.push({
        modelId: candidate.modelId,
        classification: "small_probe_failed",
      });
      continue;
    }

    const representative = await runProbe(
      candidate,
      representativeRequest(codeVersion),
      apiKey,
      fetchFn,
    );
    await appendJson(
      root,
      `${String(sequence++).padStart(3, "0")}-${candidate.slug}-representative.json`,
      {
        schemaVersion: "1.0.0",
        modelId: candidate.modelId,
        probe: "representative_reviewer",
        ...representative,
      },
    );
    if (!representative.result.ok) {
      outcomes.push({
        modelId: candidate.modelId,
        classification: "representative_probe_failed",
      });
      continue;
    }
    selectedModelId = candidate.modelId;
    outcomes.push({
      modelId: candidate.modelId,
      classification: "transport_and_schema_compatible",
    });
    break;
  }

  const summary = {
    schemaVersion: "1.0.0",
    evidenceMode: "live",
    codeVersion,
    selectedModelId,
    outcomes,
    strictZeroIncrementalSpend: true,
    noBenchmarkQualityClaim: true,
  };
  await appendJson(root, "999-summary.json", summary);
  return summary;
}
