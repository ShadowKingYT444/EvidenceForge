import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  evaluateLiveReadiness,
  readRuntimeEnvironment,
} from "../../src/server/environment";

describe("readRuntimeEnvironment", () => {
  it("defaults to deterministic fixture mode with no environment variables", () => {
    expect(readRuntimeEnvironment({})).toEqual({
      evidenceMode: "fixture",
    });
  });

  it("treats blank live credentials as harmless in explicit fixture mode", () => {
    expect(
      readRuntimeEnvironment({
        EVIDENCE_MODE: "fixture",
        FEATHERLESS_API_KEY: "",
      }),
    ).toEqual({
      evidenceMode: "fixture",
    });
  });

  it("requires every server-only provider setting in live mode", () => {
    expect(() =>
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
      }),
    ).toThrowError(
      new EnvironmentValidationError([
        "PRIMARY_PROVIDER",
        "PRIMARY_MODEL",
        "REVIEW_PROVIDER",
        "REVIEW_MODEL",
        "OPENALEX_API_KEY",
      ]),
    );
  });

  it("accepts the verified Groq primary and NVIDIA reviewer pairing", () => {
    expect(
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
        PRIMARY_PROVIDER: "groq",
        PRIMARY_MODEL: "openai/gpt-oss-120b",
        GROQ_API_KEY: "test-only-groq-key",
        REVIEW_PROVIDER: "nvidia_nim",
        REVIEW_MODEL: "meta/llama-3.1-8b-instruct",
        NVIDIA_API_KEY: "test-only-nvidia-key",
        OPENALEX_API_KEY: "test-only-openalex-key",
      }),
    ).toEqual({
      evidenceMode: "live",
      primary: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        apiKey: "test-only-groq-key",
      },
      reviewer: {
        provider: "nvidia_nim",
        model: "meta/llama-3.1-8b-instruct",
        apiKey: "test-only-nvidia-key",
      },
    });
  });

  it("returns a validated live configuration without changing model IDs", () => {
    expect(
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
        PRIMARY_PROVIDER: "featherless",
        PRIMARY_MODEL: "mistralai/Mistral-Large-Instruct-2411",
        REVIEW_PROVIDER: "featherless",
        REVIEW_MODEL: "Qwen/Qwen2.5-72B-Instruct",
        FEATHERLESS_API_KEY: "test-only-featherless-key",
        OPENALEX_API_KEY: "test-only-openalex-key",
      }),
    ).toEqual({
      evidenceMode: "live",
      primary: {
        provider: "featherless",
        model: "mistralai/Mistral-Large-Instruct-2411",
        apiKey: "test-only-featherless-key",
      },
      reviewer: {
        provider: "featherless",
        model: "Qwen/Qwen2.5-72B-Instruct",
        apiKey: "test-only-featherless-key",
      },
    });
  });

  it("rejects the retired Qwen primary without exposing the supplied value", () => {
    const retired = "Qwen/Qwen3.5-397B-A17B";
    try {
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
        PRIMARY_PROVIDER: "featherless",
        PRIMARY_MODEL: retired,
        REVIEW_PROVIDER: "featherless",
        REVIEW_MODEL: "Qwen/Qwen2.5-72B-Instruct",
        FEATHERLESS_API_KEY: "test-only-featherless-key",
        OPENALEX_API_KEY: "test-only-openalex-key",
      });
      throw new Error("expected retired primary model rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(error).toMatchObject({ fields: ["PRIMARY_MODEL"] });
      expect(String(error)).not.toContain(retired);
    }
  });

  it("never includes secret values in validation errors", () => {
    const secret = "must-not-appear-in-errors";

    expect(() =>
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
        PRIMARY_PROVIDER: secret,
        PRIMARY_MODEL: secret,
        REVIEW_PROVIDER: secret,
        REVIEW_MODEL: secret,
        FEATHERLESS_API_KEY: secret,
      }),
    ).toThrowError(EnvironmentValidationError);

    try {
      readRuntimeEnvironment({
        EVIDENCE_MODE: "live",
        PRIMARY_PROVIDER: secret,
        PRIMARY_MODEL: secret,
        REVIEW_PROVIDER: secret,
        REVIEW_MODEL: secret,
        FEATHERLESS_API_KEY: secret,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("reports safe, actionable live readiness without secret material", () => {
    const secret = "never-return-this-secret";
    const readiness = evaluateLiveReadiness({
      EVIDENCE_MODE: "live",
      PRIMARY_PROVIDER: "groq",
      PRIMARY_MODEL: "openai/gpt-oss-120b",
      GROQ_API_KEY: secret,
      REVIEW_PROVIDER: "nvidia_nim",
      REVIEW_MODEL: "meta/llama-3.1-8b-instruct",
      NVIDIA_API_KEY: secret,
      RUN_CACHE_TTL_MINUTES: "45",
    });
    expect(readiness).toMatchObject({
      ready: false,
      liveInvestigationsReady: false,
      reasons: ["openalex_key_missing"],
      cache: { scope: "process_local", ttlMinutes: 45, survivesRestart: false },
      primary: { provider: "groq", model: "openai/gpt-oss-120b", configured: true, allowed: true },
    });
    expect(JSON.stringify(readiness)).not.toContain(secret);
  });

  it("requires a production run secret on every hosting vendor", () => {
    expect(evaluateLiveReadiness({ NODE_ENV: "production", EVIDENCE_MODE: "fixture" }).reasons)
      .toContain("run_token_secret_missing");
  });
});
