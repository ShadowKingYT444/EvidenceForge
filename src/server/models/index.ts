import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  NodeExecutionSchema,
  RunErrorSchema,
  type NodeExecution,
} from "../../contracts";

type JsonObject = Record<string, unknown>;

export type ProviderMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type StructuredGenerationRequest<
  Schema extends z.ZodType = z.ZodType,
> = Readonly<{
  nodeId: string;
  inputRefs: readonly string[];
  outputRefs: readonly string[];
  promptId: string;
  promptVersion: string;
  promptHash: string;
  schemaVersion: string;
  schemaName: string;
  outputSchema: Schema;
  outputJsonSchema: Readonly<JsonObject>;
  messages: readonly ProviderMessage[];
  settings: NodeExecution["generationSettings"];
  timeoutMs: number;
  measured: boolean;
  repairInvalidOutput: boolean;
  maximumAttempts: 1 | 2;
  codeVersion: string | null;
  fixtureKey?: string;
  signal?: AbortSignal;
}>;

export type StructuredGenerationSuccess<Schema extends z.ZodType> = Readonly<{
  ok: true;
  value: z.output<Schema>;
  attempts: readonly NodeExecution[];
  errors: readonly z.infer<typeof RunErrorSchema>[];
}>;

export type StructuredGenerationFailure = Readonly<{
  ok: false;
  attempts: readonly NodeExecution[];
  errors: readonly z.infer<typeof RunErrorSchema>[];
}>;

export type StructuredGenerationResult<Schema extends z.ZodType> =
  | StructuredGenerationSuccess<Schema>
  | StructuredGenerationFailure;

export type HttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type AdapterRuntime = Readonly<{
  transport: HttpTransport;
  now: () => Date;
  monotonicNow: () => number;
  makeId: (prefix: string) => string;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

export type StructuredGenerationAdapter = Readonly<{
  identity: Readonly<{
    provider: "groq" | "nvidia_nim" | "featherless" | "fixture";
    modelId: string;
    developerFamily: string;
    baseFamily: string;
  }>;
  generate<Schema extends z.ZodType>(
    request: StructuredGenerationRequest<Schema>,
  ): Promise<StructuredGenerationResult<Schema>>;
}>;

export type PricingConfiguration = Readonly<{
  currency: string;
  inputPerMillionTokens: number;
  cachedInputPerMillionTokens: number | null;
  outputPerMillionTokens: number;
  snapshotDate: string;
}>;

export type ProviderConfiguration = Readonly<{
  apiKey: string;
  modelId: string;
  developerFamily: string;
  baseFamily: string;
  evidenceMode?: "live" | "mocked";
  endpoint?: string;
  pricing?: PricingConfiguration;
}>;

export type FixtureConfiguration = Readonly<{
  modelId: string;
  developerFamily: string;
  baseFamily: string;
  fixtures: Readonly<Record<string, unknown>>;
}>;

type ProviderKind = "groq" | "nvidia_nim" | "featherless";

type AttemptFailure = Readonly<{
  ok: false;
  execution: NodeExecution;
  error: z.infer<typeof RunErrorSchema>;
  repairable: boolean;
  invalidContent: string | null;
  retryAfterMs?: number;
}>;

type AttemptSuccess<Schema extends z.ZodType> = Readonly<{
  ok: true;
  value: z.output<Schema>;
  execution: NodeExecution;
}>;

type AttemptResult<Schema extends z.ZodType> =
  | AttemptSuccess<Schema>
  | AttemptFailure;

type Usage = NodeExecution["usage"];
type ProviderTiming = NodeExecution["providerTiming"];

const emptyUsage: Usage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
};

const emptyTiming: ProviderTiming = {
  queueMs: null,
  promptMs: null,
  completionMs: null,
  totalMs: null,
};

const defaultRuntime: AdapterRuntime = {
  transport: (url, init) => fetch(url, init),
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  makeId: (prefix) => `${prefix}-${randomUUID()}`,
};

const maximumResponseBytes = 4 * 1024 * 1024;
const maximumProviderStringLength = 512;
export const MAXIMUM_PROVIDER_RETRY_BACKOFF_MS = 1_000 as const;
const groqStrictModels = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function providerString(
  value: unknown,
  secret: string,
  maximumLength = maximumProviderStringLength,
): string | null {
  const text = stringValue(value);
  if (text === null) {
    return null;
  }
  if (secret && text.includes(secret)) {
    return "[redacted]";
  }
  return text.slice(0, maximumLength);
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) {
    return false;
  }
  if (typeof value === "string") {
    return value.includes(secret);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecret(item, secret));
  }
  return (
    isObject(value) &&
    Object.entries(value).some(
      ([key, item]) => key.includes(secret) || containsSecret(item, secret),
    )
  );
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function integerValue(value: unknown): number | null {
  const valueAsNumber = numberValue(value);
  return valueAsNumber !== null && Number.isInteger(valueAsNumber)
    ? valueAsNumber
    : null;
}

function milliseconds(value: unknown): number | null {
  const seconds = numberValue(value);
  return seconds === null ? null : seconds * 1_000;
}

function sanitizeProviderCode(value: unknown, secret: string): string | null {
  const code = providerString(value, secret, 128);
  if (code === "[redacted]") {
    return "redacted";
  }
  return code !== null && /^[A-Za-z0-9_.:-]{1,128}$/.test(code)
    ? code
    : null;
}

function normalizeRuntime(runtime?: Partial<AdapterRuntime>): AdapterRuntime {
  return {
    ...defaultRuntime,
    ...runtime,
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

type DeadlineSignal = Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}>;

function createDeadlineSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): DeadlineSignal {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "provider request exceeded the client deadline",
          "TimeoutError",
        ),
      ),
    timeoutMs,
  );
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function waitForTransport(
  pending: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) {
    void pending.catch(() => {});
    throw signal.reason;
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
    void pending.catch(() => {});
  }
}

function schemaIssues(schema: Readonly<JsonObject>): string[] {
  const issues: string[] = [];
  const rootDefinitions = isObject(schema.$defs)
    ? new Set(Object.keys(schema.$defs).map((name) => `#/$defs/${name}`))
    : new Set<string>();
  const allowedTypes = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "object",
    "array",
  ]);
  const allowedKeywords = new Set([
    "$schema",
    "$defs",
    "$ref",
    "type",
    "title",
    "description",
    "enum",
    "anyOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
  ]);

  function visit(value: unknown, path: string): void {
    if (!isObject(value)) {
      issues.push(`${path} must be a schema object`);
      return;
    }

    for (const keyword of Object.keys(value)) {
      if (!allowedKeywords.has(keyword)) {
        issues.push(`${path}.${keyword} is not in the supported subset`);
      }
    }

    const declaredTypes = Array.isArray(value.type)
      ? value.type
      : value.type === undefined
        ? []
        : [value.type];
    if (
      declaredTypes.some(
        (type) => typeof type !== "string" || !allowedTypes.has(type),
      )
    ) {
      issues.push(`${path}.type is unsupported`);
    }
    if (new Set(declaredTypes).size !== declaredTypes.length) {
      issues.push(`${path}.type must not contain duplicates`);
    }
    if (
      !("type" in value) &&
      !("anyOf" in value) &&
      !("$ref" in value)
    ) {
      issues.push(`${path} must declare type, anyOf, or a local $ref`);
    }
    if (
      "$ref" in value &&
      (typeof value.$ref !== "string" ||
        (value.$ref !== "#" && !rootDefinitions.has(value.$ref)))
    ) {
      issues.push(`${path}.$ref must resolve to the root or root $defs`);
    }
    if (
      "enum" in value &&
      (!Array.isArray(value.enum) || value.enum.length === 0)
    ) {
      issues.push(`${path}.enum must be a non-empty array`);
    } else if (
      Array.isArray(value.enum) &&
      value.enum.some(
        (item) =>
          item !== null &&
          !["string", "number", "boolean"].includes(typeof item),
      )
    ) {
      issues.push(`${path}.enum contains an unsupported value`);
    }

    if ("anyOf" in value) {
      if (!Array.isArray(value.anyOf) || value.anyOf.length === 0) {
        issues.push(`${path}.anyOf must be a non-empty array`);
      } else {
        value.anyOf.forEach((branch, index) =>
          visit(branch, `${path}.anyOf[${index}]`),
        );
      }
    }

    const isObjectSchema =
      declaredTypes.includes("object") || isObject(value.properties);
    if ("properties" in value && !declaredTypes.includes("object")) {
      issues.push(`${path}.properties requires object type`);
    }
    if (isObjectSchema) {
      if (!isObject(value.properties)) {
        issues.push(`${path}.properties must be an object`);
      }
      const properties = isObject(value.properties) ? value.properties : {};
      const propertyNames = Object.keys(properties).sort();
      const required = Array.isArray(value.required)
        ? value.required
            .filter((item): item is string => typeof item === "string")
            .sort()
        : [];

      if (value.additionalProperties !== false) {
        issues.push(`${path} must set additionalProperties to false`);
      }
      if (
        !Array.isArray(value.required) ||
        value.required.some((item) => typeof item !== "string") ||
        new Set(required).size !== required.length
      ) {
        issues.push(`${path}.required must contain unique strings`);
      }
      if (
        propertyNames.length !== required.length ||
        propertyNames.some((name, index) => name !== required[index])
      ) {
        issues.push(`${path} must require every property`);
      }
      for (const [name, property] of Object.entries(properties)) {
        visit(property, `${path}.properties.${name}`);
      }
    }

    if (declaredTypes.includes("array")) {
      if (!("items" in value)) {
        issues.push(`${path}.items is required for arrays`);
      }
      visit(value.items, `${path}.items`);
    } else if ("items" in value) {
      issues.push(`${path}.items requires array type`);
    }

    if ("$defs" in value) {
      if (!isObject(value.$defs)) {
        issues.push(`${path}.$defs must be an object`);
      } else {
        for (const [name, definition] of Object.entries(value.$defs)) {
          visit(definition, `${path}.$defs.${name}`);
        }
      }
    }
  }

  if (schema.type !== "object") {
    issues.push("$.type must be object");
  }
  visit(schema, "$");
  return issues;
}

function hasValidNvidiaMessageOrder(
  messages: readonly ProviderMessage[],
): boolean {
  const conversational =
    messages[0]?.role === "system" ? messages.slice(1) : messages;
  return (
    conversational.length > 0 &&
    conversational.at(-1)?.role === "user" &&
    conversational.every(
      (message, index) =>
        message.role === (index % 2 === 0 ? "user" : "assistant"),
    )
  );
}

function calculatePricing(
  configuration: PricingConfiguration | undefined,
  usage: Usage,
): NodeExecution["pricing"] {
  if (!configuration) {
    return {
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      estimatedCost: null,
      snapshotDate: null,
    };
  }

  const cachedTokens = usage.cachedInputTokens ?? 0;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const canEstimate =
    inputTokens !== null &&
    outputTokens !== null &&
    (cachedTokens === 0 ||
      configuration.cachedInputPerMillionTokens !== null);
  const nonCachedTokens =
    inputTokens === null ? 0 : Math.max(0, inputTokens - cachedTokens);
  const estimatedCost = canEstimate
    ? (nonCachedTokens * configuration.inputPerMillionTokens +
        cachedTokens *
          (configuration.cachedInputPerMillionTokens ??
            configuration.inputPerMillionTokens) +
        outputTokens * configuration.outputPerMillionTokens) /
      1_000_000
    : null;

  return {
    currency: configuration.currency,
    inputPerMillionTokens: configuration.inputPerMillionTokens,
    outputPerMillionTokens: configuration.outputPerMillionTokens,
    estimatedCost,
    snapshotDate: configuration.snapshotDate,
  };
}

function normalizeUsage(body: JsonObject): Usage {
  const usage = isObject(body.usage) ? body.usage : {};
  const promptDetails = isObject(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};

  return {
    inputTokens:
      integerValue(usage.prompt_tokens) ?? integerValue(usage.input_tokens),
    outputTokens:
      integerValue(usage.completion_tokens) ?? integerValue(usage.output_tokens),
    totalTokens: integerValue(usage.total_tokens),
    cachedInputTokens: integerValue(promptDetails.cached_tokens),
    reasoningTokens:
      integerValue(completionDetails.reasoning_tokens) ??
      integerValue(usage.reasoning_tokens),
  };
}

function normalizeTiming(body: JsonObject): ProviderTiming {
  const usage = isObject(body.usage) ? body.usage : {};
  return {
    queueMs: milliseconds(usage.queue_time),
    promptMs: milliseconds(usage.prompt_time),
    completionMs: milliseconds(usage.completion_time),
    totalMs: milliseconds(usage.total_time),
  };
}

function createError(
  runtime: AdapterRuntime,
  input: {
    kind: z.infer<typeof RunErrorSchema>["kind"];
    nodeId: string;
    executionId: string | null;
    retryable: boolean;
    message: string;
    providerCode?: string | null;
    httpStatus?: number | null;
    occurredAt?: string;
  },
): z.infer<typeof RunErrorSchema> {
  return RunErrorSchema.parse({
    id: runtime.makeId("error"),
    kind: input.kind,
    message: input.message,
    nodeId: input.nodeId,
    executionId: input.executionId,
    retryable: input.retryable,
    occurredAt: input.occurredAt ?? runtime.now().toISOString(),
    details: {
      field: null,
      providerCode: input.providerCode ?? null,
      httpStatus: input.httpStatus ?? null,
    },
  });
}

function repairMessages(
  messages: readonly ProviderMessage[],
  invalidContent: string | null,
  issues: readonly string[],
  secret: string,
): ProviderMessage[] {
  const boundedContent =
    invalidContent?.replaceAll(secret, "[redacted]").slice(0, 12_000) ??
    "(no JSON content)";
  return [
    ...messages,
    {
      role: "assistant",
      content: boundedContent,
    },
    {
      role: "user",
      content: [
        "The prior response failed application validation.",
        `Validation issues: ${issues.join("; ").slice(0, 2_000)}`,
        "Return only one corrected JSON object matching the original schema.",
      ].join("\n"),
    },
  ];
}

function requestBody(
  provider: ProviderKind,
  configuration: ProviderConfiguration,
  request: StructuredGenerationRequest,
  messages: readonly ProviderMessage[],
): JsonObject {
  const common: JsonObject = {
    model: configuration.modelId,
    messages,
    temperature: request.settings.temperature,
    stream: false,
  };

  if (request.settings.topP !== null) {
    common.top_p = request.settings.topP;
  }
  if (request.settings.seed !== null) {
    common.seed = request.settings.seed;
  }

  if (provider === "groq") {
    common.max_completion_tokens = request.settings.maxOutputTokens;
    common.include_reasoning = false;
    common.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.schemaName,
        strict: true,
        schema: request.outputJsonSchema,
      },
    };
    return common;
  }

  common.max_tokens = request.settings.maxOutputTokens;
  if (provider === "featherless") {
    common.response_format = { type: "json_object" };
    const jsonInstruction = [
      "Return only one JSON object matching this schema.",
      JSON.stringify(request.outputJsonSchema),
      "Do not add markdown fences or explanatory text.",
    ].join("\n");
    common.messages = messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: `${message.content}\n\n${jsonInstruction}` }
        : message,
    );
    return common;
  }
  const supportsNvidiaReasoningControls =
    configuration.modelId.toLowerCase().includes("nemotron");
  if (supportsNvidiaReasoningControls) {
    if (request.settings.reasoningMode === "disabled") {
      common.reasoning_effort = "none";
    } else if (request.settings.reasoningMode === "enabled") {
      common.reasoning_effort = "high";
    }
    if (
      request.settings.reasoningMode !== "disabled" &&
      request.settings.reasoningBudgetTokens !== null
    ) {
      common.reasoning_budget = request.settings.reasoningBudgetTokens;
    }
  }
  const jsonInstruction = [
    "Return only one JSON object matching this schema.",
    JSON.stringify(request.outputJsonSchema),
    "Do not add markdown fences or explanatory text.",
  ].join("\n");
  common.messages = messages.map((message, index) =>
    index === messages.length - 1
      ? { ...message, content: `${message.content}\n\n${jsonInstruction}` }
      : message,
  );
  return common;
}

type ProviderEnvelopeErrorCode =
  | "invalid_provider_json"
  | "response_too_large"
  | "provider_request_id_mismatch";

type ParsedProviderBody =
  | Readonly<{ ok: true; body: JsonObject }>
  | Readonly<{
      ok: false;
      code: Exclude<
        ProviderEnvelopeErrorCode,
        "provider_request_id_mismatch"
      >;
    }>;

async function parseBody(
  response: Response,
  signal: AbortSignal,
): Promise<ParsedProviderBody> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    await response.body?.cancel();
    return { ok: false, code: "response_too_large" };
  }
  if (response.body === null) {
    return { ok: false, code: "invalid_provider_json" };
  }

  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      received += next.value.byteLength;
      if (received > maximumResponseBytes) {
        await reader.cancel();
        signal.removeEventListener("abort", onAbort);
        return { ok: false, code: "response_too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      throw signal.reason;
    }
    await reader.cancel().catch(() => {});
    return { ok: false, code: "invalid_provider_json" };
  }
  signal.removeEventListener("abort", onAbort);
  if (signal.aborted) {
    throw signal.reason;
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body: unknown = JSON.parse(text);
    return isObject(body)
      ? { ok: true, body }
      : { ok: false, code: "invalid_provider_json" };
  } catch {
    return { ok: false, code: "invalid_provider_json" };
  }
}

async function sleep(
  runtime: AdapterRuntime,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (runtime.sleep) {
    return runtime.sleep(milliseconds, signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function resolveNvidiaPending(
  initialResponse: Response,
  initialBody: JsonObject,
  configuration: ProviderConfiguration,
  runtime: AdapterRuntime,
  signal: AbortSignal,
): Promise<{
  response: Response;
  body: JsonObject;
  providerRequestId: string | null;
  envelopeError: ProviderEnvelopeErrorCode | null;
}> {
  let response = initialResponse;
  let body = initialBody;
  const initialRequestId =
    providerString(body.requestId, configuration.apiKey) ??
    providerString(body.request_id, configuration.apiKey);

  for (let poll = 0; response.status === 202 && poll < 8; poll += 1) {
    const requestId = initialRequestId;
    if (requestId === null) {
      return {
        response,
        body,
        providerRequestId: initialRequestId,
        envelopeError: "invalid_provider_json",
      };
    }
    await sleep(runtime, 250, signal);
    response = await runtime.transport(
      `https://integrate.api.nvidia.com/v1/status/${encodeURIComponent(requestId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${configuration.apiKey}`,
          accept: "application/json",
        },
        signal,
      },
    );
    const parsed = await parseBody(response, signal);
    if (!parsed.ok) {
      return {
        response,
        body: {},
        providerRequestId: initialRequestId,
        envelopeError: parsed.code,
      };
    }
    body = parsed.body;
    const returnedPollRequestId =
      providerString(body.requestId, configuration.apiKey) ??
      providerString(body.request_id, configuration.apiKey);
    if (
      returnedPollRequestId !== null &&
      returnedPollRequestId !== initialRequestId
    ) {
      return {
        response,
        body,
        providerRequestId: initialRequestId,
        envelopeError: "provider_request_id_mismatch",
      };
    }
  }

  return {
    response,
    body,
    providerRequestId: initialRequestId,
    envelopeError: null,
  };
}

function providerRequestId(
  provider: ProviderKind,
  body: JsonObject,
  response: Response,
  secret: string,
): string | null {
  if (provider === "groq") {
    const groq = isObject(body.x_groq) ? body.x_groq : {};
    return (
      providerString(groq.id, secret) ??
      providerString(response.headers.get("x-request-id"), secret)
    );
  }
  return (
    providerString(body.requestId, secret) ??
    providerString(body.request_id, secret) ??
    providerString(response.headers.get("x-request-id"), secret)
  );
}

function retryAfterMilliseconds(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (raw === null) {
    return 0;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(
      MAXIMUM_PROVIDER_RETRY_BACKOFF_MS,
      Math.ceil(seconds * 1_000),
    );
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > Date.now()
    ? MAXIMUM_PROVIDER_RETRY_BACKOFF_MS
    : 0;
}

function baseExecution(
  provider: ProviderKind,
  configuration: ProviderConfiguration,
  request: StructuredGenerationRequest,
  input: {
    id: string;
    startedAt: string;
    endedAt: string;
    latencyMs: number;
    attempt: number;
    retryOfExecutionId: string | null;
    returnedModelId: string | null;
    requestId: string | null;
    responseId: string | null;
    finishReason: string | null;
    usage: Usage;
    timing: ProviderTiming;
    status: NodeExecution["status"];
    validation: NodeExecution["validation"];
    errorIds: readonly string[];
    refusal: NodeExecution["refusal"];
    providerResponded: boolean;
  },
): NodeExecution {
  const modelMatches = input.returnedModelId === configuration.modelId;
  return NodeExecutionSchema.parse({
    id: input.id,
    nodeId: request.nodeId,
    attempt: input.attempt,
    status: input.status,
    evidenceMode: configuration.evidenceMode ?? "mocked",
    inputRefs: [...request.inputRefs],
    outputRefs: input.status === "succeeded" ? [...request.outputRefs] : [],
    requestedProvider: provider,
    returnedProvider: input.providerResponded ? provider : null,
    requestedModelId: configuration.modelId,
    returnedModelId: input.returnedModelId,
    requestedDeveloperFamily: configuration.developerFamily,
    returnedDeveloperFamily: modelMatches
      ? configuration.developerFamily
      : null,
    requestedBaseFamily: configuration.baseFamily,
    returnedBaseFamily: modelMatches ? configuration.baseFamily : null,
    returnedReasoningMode: "unknown",
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    promptHash: request.promptHash,
    structuredOutputSchemaVersion: request.schemaVersion,
    generationSettings: request.settings,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    clientLatencyMs: input.latencyMs,
    providerTiming: input.timing,
    requestIds: {
      clientRequestId: input.id,
      providerRequestId: input.requestId,
      responseId: input.responseId,
    },
    finishReason: input.finishReason,
    refusal: input.refusal,
    usage: input.usage,
    pricing: calculatePricing(configuration.pricing, input.usage),
    validation: input.validation,
    errorIds: [...input.errorIds],
    retryOfExecutionId: input.retryOfExecutionId,
    fallbackFromExecutionId: null,
    codeVersion: request.codeVersion,
  });
}

function createProviderAdapter(
  provider: ProviderKind,
  configuration: ProviderConfiguration,
  runtimeInput?: Partial<AdapterRuntime>,
): StructuredGenerationAdapter {
  const runtime = normalizeRuntime(runtimeInput);
  const endpoint =
    configuration.endpoint ??
    (provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : provider === "nvidia_nim"
        ? "https://integrate.api.nvidia.com/v1/chat/completions"
        : "https://api.featherless.ai/v1/chat/completions");

  return {
    identity: Object.freeze({
      provider,
      modelId: configuration.modelId,
      developerFamily: configuration.developerFamily,
      baseFamily: configuration.baseFamily,
    }),
    async generate<Schema extends z.ZodType>(
      request: StructuredGenerationRequest<Schema>,
    ): Promise<StructuredGenerationResult<Schema>> {
      if (
        !Number.isInteger(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        ![1, 2].includes(request.maximumAttempts) ||
        request.messages.length === 0 ||
        !configuration.apiKey.trim() ||
        !configuration.modelId.trim() ||
        !configuration.developerFamily.trim() ||
        !configuration.baseFamily.trim() ||
        (provider === "nvidia_nim" &&
          (!hasValidNvidiaMessageOrder(request.messages) ||
            configuration.pricing !== undefined ||
            (request.settings.reasoningMode === "disabled" &&
              request.settings.reasoningBudgetTokens !== null)))
      ) {
        return {
          ok: false,
          attempts: [],
          errors: [
            createError(runtime, {
              kind: "invalid_input",
              nodeId: request.nodeId,
              executionId: null,
              retryable: false,
              message: "provider request configuration is invalid",
            }),
          ],
        };
      }

      if (provider === "groq") {
        if (!groqStrictModels.has(configuration.modelId)) {
          return {
            ok: false,
            attempts: [],
            errors: [
              createError(runtime, {
                kind: "invalid_input",
                nodeId: request.nodeId,
                executionId: null,
                retryable: false,
                message:
                  "configured Groq model is not in the verified strict-schema allowlist",
              }),
            ],
          };
        }
        const issues = schemaIssues(request.outputJsonSchema);
        if (issues.length > 0) {
          return {
            ok: false,
            attempts: [],
            errors: [
              createError(runtime, {
                kind: "invalid_input",
                nodeId: request.nodeId,
                executionId: null,
                retryable: false,
                message:
                  "Groq strict structured output requires a closed, fully required JSON schema",
              }),
            ],
          };
        }
      }

      const backoffSignal = request.signal ?? new AbortController().signal;
      const attempts: NodeExecution[] = [];
      const errors: z.infer<typeof RunErrorSchema>[] = [];

      const performAttempt = async (
        messages: readonly ProviderMessage[],
        attempt: number,
        retryOfExecutionId: string | null,
        delayMs = 0,
      ): Promise<AttemptResult<Schema>> => {
        const executionId = runtime.makeId("execution");
        const startedAt = runtime.now().toISOString();
        const startedMs = runtime.monotonicNow();
        let response: Response;
        let body: JsonObject = {};
        let pendingRequestId: string | null = null;
        let providerResponded = false;
        let observedResponseId: string | null = null;
        let observedModelId: string | null = null;
        let envelopeError: ProviderEnvelopeErrorCode | null = null;
        let deadline: DeadlineSignal | null = null;
        let signal = backoffSignal;

        try {
          if (delayMs > 0) {
            await sleep(runtime, delayMs, backoffSignal);
          }
          deadline = createDeadlineSignal(request.timeoutMs, request.signal);
          signal = deadline.signal;
          response = await waitForTransport(
            runtime.transport(endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${configuration.apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify(
                requestBody(provider, configuration, request, messages),
              ),
              signal,
            }),
            signal,
          );
          providerResponded = true;
          const parsed = await parseBody(response, signal);
          if (parsed.ok) {
            body = parsed.body;
          } else {
            envelopeError = parsed.code;
          }
          observedResponseId = providerString(
            body.id,
            configuration.apiKey,
          );
          observedModelId = providerString(
            body.model,
            configuration.apiKey,
          );
          if (
            envelopeError === null &&
            provider === "nvidia_nim" &&
            response.status === 202
          ) {
            pendingRequestId =
              providerString(body.requestId, configuration.apiKey) ??
              providerString(body.request_id, configuration.apiKey);
            const pending = await resolveNvidiaPending(
              response,
              body,
              configuration,
              runtime,
              signal,
            );
            response = pending.response;
            body = pending.body;
            pendingRequestId = pending.providerRequestId;
            envelopeError = pending.envelopeError;
            observedResponseId =
              providerString(body.id, configuration.apiKey) ??
              observedResponseId;
            observedModelId =
              providerString(body.model, configuration.apiKey) ??
              observedModelId;
          }
        } catch (error) {
          const endedAt = runtime.now().toISOString();
          const timedOut = isAbort(error, signal);
          const failure = createError(runtime, {
            kind: timedOut ? "timeout" : "provider_failure",
            nodeId: request.nodeId,
            executionId,
            retryable: true,
            message: timedOut
              ? "provider request exceeded the client deadline"
              : "provider transport failed",
            occurredAt: endedAt,
          });
          const execution = baseExecution(
            provider,
            configuration,
            request,
            {
              id: executionId,
              startedAt,
              endedAt,
              latencyMs: Math.max(0, runtime.monotonicNow() - startedMs),
              attempt,
              retryOfExecutionId,
              returnedModelId: observedModelId,
              requestId: pendingRequestId,
              responseId: observedResponseId,
              finishReason: null,
              usage: emptyUsage,
              timing: emptyTiming,
              status: timedOut ? "timed_out" : "failed",
              validation: { valid: false, issues: [failure.message] },
              errorIds: [failure.id],
              refusal: { refused: false, reason: null },
              providerResponded,
            },
          );
          return {
            ok: false,
            execution,
            error: failure,
            repairable: false,
            invalidContent: null,
            retryAfterMs: 0,
          };
        } finally {
          deadline?.dispose();
        }

        const endedAt = runtime.now().toISOString();
        const responseId =
          providerString(body.id, configuration.apiKey) ??
          observedResponseId;
        const requestId =
          pendingRequestId ??
          providerRequestId(
            provider,
            body,
            response,
            configuration.apiKey,
          );
        const returnedModelId =
          providerString(body.model, configuration.apiKey) ??
          observedModelId;
        const choices = Array.isArray(body.choices) ? body.choices : [];
        const choice = isObject(choices[0]) ? choices[0] : {};
        const message = isObject(choice.message) ? choice.message : {};
        const finishReason =
          providerString(choice.finish_reason, configuration.apiKey) ??
          providerString(choice.stop_reason, configuration.apiKey);
        const refusalReason =
          (stringValue(message.refusal) !== null
            ? "provider returned an explicit refusal"
            : null) ??
          (finishReason === "content_filter"
            ? "provider indicated content filtering"
            : null);
        const usage = normalizeUsage(body);
        const timing = normalizeTiming(body);
        const latencyMs = Math.max(0, runtime.monotonicNow() - startedMs);

        if (envelopeError !== null) {
          const envelopeRetryable =
            envelopeError !== "provider_request_id_mismatch" &&
            (response.ok ||
              response.status === 429 ||
              (provider === "groq" && response.status === 498) ||
              response.status >= 500);
          const error = createError(runtime, {
            kind: "provider_failure",
            nodeId: request.nodeId,
            executionId,
            retryable: envelopeRetryable,
            message:
              envelopeError === "response_too_large"
                ? "provider response exceeded the byte limit"
                : envelopeError === "provider_request_id_mismatch"
                  ? "provider polling request identifier changed"
                : "provider returned an invalid JSON envelope",
            providerCode: envelopeError,
            httpStatus: response.status,
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: false,
            invalidContent: null,
            retryAfterMs: 0,
          };
        }

        if (!response.ok || response.status === 202) {
          const providerError = isObject(body.error) ? body.error : body;
          const providerCode =
            sanitizeProviderCode(providerError.code, configuration.apiKey) ??
            sanitizeProviderCode(providerError.type, configuration.apiKey) ??
            (response.status === 202 ? "pending_exhausted" : null);
          const retryable =
            response.status === 429 ||
            (provider === "groq" && response.status === 498) ||
            response.status >= 500 ||
            response.status === 202;
          const error = createError(runtime, {
            kind: "provider_failure",
            nodeId: request.nodeId,
            executionId,
            retryable,
            message: `provider returned HTTP ${response.status}`,
            providerCode,
            httpStatus: response.status,
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: false,
            invalidContent: null,
            retryAfterMs: retryAfterMilliseconds(response),
          };
        }

        if (refusalReason !== null) {
          const error = createError(runtime, {
            kind: "provider_refusal",
            nodeId: request.nodeId,
            executionId,
            retryable: false,
            message: "provider refused the structured generation request",
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "refused",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: true, reason: refusalReason },
                providerResponded: true,
              },
            ),
            error,
            repairable: false,
            invalidContent: null,
          };
        }

        if (returnedModelId !== configuration.modelId) {
          const error = createError(runtime, {
            kind: "provider_failure",
            nodeId: request.nodeId,
            executionId,
            retryable: false,
            message: "provider returned an unexpected model identifier",
            providerCode: "returned_model_mismatch",
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: false,
            invalidContent: null,
          };
        }

        const content = stringValue(message.content);
        let parsed: unknown;
        try {
          parsed = content === null ? undefined : JSON.parse(content);
        } catch {
          const error = createError(runtime, {
            kind: "invalid_model_json",
            nodeId: request.nodeId,
            executionId,
            retryable: true,
            message: "provider response was not valid JSON",
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: true,
            invalidContent: content,
          };
        }

        if (containsSecret(parsed, configuration.apiKey)) {
          const error = createError(runtime, {
            kind: "invalid_model_output",
            nodeId: request.nodeId,
            executionId,
            retryable: false,
            message: "provider output contained redacted credential material",
            providerCode: "secret_in_provider_output",
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues: [error.message] },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: false,
            invalidContent: null,
          };
        }

        const validated = request.outputSchema.safeParse(parsed);
        if (!validated.success) {
          const issues = validated.error.issues.map(
            (issue) => `${issue.path.join(".") || "$"}: ${issue.code}`,
          );
          const error = createError(runtime, {
            kind: "invalid_model_output",
            nodeId: request.nodeId,
            executionId,
            retryable: true,
            message: "provider JSON failed application schema validation",
            occurredAt: endedAt,
          });
          return {
            ok: false,
            execution: baseExecution(
              provider,
              configuration,
              request,
              {
                id: executionId,
                startedAt,
                endedAt,
                latencyMs,
                attempt,
                retryOfExecutionId,
                returnedModelId,
                requestId,
                responseId,
                finishReason,
                usage,
                timing,
                status: "failed",
                validation: { valid: false, issues },
                errorIds: [error.id],
                refusal: { refused: false, reason: null },
                providerResponded: true,
              },
            ),
            error,
            repairable: true,
            invalidContent: content,
          };
        }

        return {
          ok: true,
          value: validated.data,
          execution: baseExecution(
            provider,
            configuration,
            request,
            {
              id: executionId,
              startedAt,
              endedAt,
              latencyMs,
              attempt,
              retryOfExecutionId,
              returnedModelId,
              requestId,
              responseId,
              finishReason,
              usage,
              timing,
              status: "succeeded",
              validation: { valid: true, issues: [] },
              errorIds: [],
              refusal: { refused: false, reason: null },
              providerResponded: true,
            },
          ),
        };
      };

      let current = await performAttempt(request.messages, 1, null);
      attempts.push(current.execution);
      if (!current.ok) {
        errors.push(current.error);
      }

      if (
        !current.ok &&
        current.error.kind === "provider_failure" &&
        current.error.retryable &&
        attempts.length < request.maximumAttempts &&
        !request.signal?.aborted
      ) {
        current = await performAttempt(
          request.messages,
          attempts.length + 1,
          current.execution.id,
          current.retryAfterMs ?? 0,
        );
        attempts.push(current.execution);
        if (!current.ok) {
          errors.push(current.error);
        }
      }

      if (current.ok) {
        return { ok: true, value: current.value, attempts, errors };
      }

      if (
        !current.repairable ||
        !request.repairInvalidOutput ||
        attempts.length >= request.maximumAttempts ||
        request.signal?.aborted
      ) {
        return { ok: false, attempts, errors };
      }

      const repaired = await performAttempt(
        repairMessages(
          request.messages,
          current.invalidContent,
          current.execution.validation.issues,
          configuration.apiKey,
        ),
        attempts.length + 1,
        current.execution.id,
      );
      attempts.push(repaired.execution);
      if (repaired.ok) {
        return { ok: true, value: repaired.value, attempts, errors };
      }
      errors.push(repaired.error);
      return { ok: false, attempts, errors };
    },
  };
}

export function createGroqAdapter(
  configuration: ProviderConfiguration,
  runtime?: Partial<AdapterRuntime>,
): StructuredGenerationAdapter {
  return createProviderAdapter("groq", configuration, runtime);
}

export function createNvidiaAdapter(
  configuration: ProviderConfiguration,
  runtime?: Partial<AdapterRuntime>,
): StructuredGenerationAdapter {
  return createProviderAdapter("nvidia_nim", configuration, runtime);
}

export function createFeatherlessAdapter(
  configuration: ProviderConfiguration,
  runtime?: Partial<AdapterRuntime>,
): StructuredGenerationAdapter {
  return createProviderAdapter("featherless", configuration, runtime);
}

export function createFixtureAdapter(
  configuration: FixtureConfiguration,
): StructuredGenerationAdapter {
  return {
    identity: Object.freeze({
      provider: "fixture" as const,
      modelId: configuration.modelId,
      developerFamily: configuration.developerFamily,
      baseFamily: configuration.baseFamily,
    }),
    async generate<Schema extends z.ZodType>(
      request: StructuredGenerationRequest<Schema>,
    ): Promise<StructuredGenerationResult<Schema>> {
      const fixtureKey = request.fixtureKey ?? "";
      const parsed = request.outputSchema.safeParse(
        structuredClone(configuration.fixtures[fixtureKey]),
      );
      const timestamp = "1970-01-01T00:00:00.000Z";
      const executionId = `fixture-${request.nodeId}-${fixtureKey}-execution`;
      const error = parsed.success
        ? null
        : RunErrorSchema.parse({
            id: `fixture-${request.nodeId}-${fixtureKey}-error`,
            kind: "invalid_model_output",
            message: "fixture output failed application schema validation",
            nodeId: request.nodeId,
            executionId,
            retryable: false,
            occurredAt: timestamp,
            details: {
              field: null,
              providerCode: null,
              httpStatus: null,
            },
          });
      const execution = NodeExecutionSchema.parse({
        id: executionId,
        nodeId: request.nodeId,
        attempt: 1,
        status: parsed.success ? "succeeded" : "failed",
        evidenceMode: "fixture",
        inputRefs: [...request.inputRefs],
        outputRefs: parsed.success ? [...request.outputRefs] : [],
        requestedProvider: "fixture",
        returnedProvider: "fixture",
        requestedModelId: configuration.modelId,
        returnedModelId: configuration.modelId,
        requestedDeveloperFamily: configuration.developerFamily,
        returnedDeveloperFamily: configuration.developerFamily,
        requestedBaseFamily: configuration.baseFamily,
        returnedBaseFamily: configuration.baseFamily,
        returnedReasoningMode: "disabled",
        promptId: request.promptId,
        promptVersion: request.promptVersion,
        promptHash: request.promptHash,
        structuredOutputSchemaVersion: request.schemaVersion,
        generationSettings: request.settings,
        startedAt: timestamp,
        endedAt: timestamp,
        clientLatencyMs: 0,
        providerTiming: emptyTiming,
        requestIds: {
          clientRequestId: `fixture-${request.nodeId}-${fixtureKey}-request`,
          providerRequestId: null,
          responseId: `fixture-${request.nodeId}-${fixtureKey}-response`,
        },
        finishReason: "fixture",
        refusal: { refused: false, reason: null },
        usage: emptyUsage,
        pricing: {
          currency: "USD",
          inputPerMillionTokens: null,
          outputPerMillionTokens: null,
          estimatedCost: null,
          snapshotDate: null,
        },
        validation: {
          valid: parsed.success,
          issues: parsed.success
            ? []
            : parsed.error.issues.map(
                (issue) => `${issue.path.join(".") || "$"}: ${issue.code}`,
              ),
        },
        errorIds: error ? [error.id] : [],
        retryOfExecutionId: null,
        fallbackFromExecutionId: null,
        codeVersion: request.codeVersion,
      });

      return parsed.success
        ? { ok: true, value: parsed.data, attempts: [execution], errors: [] }
        : { ok: false, attempts: [execution], errors: [error!] };
    },
  };
}
