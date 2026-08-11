import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFeatherlessAdapter,
  createFixtureAdapter,
  type AdapterRuntime,
  type StructuredGenerationRequest,
} from "../../src/server/models";

const outputSchema = z
  .object({
    verdict: z.enum(["supported", "insufficient"]),
    rationale: z.string().min(1),
  })
  .strict();
const outputJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "insufficient"] },
    rationale: { type: "string" },
  },
  required: ["verdict", "rationale"],
  additionalProperties: false,
} as const;
const fakeCredential = "unit-test-featherless-credential";

afterEach(() => {
  vi.useRealTimers();
});

function request(
  overrides: Partial<StructuredGenerationRequest<typeof outputSchema>> = {},
): StructuredGenerationRequest<typeof outputSchema> {
  return {
    nodeId: "assess-entailment",
    inputRefs: ["input-1"],
    outputRefs: ["output-1"],
    promptId: "assess-entailment",
    promptVersion: "1.0.0",
    promptHash: "a".repeat(64),
    schemaVersion: "v0",
    schemaName: "assessment",
    outputSchema,
    outputJsonSchema,
    messages: [
      { role: "system", content: "Use only the supplied bounded packet." },
      { role: "user", content: "Assess claim C1." },
    ],
    settings: {
      temperature: 0,
      maxOutputTokens: 256,
      topP: null,
      seed: 7,
      reasoningMode: "disabled",
      reasoningBudgetTokens: null,
    },
    timeoutMs: 50,
    measured: true,
    repairInvalidOutput: true,
    maximumAttempts: 2,
    codeVersion: "test",
    ...overrides,
  };
}

function response(
  content: string | null,
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "response-1",
      model: "mistralai/Mistral-Large-Instruct-2411",
      choices: [{ finish_reason: "stop", message: { content, refusal: null } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-1" } },
  );
}

function runtime(transport: AdapterRuntime["transport"]): AdapterRuntime {
  let id = 0;
  let time = 0;
  return {
    transport,
    now: () => new Date(`2026-08-10T00:00:0${time++}.000Z`),
    monotonicNow: () => time++ * 10,
    makeId: (prefix) => `${prefix}-${++id}`,
    sleep: async () => {},
  };
}

function featherless(
  transport: AdapterRuntime["transport"],
  modelId = "mistralai/Mistral-Large-Instruct-2411",
) {
  const isMistral = modelId.startsWith("mistralai/");
  return createFeatherlessAdapter(
    {
      apiKey: fakeCredential,
      modelId,
      developerFamily: isMistral ? "mistralai" : "qwen",
      baseFamily: isMistral ? "mistral-large" : "qwen2.5",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 0.1,
        cachedInputPerMillionTokens: null,
        outputPerMillionTokens: 0.2,
        snapshotDate: "2026-08-10",
      },
    },
    runtime(transport),
  );
}

describe("Featherless provider adapter", () => {
  it("uses exact endpoint, Mistral identity, JSON mode, prompt schema, and supported fields only", async () => {
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(url).toBe("https://api.featherless.ai/v1/chat/completions");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${fakeCredential}`);
      expect(body).toMatchObject({
        model: "mistralai/Mistral-Large-Instruct-2411",
        max_tokens: 256,
        stream: false,
      });
      expect(body.messages.at(-1).content).toContain("Return only one JSON object");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.include_reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning_budget).toBeUndefined();
      return response('{"verdict":"supported","rationale":"Exact passage."}');
    });

    const result = await featherless(transport).generate(request());
    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toMatchObject({
      requestedProvider: "featherless",
      returnedProvider: "featherless",
      requestedModelId: "mistralai/Mistral-Large-Instruct-2411",
      returnedModelId: "mistralai/Mistral-Large-Instruct-2411",
      requestedDeveloperFamily: "mistralai",
      requestedBaseFamily: "mistral-large",
      requestIds: { providerRequestId: "request-1", responseId: "response-1" },
      finishReason: "stop",
      validation: { valid: true, issues: [] },
    });
  });

  it("uses the exact distinct Qwen reviewer identity and JSON-object body", async () => {
    const model = "Qwen/Qwen2.5-72B-Instruct";
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(url).toBe("https://api.featherless.ai/v1/chat/completions");
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(256);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.include_reasoning).toBeUndefined();
      return response(
        '{"verdict":"insufficient","rationale":"Missing outcome."}',
        { model },
      );
    });
    const result = await featherless(transport, model).generate(request());
    expect(result.attempts[0]).toMatchObject({
      requestedProvider: "featherless",
      requestedModelId: model,
      requestedDeveloperFamily: "qwen",
      requestedBaseFamily: "qwen2.5",
    });
  });

  it("accepts a slow response that completes inside the hard deadline", async () => {
    const transport = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                response(
                  '{"verdict":"supported","rationale":"Slow but bounded."}',
                ),
              ),
            20,
          );
        }),
    );

    const result = await featherless(transport).generate(
      request({ timeoutMs: 100, maximumAttempts: 1 }),
    );

    expect(result).toMatchObject({
      ok: true,
      attempts: [{ status: "succeeded" }],
      errors: [],
    });
  });

  it("repairs invalid JSON at most once and retains the failed attempt", async () => {
    const transport = vi
      .fn<AdapterRuntime["transport"]>()
      .mockResolvedValueOnce(response("not-json"))
      .mockResolvedValueOnce(response('{"verdict":"supported","rationale":"Repaired."}'));
    const result = await featherless(transport).generate(request());
    expect(result).toMatchObject({
      ok: true,
      attempts: [{ status: "failed" }, { status: "succeeded" }],
      errors: [{ kind: "invalid_model_json" }],
    });
    expect(result.attempts[1].retryOfExecutionId).toBe(result.attempts[0].id);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("gives a late invalid response and its repair independent hard deadlines", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const outputs = [
      '{"verdict":"unknown","rationale":"Invalid near deadline."}',
      '{"verdict":"supported","rationale":"Repair used a fresh deadline."}',
    ];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      const output = outputs.shift()!;
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(response(output)), 90);
      });
    });

    const pending = featherless(transport).generate(
      request({ timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(90);
    await vi.advanceTimersByTimeAsync(90);
    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      attempts: [{ status: "failed" }, { status: "succeeded" }],
      errors: [{ kind: "invalid_model_output" }],
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every(({ aborted }) => !aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out only the repair at its own deadline and disposes attempt resources", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const addExternalListener = vi.spyOn(
      external.signal,
      "addEventListener",
    );
    const removeExternalListener = vi.spyOn(
      external.signal,
      "removeEventListener",
    );
    const signals: AbortSignal[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                response(
                  '{"verdict":"unknown","rationale":"Late invalid response."}',
                ),
              ),
            90,
          );
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    const pending = featherless(transport).generate(
      request({ timeoutMs: 100, signal: external.signal }),
    );
    await vi.advanceTimersByTimeAsync(90);
    await vi.advanceTimersByTimeAsync(99);
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      attempts: [
        { attempt: 1, status: "failed", fallbackFromExecutionId: null },
        { attempt: 2, status: "timed_out", fallbackFromExecutionId: null },
      ],
      errors: [
        { kind: "invalid_model_output" },
        { kind: "timeout" },
      ],
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(true);
    expect(addExternalListener).toHaveBeenCalledTimes(2);
    expect(removeExternalListener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates an active repair immediately on an actual external abort and consumes its late rejection", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const addExternalListener = vi.spyOn(
      external.signal,
      "addEventListener",
    );
    const removeExternalListener = vi.spyOn(
      external.signal,
      "removeEventListener",
    );
    const signals: AbortSignal[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      if (signals.length === 1) {
        return response(
          '{"verdict":"unknown","rationale":"Start one repair."}',
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("late transport rejection after abort")),
          50,
        );
      });
    });

    const pending = featherless(transport).generate(
      request({ timeoutMs: 100, signal: external.signal }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signals[1]!.aborted).toBe(false);

    external.abort(new DOMException("caller cancelled", "AbortError"));
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      attempts: [
        { attempt: 1, status: "failed", fallbackFromExecutionId: null },
        { attempt: 2, status: "timed_out", fallbackFromExecutionId: null },
      ],
      errors: [
        { kind: "invalid_model_output" },
        { kind: "timeout" },
      ],
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(result.attempts.filter(({ status }) => status === "timed_out")).toHaveLength(1);
    expect(result.errors.filter(({ kind }) => kind === "timeout")).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(true);
    expect(addExternalListener).toHaveBeenCalledTimes(2);
    expect(removeExternalListener).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([429, 503])("bounds retry for HTTP %s", async (status) => {
    const transport = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "temporary" } }), { status }),
    );
    const result = await featherless(transport).generate(request());
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every(({ kind, retryable }) => kind === "provider_failure" && retryable)).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("gives a late retryable response and its provider retry independent hard deadlines", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      const attempt = signals.length;
      return new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              attempt === 1
                ? new Response(
                    JSON.stringify({ error: { type: "temporary" } }),
                    { status: 503 },
                  )
                : response(
                    '{"verdict":"supported","rationale":"Retry used a fresh deadline."}',
                  ),
            ),
          90,
        );
      });
    });

    const pending = featherless(transport).generate(
      request({ timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(90);
    await vi.advanceTimersByTimeAsync(90);
    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      attempts: [{ status: "failed" }, { status: "succeeded" }],
      errors: [{ kind: "provider_failure", retryable: true }],
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every(({ aborted }) => !aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records an explicit timeout without repair or fallback", async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );
    const result = await featherless(transport).generate(request({ timeoutMs: 5 }));
    expect(result).toMatchObject({
      ok: false,
      attempts: [{ status: "timed_out", fallbackFromExecutionId: null }],
      errors: [{ kind: "timeout" }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("hard-times out a transport that ignores abort without a duplicate attempt", async () => {
    const transport = vi.fn(
      async (): Promise<Response> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("late transport rejection")), 20);
        }),
    );

    const result = await featherless(transport).generate(
      request({ timeoutMs: 5 }),
    );

    expect(result).toMatchObject({
      ok: false,
      attempts: [{ attempt: 1, status: "timed_out" }],
      errors: [{ kind: "timeout" }],
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("consumes response-body cancellation rejection after timeout", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () =>
        Promise.reject(new DOMException("cancelled by deadline", "TimeoutError")),
    });
    const transport = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await featherless(transport).generate(
      request({ timeoutMs: 5 }),
    );

    expect(result).toMatchObject({
      ok: false,
      attempts: [{ attempt: 1, status: "timed_out" }],
      errors: [{ kind: "timeout" }],
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it("retains refusal and returned-model mismatch as typed terminal failures", async () => {
    const refusal = await featherless(async () =>
      response(null, {
        choices: [{ finish_reason: "content_filter", message: { content: null, refusal: "Policy." } }],
      }),
    ).generate(request());
    const mismatch = await featherless(async () =>
      response('{"verdict":"supported","rationale":"Text."}', { model: "other/model" }),
    ).generate(request());
    expect(refusal).toMatchObject({ ok: false, attempts: [{ status: "refused" }], errors: [{ kind: "provider_refusal" }] });
    expect(mismatch).toMatchObject({ ok: false, errors: [{ kind: "provider_failure", details: { providerCode: "returned_model_mismatch" } }] });
  });

  it("rejects oversized and secret-bearing responses without leaking the key", async () => {
    const oversized = await featherless(async () =>
      new Response("{}", { status: 200, headers: { "content-length": "5000000" } }),
    ).generate(request({ maximumAttempts: 1 }));
    const secret = await featherless(async () =>
      response(JSON.stringify({ verdict: "supported", rationale: fakeCredential })),
    ).generate(request());
    expect(oversized).toMatchObject({ ok: false, errors: [{ details: { providerCode: "response_too_large" } }] });
    expect(secret).toMatchObject({ ok: false, errors: [{ details: { providerCode: "secret_in_provider_output" } }] });
    expect(JSON.stringify(secret)).not.toContain(fakeCredential);
  });

  it("retains usage, timing availability, pricing basis, and schema failures", async () => {
    const valid = await featherless(async () =>
      response('{"verdict":"supported","rationale":"Measured."}'),
    ).generate(request());
    const invalid = await featherless(async () =>
      response('{"verdict":"unknown","rationale":""}'),
    ).generate(request());
    expect(valid.attempts[0]).toMatchObject({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      },
      providerTiming: {
        queueMs: null,
        promptMs: null,
        completionMs: null,
        totalMs: null,
      },
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 0.1,
        outputPerMillionTokens: 0.2,
        snapshotDate: "2026-08-10",
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      errors: [
        { kind: "invalid_model_output" },
        { kind: "invalid_model_output" },
      ],
    });
  });

  it("keeps fixture mode credential-free and deterministic", async () => {
    const adapter = createFixtureAdapter({
      modelId: "fixture/assessment-v1",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: { "case-1": { verdict: "insufficient", rationale: "Frozen fixture." } },
    });
    const first = await adapter.generate(request({ fixtureKey: "case-1" }));
    const second = await adapter.generate(request({ fixtureKey: "case-1" }));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, attempts: [{ evidenceMode: "fixture" }] });
  });
});
