import { z } from "zod";

export const liveProviderSchema = z.enum(["featherless", "groq", "nvidia_nim"]);
const evidenceModeSchema = z.enum(["fixture", "live"]);

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
export type LiveProvider = z.infer<typeof liveProviderSchema>;
export type LiveReadinessReasonCode =
  | "evidence_mode_invalid"
  | "primary_provider_missing"
  | "primary_provider_invalid"
  | "primary_model_missing"
  | "primary_model_not_allowed"
  | "primary_key_missing"
  | "reviewer_provider_missing"
  | "reviewer_provider_invalid"
  | "reviewer_model_missing"
  | "reviewer_model_not_allowed"
  | "reviewer_key_missing"
  | "providers_not_independent"
  | "openalex_key_missing"
  | "run_token_secret_missing"
  | "cache_ttl_invalid";

export type LiveReadiness = {
  ready: boolean;
  liveInvestigationsReady: boolean;
  evidenceMode: "fixture" | "live" | "invalid";
  production: boolean;
  reasons: readonly LiveReadinessReasonCode[];
  primary: { provider: LiveProvider | null; model: string | null; configured: boolean; allowed: boolean };
  reviewer: { provider: LiveProvider | null; model: string | null; configured: boolean; allowed: boolean };
  openalex: { configured: boolean };
  cache: { scope: "process_local"; ttlMinutes: number; survivesRestart: false };
};

export type RuntimeEnvironment =
  | { evidenceMode: "fixture" }
  | {
      evidenceMode: "live";
      primary: { provider: LiveProvider; model: string; apiKey: string };
      reviewer: { provider: LiveProvider; model: string; apiKey: string };
    };

export class EnvironmentValidationError extends Error {
  readonly fields: readonly string[];
  readonly code = "runtime_configuration_invalid";
  constructor(fields: readonly string[]) {
    super(`Invalid or missing server environment: ${fields.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.fields = [...fields];
  }
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isAllowedLiveModel(provider: LiveProvider, model: string, role: "primary" | "reviewer"): boolean {
  if (provider === "groq") return ["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model);
  if (provider === "nvidia_nim") return model === "meta/llama-3.1-8b-instruct";
  return role === "primary"
    ? model === "mistralai/Mistral-Large-Instruct-2411"
    : model === "Qwen/Qwen2.5-72B-Instruct";
}

function keyName(provider: LiveProvider): "FEATHERLESS_API_KEY" | "GROQ_API_KEY" | "NVIDIA_API_KEY" {
  return provider === "groq" ? "GROQ_API_KEY" : provider === "nvidia_nim" ? "NVIDIA_API_KEY" : "FEATHERLESS_API_KEY";
}

function roleReadiness(source: EnvironmentSource, role: "primary" | "reviewer", live: boolean) {
  const upper = role === "primary" ? "PRIMARY" : "REVIEW";
  const rawProvider = normalize(source[`${upper}_PROVIDER`]);
  const parsedProvider = liveProviderSchema.safeParse(rawProvider ?? "featherless");
  const provider = parsedProvider.success ? parsedProvider.data : null;
  const rawModel = normalize(source[`${upper}_MODEL`]);
  const modelAllowed = Boolean(provider && rawModel && isAllowedLiveModel(provider, rawModel, role));
  const configured = Boolean(provider && normalize(source[keyName(provider)]));
  const reasons: LiveReadinessReasonCode[] = [];
  if (live) {
    if (!rawProvider) reasons.push(role === "primary" ? "primary_provider_missing" : "reviewer_provider_missing");
    else if (!provider) reasons.push(role === "primary" ? "primary_provider_invalid" : "reviewer_provider_invalid");
    if (!rawModel) reasons.push(role === "primary" ? "primary_model_missing" : "reviewer_model_missing");
    else if (!modelAllowed) reasons.push(role === "primary" ? "primary_model_not_allowed" : "reviewer_model_not_allowed");
    if (rawProvider && provider && !configured) reasons.push(role === "primary" ? "primary_key_missing" : "reviewer_key_missing");
  }
  return { safe: { provider, model: modelAllowed ? rawModel! : null, configured, allowed: modelAllowed }, reasons };
}

export function evaluateLiveReadiness(source: EnvironmentSource = process.env): LiveReadiness {
  const rawMode = normalize(source.EVIDENCE_MODE) ?? "fixture";
  const parsedMode = evidenceModeSchema.safeParse(rawMode);
  const evidenceMode = parsedMode.success ? parsedMode.data : "invalid";
  const live = evidenceMode === "live";
  const primary = roleReadiness(source, "primary", live);
  const reviewer = roleReadiness(source, "reviewer", live);
  const reasons: LiveReadinessReasonCode[] = [
    ...(parsedMode.success ? [] : ["evidence_mode_invalid" as const]),
    ...primary.reasons,
    ...reviewer.reasons,
  ];
  if (
    live &&
    primary.safe.allowed &&
    reviewer.safe.allowed &&
    primary.safe.provider !== null &&
    reviewer.safe.provider !== null &&
    primary.safe.provider === reviewer.safe.provider
  ) {
    reasons.push("providers_not_independent");
  }
  const openalexConfigured = Boolean(normalize(source.OPENALEX_API_KEY));
  if (live && !openalexConfigured) reasons.push("openalex_key_missing");
  const production = source.NODE_ENV === "production";
  if (production && !normalize(source.RUN_TOKEN_SECRET)) reasons.push("run_token_secret_missing");
  const rawTtl = normalize(source.RUN_CACHE_TTL_MINUTES);
  const parsedTtl = rawTtl === undefined ? 120 : Number(rawTtl);
  const ttlValid = Number.isFinite(parsedTtl) && parsedTtl >= 5;
  if (!ttlValid) reasons.push("cache_ttl_invalid");
  const ttlMinutes = ttlValid ? parsedTtl : 120;
  return {
    ready: reasons.length === 0,
    liveInvestigationsReady: live && reasons.length === 0,
    evidenceMode,
    production,
    reasons,
    primary: primary.safe,
    reviewer: reviewer.safe,
    openalex: { configured: openalexConfigured },
    cache: { scope: "process_local", ttlMinutes, survivesRestart: false },
  };
}

const fieldByReason: Record<LiveReadinessReasonCode, string> = {
  evidence_mode_invalid: "EVIDENCE_MODE",
  primary_provider_missing: "PRIMARY_PROVIDER",
  primary_provider_invalid: "PRIMARY_PROVIDER",
  primary_model_missing: "PRIMARY_MODEL",
  primary_model_not_allowed: "PRIMARY_MODEL",
  primary_key_missing: "PRIMARY_PROVIDER_API_KEY",
  reviewer_provider_missing: "REVIEW_PROVIDER",
  reviewer_provider_invalid: "REVIEW_PROVIDER",
  reviewer_model_missing: "REVIEW_MODEL",
  reviewer_model_not_allowed: "REVIEW_MODEL",
  reviewer_key_missing: "REVIEW_PROVIDER_API_KEY",
  providers_not_independent: "PRIMARY_PROVIDER/REVIEW_PROVIDER",
  openalex_key_missing: "OPENALEX_API_KEY",
  run_token_secret_missing: "RUN_TOKEN_SECRET",
  cache_ttl_invalid: "RUN_CACHE_TTL_MINUTES",
};

export function assertLiveWorkflowReady(source: EnvironmentSource = process.env): LiveReadiness {
  const readiness = evaluateLiveReadiness(source);
  if (!readiness.liveInvestigationsReady) {
    const fields = readiness.evidenceMode === "fixture"
      ? ["EVIDENCE_MODE"]
      : [...new Set(readiness.reasons.map((reason) => fieldByReason[reason]))];
    throw new EnvironmentValidationError(fields);
  }
  return readiness;
}

export function readRuntimeEnvironment(source: EnvironmentSource = process.env): RuntimeEnvironment {
  const readiness = evaluateLiveReadiness(source);
  if (readiness.evidenceMode === "fixture" && readiness.ready) return { evidenceMode: "fixture" };
  if (!readiness.liveInvestigationsReady) {
    throw new EnvironmentValidationError([...new Set(readiness.reasons.map((reason) => fieldByReason[reason]))]);
  }
  const primary = readiness.primary;
  const reviewer = readiness.reviewer;
  return {
    evidenceMode: "live",
    primary: { provider: primary.provider!, model: primary.model!, apiKey: normalize(source[keyName(primary.provider!)])! },
    reviewer: { provider: reviewer.provider!, model: reviewer.model!, apiKey: normalize(source[keyName(reviewer.provider!)])! },
  };
}
