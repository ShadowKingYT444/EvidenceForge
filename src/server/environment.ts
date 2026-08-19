import { z } from "zod";

const providerSchema = z.enum(["featherless", "groq", "nvidia_nim"]);
const evidenceModeSchema = z.enum(["fixture", "live"]);
const liveEnvironmentSchema = z.object({
  PRIMARY_PROVIDER: providerSchema,
  PRIMARY_MODEL: z.string().trim().min(1),
  REVIEW_PROVIDER: providerSchema,
  REVIEW_MODEL: z.string().trim().min(1),
  FEATHERLESS_API_KEY: z.string().trim().optional(),
  GROQ_API_KEY: z.string().trim().optional(),
  NVIDIA_API_KEY: z.string().trim().optional(),
}).superRefine((value, context) => {
  const keyByProvider = {
    featherless: "FEATHERLESS_API_KEY",
    groq: "GROQ_API_KEY",
    nvidia_nim: "NVIDIA_API_KEY",
  } as const;
  for (const provider of [value.PRIMARY_PROVIDER, value.REVIEW_PROVIDER]) {
    const key = keyByProvider[provider];
    if (!value[key]) context.addIssue({ code: "custom", path: [key], message: "provider key is required" });
  }
  const validModel = (provider: z.infer<typeof providerSchema>, model: string, role: "primary" | "reviewer") =>
    provider === "groq"
      ? ["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model)
      : provider === "nvidia_nim"
        ? model === "meta/llama-3.1-8b-instruct"
        : role === "primary"
          ? model === "mistralai/Mistral-Large-Instruct-2411"
          : model === "Qwen/Qwen2.5-72B-Instruct";
  if (!validModel(value.PRIMARY_PROVIDER, value.PRIMARY_MODEL, "primary")) {
    context.addIssue({ code: "custom", path: ["PRIMARY_MODEL"], message: "model is not in the verified allowlist" });
  }
  if (!validModel(value.REVIEW_PROVIDER, value.REVIEW_MODEL, "reviewer")) {
    context.addIssue({ code: "custom", path: ["REVIEW_MODEL"], message: "model is not in the verified allowlist" });
  }
});

const liveEnvironmentKeys = [
  "PRIMARY_PROVIDER", "PRIMARY_MODEL", "REVIEW_PROVIDER", "REVIEW_MODEL",
  "FEATHERLESS_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY",
] as const;
type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type LiveProvider = z.infer<typeof providerSchema>;

export type RuntimeEnvironment =
  | { evidenceMode: "fixture" }
  | {
      evidenceMode: "live";
      primary: { provider: LiveProvider; model: string; apiKey: string };
      reviewer: { provider: LiveProvider; model: string; apiKey: string };
    };

export class EnvironmentValidationError extends Error {
  readonly fields: readonly string[];
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

export function readRuntimeEnvironment(source: EnvironmentSource = process.env): RuntimeEnvironment {
  const mode = evidenceModeSchema.safeParse(normalize(source.EVIDENCE_MODE) ?? "fixture");
  if (!mode.success) throw new EnvironmentValidationError(["EVIDENCE_MODE"]);
  if (mode.data === "fixture") return { evidenceMode: "fixture" };

  const live = liveEnvironmentSchema.safeParse(
    Object.fromEntries(liveEnvironmentKeys.map((key) => [key, normalize(source[key])])),
  );
  if (!live.success) {
    throw new EnvironmentValidationError(
      [...new Set(live.error.issues.map((issue) => String(issue.path[0])))],
    );
  }
  const keyFor = (provider: LiveProvider) =>
    provider === "groq"
      ? live.data.GROQ_API_KEY!
      : provider === "nvidia_nim"
        ? live.data.NVIDIA_API_KEY!
        : live.data.FEATHERLESS_API_KEY!;
  return {
    evidenceMode: "live",
    primary: {
      provider: live.data.PRIMARY_PROVIDER,
      model: live.data.PRIMARY_MODEL,
      apiKey: keyFor(live.data.PRIMARY_PROVIDER),
    },
    reviewer: {
      provider: live.data.REVIEW_PROVIDER,
      model: live.data.REVIEW_MODEL,
      apiKey: keyFor(live.data.REVIEW_PROVIDER),
    },
  };
}
