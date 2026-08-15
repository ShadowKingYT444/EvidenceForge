import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROVIDER_CONFIG,
  createConnectionRequest,
  resetConnectionRateLimitForTests,
  verifyProviderConnection,
  type ProviderId,
} from "../../src/server/providers/connection";
import { POST } from "../../src/app/api/providers/test/route";
import { providerIds as clientProviderIds } from "../../src/features/providers/catalog";

const key = "sk-test-only-not-a-real-key";
const models: Record<ProviderId, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  grok: "grok-3-mini",
  deepseek: "deepseek-chat",
  nim: "meta/llama-3.1-8b-instruct",
  featherless: "mistralai/Mistral-Large-Instruct-2411",
};

afterEach(() => {
  vi.useRealTimers();
  resetConnectionRateLimitForTests();
});

describe("provider connection contract", () => {
  it("keeps the client catalog and server allowlist complete for the same six providers", () => {
    expect([...clientProviderIds]).toEqual([...Object.keys(PROVIDER_CONFIG)]);
  });

  it.each(Object.keys(PROVIDER_CONFIG) as ProviderId[])(
    "serializes the bounded request for %s",
    (provider) => {
      const request = createConnectionRequest({ provider, model: models[provider], apiKey: key });
      expect(request.provider).toBe(provider);
      expect(request.model).toBe(models[provider]);
      expect(request.apiKey).toBe(key);
      expect(request).not.toHaveProperty("endpoint");
    },
  );

  it("rejects unsupported providers, custom endpoints, malformed models, and oversized secrets", () => {
    expect(() => createConnectionRequest({ provider: "custom", model: "x", apiKey: key })).toThrow();
    expect(() => createConnectionRequest({ provider: "openai", model: "bad model", apiKey: key })).toThrow();
    expect(() => createConnectionRequest({ provider: "openai", model: "gpt-4.1-mini", apiKey: "x".repeat(2049) })).toThrow();
    expect(() => createConnectionRequest({ provider: "openai", model: "gpt-4.1-mini", apiKey: key, endpoint: "https://evil.example" })).toThrow();
  });

  it.each(Object.keys(PROVIDER_CONFIG) as ProviderId[])(
    "uses only the closed endpoint and provider headers for %s",
    async (provider) => {
      const transport = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        expect(url).toBe(PROVIDER_CONFIG[provider].endpoint);
        const headers = new Headers(init.headers);
        if (provider === "anthropic") expect(headers.get("x-api-key")).toBe(key);
        else expect(headers.get("authorization")).toBe(`Bearer ${key}`);
      expect(body.model).toBe(models[provider]);
      expect(body.max_tokens ?? body.max_output_tokens).toBe(8);
        expect(body.stream).toBe(false);
        expect(JSON.stringify(body)).not.toContain(key);
        const response = provider === "openai"
          ? { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }
          : provider === "anthropic"
            ? { id: "msg", content: [{ type: "text", text: "ok" }] }
            : { id: "ok", choices: [{ message: { content: "ok" } }] };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const result = await verifyProviderConnection(
        { provider, model: models[provider], apiKey: key },
        { transport },
      );
      expect(result).toMatchObject({ ok: true, provider, model: models[provider], evidenceMode: "live" });
      expect(JSON.stringify(result)).not.toContain(key);
    },
  );

  it("uses Anthropic authentication without bearer leakage", async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-api-key")).toBe(key);
      expect(headers.get("authorization")).toBeNull();
      expect(JSON.parse(String(init.body)).max_tokens).toBe(8);
      return new Response(JSON.stringify({ id: "msg", content: [{ text: "ok" }] }), { status: 200 });
    });
    const result = await verifyProviderConnection(
      { provider: "anthropic", model: models.anthropic, apiKey: key },
      { transport },
    );
    expect(result.ok).toBe(true);
  });

  it("sanitizes non-2xx, oversized, invalid, timeout, and secret-bearing responses", async () => {
    const scenarios = [
      new Response("provider says secret " + key, { status: 401 }),
      new Response("{}", { status: 200, headers: { "content-length": "70000" } }),
      new Response("not-json", { status: 200 }),
    ];
    for (const response of scenarios) {
      const result = await verifyProviderConnection(
        { provider: "featherless", model: models.featherless, apiKey: key },
        { transport: vi.fn(async () => response) },
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(key);
    }
    const chunkedOverflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_535));
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    });
    const streamed = await verifyProviderConnection(
      { provider: "featherless", model: models.featherless, apiKey: key },
      { transport: vi.fn(async () => new Response(chunkedOverflow, { status: 200 })) },
    );
    expect(streamed).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    const timeout = await verifyProviderConnection(
      { provider: "featherless", model: models.featherless, apiKey: key },
      { timeoutMs: 1, transport: vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
      })) },
    );
    expect(timeout).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("rate limits repeated connection checks without a retry", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    for (let i = 0; i < 8; i += 1) {
      await verifyProviderConnection({ provider: "featherless", model: models.featherless, apiKey: key }, { transport, rateKey: "test" });
    }
    const limited = await verifyProviderConnection({ provider: "featherless", model: models.featherless, apiKey: key }, { transport, rateKey: "test" });
    expect(limited).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(transport).toHaveBeenCalledTimes(8);
  });

  it("enforces same-origin, body bounds, no-store headers, and sanitized route output", async () => {
    const crossOrigin = await POST(new Request("https://app.example/api/providers/test", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
    }));
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toContain("no-store");

    const oversized = await POST(new Request("https://app.example/api/providers/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9000" },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    try {
      const success = await POST(new Request("https://app.example/api/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example" },
        body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
      }));
      expect(success.status).toBe(200);
      expect(success.headers.get("cache-control")).toBe("private, no-store");
      expect(await success.text()).not.toContain(key);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("reconstructs the public Render origin from one validated forwarded host/proto pair", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    try {
      const proxied = await POST(new Request("http://next-internal:3130/api/providers/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evidenceforge.onrender.com",
          "x-forwarded-host": "evidenceforge.onrender.com",
          "x-forwarded-proto": "https",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
      }));
      expect(proxied.status).toBe(200);

      const ambiguous = await POST(new Request("http://next-internal:3130/api/providers/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evidenceforge.onrender.com",
          "x-forwarded-host": "evidenceforge.onrender.com, attacker.example",
          "x-forwarded-proto": "https",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
      }));
      expect(ambiguous.status).toBe(403);

      const trailingAmbiguity = await POST(new Request("http://next-internal:3130/api/providers/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evidenceforge.onrender.com",
          "x-forwarded-host": "evidenceforge.onrender.com,",
          "x-forwarded-proto": "https",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
      }));
      expect(trailingAmbiguity.status).toBe(403);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects same-site and cross-site Fetch Metadata requests", async () => {
    for (const fetchSite of ["same-site", "cross-site"]) {
      const response = await POST(new Request("https://app.example/api/providers/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example",
          "sec-fetch-site": fetchSite,
        },
        body: JSON.stringify({ provider: "featherless", model: models.featherless, apiKey: key }),
      }));
      expect(response.status).toBe(403);
    }
  });

  it("cancels request streams at 8 KiB without trusting absent or lying Content-Length", async () => {
    for (const contentLength of [undefined, "1"]) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8_192));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers = new Headers({ "content-type": "application/json" });
      if (contentLength) headers.set("content-length", contentLength);
      const response = await POST(new Request("https://app.example/api/providers/test", {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }));
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
    }
  });
});
