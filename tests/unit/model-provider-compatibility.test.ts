import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createModelAdapter, type AdapterRuntime, type ProviderKind, type StructuredGenerationRequest } from "../../src/server/models";

const outputSchema = z.object({ answer: z.string() }).strict();
const secret = "provider-test-secret";

function request(): StructuredGenerationRequest<typeof outputSchema> {
  return { nodeId: "query-plan", inputRefs: ["run"], outputRefs: ["plan"], promptId: "plan", promptVersion: "1", promptHash: "a".repeat(64), schemaVersion: "v0", schemaName: "plan", outputSchema, outputJsonSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, messages: [{ role: "system", content: "Use evidence." }, { role: "user", content: "Answer." }], settings: { temperature: 0, maxOutputTokens: 64, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null }, timeoutMs: 500, measured: true, repairInvalidOutput: false, maximumAttempts: 1, codeVersion: "test" };
}

function runtime(transport: AdapterRuntime["transport"]): AdapterRuntime {
  let id = 0;
  return { transport, now: () => new Date("2026-08-23T00:00:00.000Z"), monotonicNow: (() => { let value = 0; return () => value += 10; })(), makeId: (prefix) => `${prefix}-${++id}`, sleep: async () => {} };
}

const cases: Array<{ provider: ProviderKind; model: string; assertRequest: (url: string, init: RequestInit) => void; response: unknown }> = [
  { provider: "openai", model: "gpt-4.1-mini", assertRequest: (url, init) => { expect(url).toBe("https://api.openai.com/v1/chat/completions"); expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`); expect(JSON.parse(String(init.body)).response_format).toEqual({ type: "json_object" }); }, response: { id: "openai-1", model: "gpt-4.1-mini", choices: [{ finish_reason: "stop", message: { content: "{\"answer\":\"ok\"}" } }], usage: {} } },
  { provider: "anthropic", model: "claude-sonnet-4-20250514", assertRequest: (url, init) => { expect(url).toBe("https://api.anthropic.com/v1/messages"); expect(new Headers(init.headers).get("x-api-key")).toBe(secret); const body = JSON.parse(String(init.body)); expect(body.system).toBe("Use evidence."); expect(body.messages[0].role).toBe("user"); }, response: { id: "claude-1", model: "claude-sonnet-4-20250514", stop_reason: "end_turn", content: [{ type: "text", text: "{\"answer\":\"ok\"}" }], usage: { input_tokens: 8, output_tokens: 4 } } },
  { provider: "gemini", model: "gemini-2.5-flash", assertRequest: (url, init) => { expect(url).toContain("gemini-2.5-flash:generateContent"); expect(new Headers(init.headers).get("x-goog-api-key")).toBe(secret); const body = JSON.parse(String(init.body)); expect(body.generationConfig.responseMimeType).toBe("application/json"); expect(body.contents[0].role).toBe("user"); }, response: { responseId: "gemini-1", modelVersion: "gemini-2.5-flash-001", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{\"answer\":\"ok\"}" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } } },
  { provider: "groq", model: "custom/compatible-model", assertRequest: (_url, init) => { expect(JSON.parse(String(init.body)).response_format).toEqual({ type: "json_object" }); }, response: { id: "groq-1", model: "custom/compatible-model", choices: [{ finish_reason: "stop", message: { content: "{\"answer\":\"ok\"}" } }], usage: {} } },
];

describe.each(cases)("$provider model adapter", ({ provider, model, assertRequest, response }) => {
  it("normalizes the provider protocol into an audited structured result", async () => {
    const transport = vi.fn(async (url: string, init: RequestInit) => { assertRequest(url, init); expect(String(init.body)).not.toContain(secret); return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }); });
    const adapter = createModelAdapter(provider, { apiKey: secret, modelId: model, developerFamily: provider, baseFamily: model.split("/")[0], evidenceMode: "live" }, runtime(transport));
    const result = await adapter.generate(request());
    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toMatchObject({ requestedProvider: provider, returnedProvider: provider, requestedModelId: model, returnedModelId: model, validation: { valid: true } });
  });
});
