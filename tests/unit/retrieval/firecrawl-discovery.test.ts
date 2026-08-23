import { describe, expect, it, vi } from "vitest";

import { canonicalWebUrl, importFirecrawlCandidate, recognizedWebLicense, searchFirecrawl } from "../../../src/server/sources/firecrawl";

const API_KEY = "fc-secret-never-return";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function successfulBody(license = "CC BY 4.0") {
  return {
    success: true,
    data: {
      web: [{
        url: "https://research.example/paper?utm_source=test",
        title: "Grounded retrieval evaluation",
        description: "A bounded evaluation of grounded retrieval.",
        markdown: "Grounded retrieval reduced unsupported factual claims.\n\nThe evaluation reports limitations in noisy corpora.",
        category: "research",
        metadata: { license, author: "A. Researcher", publishedTime: "2025-03-01", citation_doi: "10.1000/grounded" },
      }],
    },
    warning: null,
  };
}

describe("Firecrawl bounded discovery", () => {
  it("searches research and PDF results without exposing the credential", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      const request = JSON.parse(String(init?.body)) as { limit: number; categories: Array<{ type: string }>; scrapeOptions: { onlyMainContent: boolean } };
      expect(request.limit).toBe(12);
      expect(request.categories).toEqual([{ type: "research" }, { type: "pdf" }]);
      expect(request.scrapeOptions.onlyMainContent).toBe(true);
      return response(200, successfulBody());
    });
    const result = await searchFirecrawl("grounded retrieval evidence", { apiKey: API_KEY, fetch: fetcher });
    expect(result.raw).toMatchObject({ status: "completed", failureCode: null });
    expect(result.candidates).toEqual([expect.objectContaining({ url: "https://research.example/paper", rightsEligible: true, license: "CC BY 4.0", canonicalDoi: "10.1000/grounded" })]);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("honors bounded Retry-After and reports exhausted rate limiting", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => response(429, { error: "rate limited" }, { "retry-after": "1" }));
    const result = await searchFirecrawl("rate limited research", { apiKey: API_KEY, fetch: fetcher, sleep, deadlineMs: 5_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(result).toMatchObject({ raw: { status: "failed", failureCode: "rate_limited" }, candidates: [] });
  });

  it("fails closed for invalid responses and private URLs", async () => {
    const invalid = await searchFirecrawl("invalid result", { apiKey: API_KEY, fetch: async () => response(200, { success: true, data: { web: [{ url: "http://127.0.0.1/private", markdown: "secret" }] } }) });
    expect(invalid).toMatchObject({ raw: { status: "partial", failureCode: "invalid_response" }, candidates: [] });
    expect(canonicalWebUrl("http://localhost/admin")).toBeNull();
    expect(canonicalWebUrl("https://example.test/path/?utm_medium=x#section")).toBe("https://example.test/path");
  });

  it("imports explicitly licensed content and keeps unlicensed content discovery-only", async () => {
    const licensed = (await searchFirecrawl("licensed", { apiKey: API_KEY, fetch: async () => response(200, successfulBody()) })).candidates[0]!;
    const imported = importFirecrawlCandidate({ candidate: licensed, claims: ["grounded retrieval factual claims"] });
    expect(imported.source.access).toMatchObject({ provider: "firecrawl", contentScope: "full_text" });
    expect(imported.source.rights).toMatchObject({ mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" });
    expect(imported.chunks.length).toBeGreaterThan(0);

    const unlicensed = { ...licensed, license: null, rightsEligible: false };
    const denied = importFirecrawlCandidate({ candidate: unlicensed, claims: ["grounded retrieval factual claims"] });
    expect(denied.source.access.contentScope).toBe("metadata_only");
    expect(denied.chunks).toEqual([]);
    expect(recognizedWebLicense("all rights reserved")).toBe(false);
  });
});
