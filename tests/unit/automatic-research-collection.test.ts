import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import type { StructuredGenerationAdapter } from "../../src/server/models";
import { collectAutomaticResearchPacket } from "../../src/server/research/live-collection";
import type { ScholarlyCandidate } from "../../src/server/sources/openalex";

function candidate(id: number): ScholarlyCandidate {
  return {
    openAlexId: `W${id}`,
    title: `Research result ${id}`,
    canonicalDoi: `10.1000/result-${id}`,
    publicationYear: 2025,
    authors: ["Researcher"],
    isOpenAccess: true,
    landingPageUrl: `https://example.test/${id}`,
    pdfUrl: null,
    license: "cc-by",
    citationCount: id,
    hasAbstract: true,
  };
}

function liveRun(): ResearchRun {
  return { ...structuredClone(goldenRunV02), id: "live-auto-run", evidenceMode: "live", status: "collecting_sources" } as ResearchRun;
}

const triageAdapter = {
  identity: { provider: "groq", modelId: "test-primary", developerFamily: "test", baseFamily: "test" },
  generate: async (request: { messages: Array<{ role: string; content: string }> }) => {
    const payload = JSON.parse(request.messages.at(-1)!.content) as { candidates: Array<{ openAlexId: string }> };
    return {
      ok: true as const,
      value: {
        ratings: payload.candidates.map(({ openAlexId }, index) => ({
          openAlexId,
          role: index % 3 === 0 ? "challenge" as const : "support" as const,
          score: 0.9 - index * 0.01,
          reason: "Claim-grounded test rating",
        })),
      },
      attempts: [],
      errors: [],
    };
  },
} as unknown as StructuredGenerationAdapter;

describe("automatic research collection", () => {
  it("searches, triages, and imports a ten-source mixed packet", async () => {
    let searchIndex = 0;
    const result = await collectAutomaticResearchPacket({
      run: liveRun(),
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: triageAdapter, reviewer: triageAdapter, evidenceMode: "live" },
      search: async (query) => {
        const offset = searchIndex++ * 3;
        const candidates = [candidate(offset + 1), candidate(offset + 2), candidate(offset + 3)];
        return { provider: "openalex", query, candidates, raw: {} as never };
      },
      importWork: async ({ openAlexId }) => {
        const sourceId = `source-${openAlexId.toLowerCase()}`;
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        const baseChunk = structuredClone(goldenRunV02.chunks[0]!);
        return {
          source: { ...baseSource, id: sourceId, access: { ...baseSource.access, contentScope: "abstract" }, rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } },
          chunks: [{ ...baseChunk, id: `chunk-${openAlexId.toLowerCase()}`, sourceId, displayPermission: "allowed" }],
          warnings: ["Abstract-scoped test source"],
        };
      },
    });
    expect(result.queries).toHaveLength(4);
    expect(result.candidatesConsidered).toBe(12);
    expect(result.draft.sources).toHaveLength(10);
    expect(result.usableSources).toBe(10);
    expect(result.blocked).toBe(false);
    expect(result.triageAudits.every(({ status }) => status === "completed")).toBe(true);
    expect(result.importAudits.every(({ status }) => status === "completed")).toBe(true);
  });

  it("blocks analysis when fewer than five imports yield permitted text", async () => {
    const result = await collectAutomaticResearchPacket({
      run: liveRun(),
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      config: { target: 5, minimum: 5 },
      adapters: { primary: triageAdapter, reviewer: triageAdapter, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [candidate(1)], raw: {} as never }),
      importWork: async () => { throw new Error("No permitted text"); },
    });
    expect(result.usableSources).toBe(0);
    expect(result.blocked).toBe(true);
  });
});
