import { z } from "zod";

const liveEnvironmentSchema = z.object({
  PRIMARY_PROVIDER: z.literal("featherless"),
  PRIMARY_MODEL: z.literal("mistralai/Mistral-Large-Instruct-2411"),
  REVIEW_PROVIDER: z.literal("featherless"),
  REVIEW_MODEL: z.literal("Qwen/Qwen2.5-72B-Instruct"),
  FEATHERLESS_API_KEY: z.string().trim().min(1),
});

const evidenceModeSchema = z.enum(["fixture", "live"]);

const liveEnvironmentKeys = [
  "PRIMARY_PROVIDER",
  "PRIMARY_MODEL",
  "REVIEW_PROVIDER",
  "REVIEW_MODEL",
  "FEATHERLESS_API_KEY",
] as const;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type RuntimeEnvironment =
  | {
      evidenceMode: "fixture";
    }
  | {
      evidenceMode: "live";
      primary: {
        provider: "featherless";
        model: "mistralai/Mistral-Large-Instruct-2411";
        apiKey: string;
      };
      reviewer: {
        provider: "featherless";
        model: "Qwen/Qwen2.5-72B-Instruct";
        apiKey: string;
      };
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

export function readRuntimeEnvironment(
  source: EnvironmentSource = process.env,
): RuntimeEnvironment {
  const rawMode = normalize(source.EVIDENCE_MODE) ?? "fixture";
  const mode = evidenceModeSchema.safeParse(rawMode);

  if (!mode.success) {
    throw new EnvironmentValidationError(["EVIDENCE_MODE"]);
  }

  if (mode.data === "fixture") {
    return {
      evidenceMode: "fixture",
    };
  }

  const liveInput = Object.fromEntries(
    liveEnvironmentKeys.map((key) => [key, normalize(source[key])]),
  );
  const live = liveEnvironmentSchema.safeParse(liveInput);

  if (!live.success) {
    const invalidFields = live.error.issues.map((issue) =>
      String(issue.path[0]),
    );
    throw new EnvironmentValidationError(invalidFields);
  }

  return {
    evidenceMode: "live",
    primary: {
      provider: live.data.PRIMARY_PROVIDER,
      model: live.data.PRIMARY_MODEL,
      apiKey: live.data.FEATHERLESS_API_KEY,
    },
    reviewer: {
      provider: live.data.REVIEW_PROVIDER,
      model: live.data.REVIEW_MODEL,
      apiKey: live.data.FEATHERLESS_API_KEY,
    },
  };
}
