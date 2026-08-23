import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const raw = match[2].trim();
    process.env[match[1]] = raw.length >= 2 && raw[0] === raw.at(-1) && (raw[0] === '"' || raw[0] === "'")
      ? raw.slice(1, -1)
      : raw;
  }
}

const providers = {
  featherless: "https://api.featherless.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  nvidia_nim: "https://integrate.api.nvidia.com/v1/chat/completions",
};
const keys = { featherless: "FEATHERLESS_API_KEY", groq: "GROQ_API_KEY", nvidia_nim: "NVIDIA_API_KEY" };
const allowed = {
  primary: { featherless: ["mistralai/Mistral-Large-Instruct-2411"], groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"], nvidia_nim: ["meta/llama-3.1-8b-instruct"] },
  reviewer: { featherless: ["Qwen/Qwen2.5-72B-Instruct"], groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"], nvidia_nim: ["meta/llama-3.1-8b-instruct"] },
};

function classify(status) {
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return status >= 200 && status < 300 ? "ok" : "http_error";
}

async function boundedCheck(target, provider, model, url, init) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const code = classify(response.status);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 64 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      return { target, provider, model, category: "invalid_response", latencyMs: Date.now() - startedAt, code: "invalid_response", ok: false };
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) {
      return { target, provider, model, category: "invalid_response", latencyMs: Date.now() - startedAt, code: "invalid_response", ok: false };
    }
    let expectedShape = false;
    try {
      const parsed = JSON.parse(body);
      expectedShape = target === "openalex"
        ? Array.isArray(parsed?.results)
        : Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    } catch {
      expectedShape = false;
    }
    const ok = code === "ok" && expectedShape;
    return { target, provider, model, category: ok ? "success" : code === "ok" ? "invalid_response" : `http_${Math.floor(response.status / 100)}xx`, latencyMs: Date.now() - startedAt, code: ok ? "ok" : code === "ok" ? "invalid_response" : code, ok };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return { target, provider, model, category: timedOut ? "timeout" : "network_error", latencyMs: Date.now() - startedAt, code: timedOut ? "timeout" : "network_error", ok: false };
  } finally { clearTimeout(timeout); }
}

function configurationFailure(target, provider = "unconfigured", model = null) {
  return { target, provider, model, category: "configuration", latencyMs: 0, code: "configuration_invalid", ok: false };
}

const mode = process.env.EVIDENCE_MODE?.trim() || "fixture";
const primaryProvider = process.env.PRIMARY_PROVIDER?.trim();
const primaryModel = process.env.PRIMARY_MODEL?.trim();
const reviewerProvider = process.env.REVIEW_PROVIDER?.trim();
const reviewerModel = process.env.REVIEW_MODEL?.trim();
const openAlexKey = process.env.OPENALEX_API_KEY?.trim();
const validRole = (role, provider, model) => provider && model && providers[provider] && allowed[role][provider]?.includes(model) && process.env[keys[provider]]?.trim();

let results;
if (mode !== "live") {
  results = [configurationFailure("openalex", "openalex"), configurationFailure("primary", "fixture"), configurationFailure("reviewer", "fixture")];
} else {
  const checks = [];
  if (!openAlexKey) checks.push(Promise.resolve(configurationFailure("openalex", "openalex")));
  else {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", "evidence"); url.searchParams.set("per-page", "1"); url.searchParams.set("api_key", openAlexKey);
    checks.push(boundedCheck("openalex", "openalex", null, url, { headers: { accept: "application/json" } }));
  }
  for (const [target, provider, model] of [["primary", primaryProvider, primaryModel], ["reviewer", reviewerProvider, reviewerModel]]) {
    if (!validRole(target, provider, model)) {
      const safeProvider = provider && providers[provider] ? provider : "unconfigured";
      const safeModel = safeProvider !== "unconfigured" && allowed[target][provider]?.includes(model) ? model : null;
      checks.push(Promise.resolve(configurationFailure(target, safeProvider, safeModel)));
    }
    else checks.push(boundedCheck(target, provider, model, providers[provider], { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env[keys[provider]].trim()}` }, body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Reply with one word: ok" }], stream: false }) }));
  }
  if (primaryProvider && reviewerProvider && primaryProvider === reviewerProvider) {
    checks.push(Promise.resolve(configurationFailure("topology", primaryProvider)));
  }
  results = await Promise.all(checks);
}

for (const result of results) console.log(JSON.stringify(result));
if (results.some((result) => !result.ok)) process.exitCode = 1;
