import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../../src/contracts";
import { goldenRunV01 } from "../../../src/fixtures/golden-run-v0.1";
import { addDraftSource, PacketDraftSchema, removeDraftSource } from "../../../src/server/sources/packet-draft";

const importedAt = "2026-08-18T20:00:00.000Z";
const entry = (index = 0) => ({ source: structuredClone(goldenRunV01.sources[index]!), chunks: structuredClone(goldenRunV01.chunks.filter((chunk) => chunk.sourceId === goldenRunV01.sources[index]!.id)), importedAt });

describe("packet draft helpers", () => {
  it("keeps source IDs unique and replaces a repeated source", () => {
    const first = addDraftSource({ sources: [] }, entry(0));
    const replaced = addDraftSource(first, { ...entry(0), importedAt: "2026-08-18T20:01:00.000Z" });
    expect(replaced.sources).toHaveLength(1);
    expect(replaced.sources[0]?.importedAt).toBe("2026-08-18T20:01:00.000Z");
  });

  it("enforces the twenty-source draft ceiling and supports removal", () => {
    let draft: unknown = { sources: [] };
    for (let index = 0; index < 20; index += 1) {
      const sourceId = `draft-source-${index}`;
      const source = { ...entry(0), source: { ...entry(0).source, id: sourceId }, chunks: entry(0).chunks.map((chunk) => ({ ...chunk, id: `${sourceId}-${chunk.id}`, sourceId })) };
      draft = addDraftSource(draft, source);
    }
    expect(PacketDraftSchema.parse(draft).sources).toHaveLength(20);
    expect(() => addDraftSource(draft, { ...entry(0), source: { ...entry(0).source, id: "twenty-first-source" }, chunks: entry(0).chunks.map((chunk) => ({ ...chunk, id: `twenty-first-source-${chunk.id}`, sourceId: "twenty-first-source" })) })).toThrow();
    expect(removeDraftSource(draft, "draft-source-3").sources).toHaveLength(19);
  });

  it("rejects malformed entries and duplicate source IDs in a raw draft", () => {
    expect(() => addDraftSource({ sources: [] }, { ...entry(0), importedAt: "not-a-timestamp" })).toThrow();
    expect(() => PacketDraftSchema.parse({ sources: [entry(0), entry(0)] })).toThrow(/unique/i);
  });

  it("rejects global chunk collisions and containing-source mismatches before maps can overwrite", () => {
    const first = entry(0);
    const second = structuredClone(entry(0));
    second.source.id = "second-source";
    second.chunks.forEach((chunk) => { chunk.sourceId = second.source.id; });
    second.chunks[0]!.id = first.chunks[0]!.id;
    expect(() => PacketDraftSchema.parse({ sources: [first, second] })).toThrow(/chunk IDs must be globally unique/i);

    const mismatched = structuredClone(entry(0));
    mismatched.chunks[0]!.sourceId = "different-source";
    expect(() => PacketDraftSchema.parse({ sources: [mismatched] })).toThrow(/containing source/i);
  });

  it("rejects a passage identity present in both verified and pending sets", () => {
    const sourceEntry = entry(0);
    const source = sourceEntry.source;
    const chunk = sourceEntry.chunks[0]!;
    const excerpt = chunk.text;
    const passageId = "passage-shared";
    const verification = {
      status: "provider_unavailable",
      targetPassages: 10,
      queries: [{ id: "query-1", claimId: "claim-1", query: "retrieval evidence", intent: "direct", anchors: ["retrieval"], round: 1 }],
      passages: [{
        id: passageId, subclaimId: "claim-1", sourceId: source.id, sourceChunkId: chunk.id,
        excerpt, excerptHash: canonicalSha256(excerpt), queryId: "query-1", likelyRole: "support",
        extractedResult: "A bounded result.", sourceType: "technical", settingAndSample: null,
        studyType: "technical analysis", limitation: "Bounded fixture.", extractionIssues: [], selectionScore: 0.9,
        primary: { provider: "groq", executionId: "execution-primary", relevance: 0.9, directness: 0.9, reason: "Direct." },
        reviewer: { provider: "nvidia_nim", executionId: "execution-reviewer", relevance: 0.9, directness: 0.9, reason: "Independent." },
        deterministic: { literalMatch: true, anchorMatch: true, rightsEligible: true, sourceHash: source.contentHash, chunkHash: chunk.contentHash },
      }],
      pendingPassages: [{ id: passageId, claimId: "claim-1", sourceId: source.id, sourceChunkId: chunk.id, sourceTitle: source.bibliographicMetadata.title, excerpt, queryId: "query-1", sourceHash: source.contentHash, chunkHash: chunk.contentHash }],
      providerFailures: [], searchAudits: [], verificationAttempt: 1, claimsCovered: ["claim-1"], claimsMissing: [], roundsCompleted: 1,
      candidatesConsidered: 1,
      rejectionCounts: { offTopic: 0, noPermittedText: 0, rightsIneligible: 0, primaryRejected: 0, reviewerRejected: 0, providerFailure: 0, literalValidationFailed: 0, duplicate: 0 },
      plannerFallbackUsed: false, primaryAttempts: [], primaryErrors: [], reviewerAttempts: [], reviewerErrors: [],
    };
    expect(() => PacketDraftSchema.parse({ sources: [sourceEntry], verification })).toThrow(/globally unique/i);
  });
});
