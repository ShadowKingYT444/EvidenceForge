import { z } from "zod";

export const providerIds = ["openai", "anthropic", "grok", "deepseek", "nim", "featherless"] as const;
export type ProviderId = (typeof providerIds)[number];

type ProviderConfig = {
  label: string;
  endpoint: string;
  protocol: "responses" | "anthropic" | "chat";
};

export const PROVIDER_CONFIG: Readonly<Record<ProviderId, ProviderConfig>> = {
  openai: { label: "OpenAI / Codex", endpoint: "https://api.openai.com/v1/responses", protocol: "responses" },
  anthropic: { label: "Anthropic Claude", endpoint: "https://api.anthropic.com/v1/messages", protocol: "anthropic" },
  grok: { label: "xAI Grok", endpoint: "https://api.x.ai/v1/chat/completions", protocol: "chat" },
  deepseek: { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", protocol: "chat" },
  nim: { label: "NVIDIA NIM", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", protocol: "chat" },
  featherless: { label: "Featherless", endpoint: "https://api.featherless.ai/v1/chat/completions", protocol: "chat" },
};

const providerSchema = z.enum(providerIds);
const modelSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const apiKeySchema = z.string().min(1).max(2048);
const inputSchema = z.object({
  provider: providerSchema,
  model: modelSchema,
  apiKey: apiKeySchema,
}).strict();

export type ConnectionInput = z.infer<typeof inputSchema>;
type ConnectionErrorCode = "invalid_request" | "provider_failure" | "timeout" | "invalid_response" | "rate_limited";
export type ConnectionCategory = "success" | "configuration" | "http_4xx" | "http_5xx" | "rate_limited" | "timeout" | "invalid_response" | "network_error";
export type ConnectionResult =
  | { ok: true; provider: ProviderId; model: string; latencyMs: number; category: "success"; evidenceMode: "live" }
  | { ok: false; error: { code: ConnectionErrorCode; message: string; category: ConnectionCategory }; evidenceMode: "live" };

export function createConnectionRequest(value: unknown): ConnectionInput {
  return inputSchema.parse(value);
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;
type ConnectionDeps = {
  transport?: Transport;
  timeoutMs?: number;
  now?: () => number;
  rateKey?: string;
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024;
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();

export function resetConnectionRateLimitForTests(): void {
  rateBuckets.clear();
}

function sanitized(code: ConnectionErrorCode, message: string, category: ConnectionCategory): ConnectionResult {
  return { ok: false, error: { code, message, category }, evidenceMode: "live" };
}

function bodyFor(provider: ProviderId, model: string): Record<string, unknown> {
  if (provider === "openai") return { model, input: "Reply with one word: ok", max_output_tokens: 8, stream: false };
  if (provider === "anthropic") return { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with one word: ok" }], stream: false };
  return { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with one word: ok" }], stream: false };
}

function headersFor(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function hasExpectedShape(provider: ProviderId, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (provider === "openai") return Array.isArray(candidate.output) && candidate.output.length > 0;
  if (provider === "anthropic") return Array.isArray(candidate.content) && candidate.content.length > 0;
  return Array.isArray(candidate.choices) && candidate.choices.length > 0;
}

async function readBoundedBody(response: Response): Promise<{ body: string; tooLarge: boolean }> {
  if (!response.body) {
    const body = await response.text();
    return { body, tooLarge: new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { body: "", tooLarge: true };
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { body: chunks.join(""), tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

export async function verifyProviderConnection(
  value: unknown,
  deps: ConnectionDeps = {},
): Promise<ConnectionResult> {
  let request: ConnectionInput;
  try {
    request = createConnectionRequest(value);
  } catch {
    return sanitized("invalid_request", "Check the provider, model ID, and API key.", "configuration");
  }

  const now = deps.now ?? Date.now;
  const rateKey = deps.rateKey ?? "process";
  const current = now();
  const bucket = rateBuckets.get(rateKey);
  if (bucket && current - bucket.startedAt < RATE_WINDOW_MS && bucket.count >= RATE_LIMIT) {
    return sanitized("rate_limited", "Too many connection checks. Try again shortly.", "rate_limited");
  }
  if (!bucket || current - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.set(rateKey, { startedAt: current, count: 1 });
  else bucket.count += 1;

  const config = PROVIDER_CONFIG[request.provider];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 12_000);
  const started = now();
  try {
    const transport = deps.transport ?? fetch;
    const response = await transport(config.endpoint, {
      method: "POST",
      headers: headersFor(request.provider, request.apiKey),
      body: JSON.stringify(bodyFor(request.provider, request.model)),
      signal: controller.signal,
    });
    const length = response.headers.get("content-length");
    if (length && Number(length) > MAX_BODY_BYTES) return sanitized("invalid_response", "The provider response was too large.", "invalid_response");
    const bounded = await readBoundedBody(response);
    if (bounded.tooLarge) return sanitized("invalid_response", "The provider response was too large.", "invalid_response");
    const body = bounded.body;
    if (!response.ok) return response.status === 429
      ? sanitized("rate_limited", "The provider rate limited this connection.", "rate_limited")
      : sanitized("provider_failure", "The provider rejected this connection.", response.status >= 500 ? "http_5xx" : "http_4xx");
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!hasExpectedShape(request.provider, parsed)) return sanitized("invalid_response", "The provider returned an invalid response.", "invalid_response");
    } catch {
      return sanitized("invalid_response", "The provider returned an invalid response.", "invalid_response");
    }
    return { ok: true, provider: request.provider, model: request.model, latencyMs: Math.max(0, now() - started), category: "success", evidenceMode: "live" };
  } catch (error) {
    if (isAbort(error)) return sanitized("timeout", "The provider did not respond in time.", "timeout");
    return sanitized("provider_failure", "The provider connection could not be completed.", "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

export const connectionLimits = { MAX_BODY_BYTES, MAX_REQUEST_BYTES } as const;
