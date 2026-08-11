import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { runReviewerProbeOperator } from "./operator-v1";

const roots: string[] = [];

function response(model: string, value: unknown) {
  return new Response(
    JSON.stringify({
      id: "sanitized-response-id",
      model,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(value), refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "sanitized-request-id",
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("bounded reviewer probe operator", () => {
  it("preflights first, stops after Qwen passes both, and persists no content", async () => {
    const fakeCredential = ["offline", "test", "credential"].join("-");
    const root = await mkdtemp(join(tmpdir(), "evf81-"));
    roots.push(root);
    const artifactRoot = join(
      process.cwd(),
      "artifacts",
      "submission",
      "reviewer-probes",
      root.split(/[\\/]/).at(-1)!,
    );
    roots.push(artifactRoot);
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v1/plan")) {
        return new Response(
          JSON.stringify({ id: "feather_pro_plus", max_context_length: 32768 }),
        );
      }
      if (url.includes("/v1/models?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "Qwen/Qwen2.5-72B-Instruct",
                available_on_current_plan: true,
                context_length: 32768,
                max_completion_tokens: 8192,
              },
              {
                id: "meta-llama/Llama-3.3-70B-Instruct",
                available_on_current_plan: true,
                context_length: 32768,
                max_completion_tokens: 8192,
              },
            ],
          }),
        );
      }
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
      return body.max_tokens === 256
        ? response(body.model, { status: "ok" })
        : response(body.model, { review: goldenRunV01.review });
    };

    const result = await runReviewerProbeOperator(
      {
        REVIEWER_PROBE_AUTHORIZED: "1",
        REVIEWER_PROBE_ZERO_PAID_SPEND: "1",
        REVIEWER_PROBE_FIXED_PLAN_CONFIRMED: "1",
        REVIEWER_PROBE_CODE_VERSION: "a".repeat(40),
        REVIEWER_PROBE_ARTIFACT_ROOT: artifactRoot,
        FEATHERLESS_API_KEY: fakeCredential,
      },
      fetchMock,
    );

    expect(result.selectedModelId).toBe("Qwen/Qwen2.5-72B-Instruct");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatch(/\/plan$/);
    expect(calls[1]).toContain("/models?");
    const persisted = await readFile(
      join(artifactRoot, "002-qwen2.5-72b-representative.json"),
      "utf8",
    );
    expect(persisted).not.toContain(fakeCredential);
    expect(persisted).not.toContain(goldenRunV01.experiment!.objective);
    const representativeArtifact = JSON.parse(persisted);
    expect(representativeArtifact).toMatchObject({
      probe: "representative_reviewer",
      result: {
        ok: true,
        jsonParseStatus: "valid",
        applicationSchemaStatus: "valid",
        pricing: {
          currency: "USD",
          inputPerMillionTokens: null,
          outputPerMillionTokens: null,
          estimatedCost: null,
          snapshotDate: null,
        },
      },
    });
    const smallArtifact = JSON.parse(
      await readFile(join(artifactRoot, "001-qwen2.5-72b-small.json"), "utf8"),
    );
    expect(smallArtifact.result.pricing).toEqual({
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      estimatedCost: null,
      snapshotDate: null,
    });

    const preflightArtifact = JSON.parse(
      await readFile(join(artifactRoot, "000-preflight.json"), "utf8"),
    );
    expect(preflightArtifact.strictZeroIncrementalSpend).toBe(true);
  });
});
