import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
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
        "FEATHERLESS_API_KEY",
      ]),
    );
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
});
