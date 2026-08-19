import { describe, expect, it, vi } from "vitest";
import { rankClaimChunks } from "../../../src/server/sources/chunking";
import { downloadBoundedPdf, PdfDownloadError } from "../../../src/server/sources/download";
import { extractPdfText } from "../../../src/server/sources/pdf";
import { PasteSourceRequestSchema, OpenAlexSearchRequestSchema } from "../../../src/server/sources/schemas";

describe("scholarly ingestion building blocks", () => {
  it("ranks claim-relevant paragraphs deterministically and respects caps", () => {
    const input = { sourceId: "source-1", claim: "retrieval reduces hallucination", text: "Methods describe sampling.\n\nRetrieval reduces factual hallucination in grounded generation.\n\nLimitations discuss noisy retrieval." };
    const first = rankClaimChunks(input);
    expect(first[0]?.text).toContain("Retrieval reduces");
    expect(first.map((chunk) => chunk.id)).toEqual(["source-1-chunk-1", "source-1-chunk-2", "source-1-chunk-3"]);
    expect(rankClaimChunks({ ...input, maxChunks: 1 })).toHaveLength(1);
  });

  it("blocks untrusted origins, private hosts, redirects, and non-PDF responses", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { headers: { "content-type": "text/html" } }));
    await expect(downloadBoundedPdf("https://example.com/paper.pdf", { trustedOrigins: ["https://publisher.test"], fetch: fetcher })).rejects.toMatchObject({ code: "untrusted_origin" });
    await expect(downloadBoundedPdf("https://127.0.0.1/paper.pdf", { trustedOrigins: ["https://127.0.0.1"], fetch: fetcher })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(downloadBoundedPdf("https://publisher.test/paper.pdf", { trustedOrigins: ["https://publisher.test"], fetch: fetcher })).rejects.toMatchObject({ code: "not_pdf" });
  });

  it("follows only same-trusted-origin redirects and verifies PDF magic", async () => {
    const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), 1, 2]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final.pdf" } }))
      .mockResolvedValueOnce(new Response(pdf, { headers: { "content-type": "application/pdf" } }));
    const result = await downloadBoundedPdf("https://publisher.test/start", { trustedOrigins: ["https://publisher.test"], fetch: fetcher });
    expect(result.bytes).toEqual(pdf);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("adapts an injected unpdf-compatible parser and enforces page limits", async () => {
    const parser = { extractText: vi.fn(async () => ({ text: ["First page", "Second page"] })) };
    await expect(extractPdfText(new Uint8Array([1]), parser)).resolves.toMatchObject({ pageCount: 2, text: "First page\n\nSecond page" });
  });

  it("validates bounded paste and search request contracts", () => {
    expect(OpenAlexSearchRequestSchema.parse({ query: "retrieval hallucination" }).maxResults).toBe(10);
    expect(() => PasteSourceRequestSchema.parse({ title: "x", text: "", originalInput: "paste", rights: {} })).toThrow();
  });
});
