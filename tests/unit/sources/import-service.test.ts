import { describe, expect, it, vi } from "vitest";
import { createPastedSource, importOpenAlexWork } from "../../../src/server/sources/import-service";

const work = { id: "https://openalex.org/W123", doi: "https://doi.org/10.1234/test", title: "Retrieval reduces hallucination", publication_year: 2024, authorships: [{ author: { display_name: "A Researcher" } }], open_access: { is_oa: true, oa_status: "gold" }, best_oa_location: { landing_page_url: "https://publisher.test/work", pdf_url: "https://publisher.test/work.pdf", license: "cc-by", version: "publishedVersion", source: { display_name: "Journal of Tests" } } };

describe("source import service", () => {
  it("imports OpenAlex metadata and parser-backed PDF chunks without leaking the key into records", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(work), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), 1]), { headers: { "content-type": "application/pdf" } }));
    const result = await importOpenAlexWork({ openAlexId: "W123", claims: ["retrieval reduces hallucination"], rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: "CC BY" } }, { apiKey: "secret-key", fetch: fetcher, trustedPdfOrigins: ["https://publisher.test"], pdfParser: { extractText: vi.fn(async () => ({ text: ["Retrieval reduces factual hallucination in grounded generation."] })) } });
    expect(result.source.bibliographicMetadata.title).toBe(work.title);
    expect(result.source.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.chunks).toHaveLength(1);
    expect(result.source.originalInput).not.toContain("secret-key");
  });

  it("returns an honest metadata-only record when PDF text is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...work, best_oa_location: { landing_page_url: "https://publisher.test/work", license: null } }), { status: 200 }));
    const result = await importOpenAlexWork({ openAlexId: "W123", claims: ["retrieval reduces hallucination"] }, { apiKey: "secret", fetch: fetcher });
    expect(result.source.access.contentScope).toBe("metadata_only");
    expect(result.chunks).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/PDF|license/u);
  });

  it("creates a rights-aware pasted source", () => {
    const result = createPastedSource({ id: "paste-1", title: "Research note", text: "Retrieval reduces hallucination in this experiment.", claims: ["retrieval reduces hallucination"], originalInput: "researcher paste", rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: "author-provided" } });
    expect(result.source.access.contentScope).toBe("user_excerpt");
    expect(result.chunks[0]?.text).toContain("Retrieval reduces");
  });

  it("imports a permitted OpenAlex abstract when full text is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ...work,
      best_oa_location: { landing_page_url: "https://publisher.test/work", license: "cc-by" },
      abstract_inverted_index: {
        Retrieval: [0],
        reduces: [1],
        hallucination: [2],
        empirically: [3],
      },
    }), { status: 200 }));
    const result = await importOpenAlexWork({
      openAlexId: "W123",
      claims: ["retrieval reduces hallucination"],
      rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: "CC BY abstract" },
    }, { apiKey: "secret", fetch: fetcher });
    expect(result.source.access.contentScope).toBe("abstract");
    expect(result.chunks[0]?.text).toContain("Retrieval reduces hallucination");
    expect(result.warnings.join(" ")).toMatch(/limited to the OpenAlex abstract/u);
  });

  it("fails closed when pasted-text rights are not explicit", () => {
    const result = createPastedSource({ id: "paste-unknown-rights", title: "Uncleared note", text: "Uncleared research text.", claims: ["research text"], originalInput: "researcher paste" });
    expect(result.source.access.contentScope).toBe("metadata_only");
    expect(result.chunks).toEqual([]);
    expect(result.source.rights).toMatchObject({ mayStore: "unknown", mayDisplay: "unknown", maySendToModel: "unknown" });
  });
});
