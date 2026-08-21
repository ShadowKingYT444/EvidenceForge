import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  freezeCurrentPacket,
  NodeExecutionSchema,
  ResearchRunSchema,
} from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import { PacketDraftSchema } from "../../src/server/sources/packet-draft";
import { DurableRunCoordinator } from "../../src/server/workflow/durable-coordinator";
import { AsyncWorkflowRunStoreAdapter, InMemoryWorkflowRunStore } from "../../src/server/workflow/store";

describe("verified packet materialization", () => {
  it("turns the frozen ten-passage draft into exactly ten canonical evidence cards", async () => {
    const baseSource = goldenRunV02.sources[0]!;
    const baseChunk = goldenRunV02.chunks.find(({ sourceId }) => sourceId === baseSource.id)!;
    const sources = Array.from({ length: 5 }, (_, sourceIndex) => {
      const id = `verified-source-${sourceIndex + 1}`;
      return {
        ...structuredClone(baseSource),
        id,
        contentHash: canonicalSha256(`verified source ${sourceIndex + 1}`),
        rights: { ...baseSource.rights, mayStore: "allowed" as const, mayDisplay: "allowed" as const, maySendToModel: "allowed" as const },
      };
    });
    const chunks = sources.flatMap((source, sourceIndex) => Array.from({ length: 2 }, (_, passageIndex) => {
      const text = `Verified literal passage ${sourceIndex * 2 + passageIndex + 1} directly reports a bounded result for the approved scientific claim and preserves its limitation.`;
      return {
        ...structuredClone(baseChunk),
        id: `${source.id}-chunk-${passageIndex + 1}`,
        sourceId: source.id,
        text,
        contentHash: canonicalSha256(text),
        displayPermission: "allowed" as const,
      };
    }));
    const packet = freezeCurrentPacket({
      sourceHashes: sources.map(({ contentHash }) => contentHash),
      chunkHashes: chunks.map(({ contentHash }) => contentHash),
      frozenAt: "2026-08-20T00:00:00.000Z",
      freezeDecision: {
        ...structuredClone(goldenRunV02.packet!.freezeDecision),
        id: "verified-packet-freeze",
        decidedAt: "2026-08-20T00:00:00.000Z",
      },
    });
    const run = ResearchRunSchema.parse({
      ...structuredClone(goldenRunV02),
      id: "verified-materialization-run",
      evidenceMode: "live",
      status: "extracting_evidence",
      sources,
      chunks,
      packet,
      evidenceCards: [],
      conclusions: [],
      researchGaps: [],
      selectedGapId: null,
      experiment: null,
      experimentAbstention: null,
      review: null,
      objectionDispositionDecision: null,
      revision: null,
      finalDecision: null,
      executions: goldenRunV02.executions.filter(({ nodeId }) => nodeId === "clarify-and-decompose"),
      errors: goldenRunV02.errors.filter(({ nodeId }) => nodeId === "clarify-and-decompose"),
    });
    const extractionTemplate = goldenRunV02.executions.find(({ nodeId, status }) => nodeId === "extract-evidence" && status === "succeeded")!;
    const primaryAttempt = NodeExecutionSchema.parse({
      ...structuredClone(extractionTemplate),
      id: "verified-primary-execution",
      nodeId: "extract-evidence:draft-batch-1",
      attempt: 1,
      evidenceMode: "live",
      inputRefs: chunks.map(({ id }) => id),
      outputRefs: [],
      retryOfExecutionId: null,
      requestedProvider: "groq",
      returnedProvider: "groq",
      requestedModelId: "test-primary",
      returnedModelId: "test-primary",
      requestedDeveloperFamily: "test",
      returnedDeveloperFamily: "test",
      requestedBaseFamily: "test",
      returnedBaseFamily: "test",
      errorIds: [],
      validation: { valid: true, issues: [] },
    });
    const reviewerAttempt = NodeExecutionSchema.parse({
      ...structuredClone(primaryAttempt),
      id: "verified-reviewer-execution",
      nodeId: "extract-evidence:review-draft-batch-1",
      requestedProvider: "nvidia_nim",
      returnedProvider: "nvidia_nim",
      requestedModelId: "test-reviewer",
      returnedModelId: "test-reviewer",
    });
    const passages = chunks.map((chunk, index) => {
      const source = sources.find(({ id }) => id === chunk.sourceId)!;
      const subclaimId = run.claims[index % run.claims.length]!.id;
      return {
        id: `verified-passage-${index + 1}`,
        subclaimId,
        sourceId: source.id,
        sourceChunkId: chunk.id,
        excerpt: chunk.text,
        excerptHash: canonicalSha256(chunk.text),
        queryId: `query-${subclaimId}`,
        likelyRole: "support" as const,
        extractedResult: `Bounded result ${index + 1}`,
        settingAndSample: "Verified test setting",
        studyType: "controlled study",
        limitation: "Limited to the recorded passage.",
        extractionIssues: [],
        selectionScore: 0.945,
        primary: { provider: "groq", executionId: primaryAttempt.id, relevance: 0.96, directness: 0.94, reason: "Direct evidence." },
        reviewer: { provider: "nvidia_nim", executionId: reviewerAttempt.id, relevance: 0.95, directness: 0.93, reason: "Independent agreement." },
        deterministic: { literalMatch: true as const, anchorMatch: true as const, rightsEligible: true as const, sourceHash: source.contentHash, chunkHash: chunk.contentHash },
      };
    });
    const draft = PacketDraftSchema.parse({
      sources: sources.map((source) => ({ source, chunks: chunks.filter(({ sourceId }) => sourceId === source.id), importedAt: "2026-08-20T00:00:00.000Z" })),
      verification: {
        status: "ready",
        targetPassages: 10,
        queries: run.claims.map((claim, index) => ({ id: `query-${claim.id}`, claimId: claim.id, query: `verified claim evidence ${index}`, intent: "direct", anchors: ["verified claim"], round: 1 })),
        passages,
        pendingPassages: [],
        providerFailures: [],
        verificationAttempt: 1,
        claimsCovered: run.claims.map(({ id }) => id),
        claimsMissing: [],
        roundsCompleted: 1,
        candidatesConsidered: 10,
        rejectionCounts: { offTopic: 0, noPermittedText: 0, rightsIneligible: 0, primaryRejected: 0, reviewerRejected: 0, providerFailure: 0, literalValidationFailed: 0, duplicate: 0 },
        plannerFallbackUsed: false,
        primaryAttempts: [primaryAttempt],
        primaryErrors: [],
        reviewerAttempts: [reviewerAttempt],
        reviewerErrors: [],
      },
    });
    const coordinator = new DurableRunCoordinator(new AsyncWorkflowRunStoreAdapter(new InMemoryWorkflowRunStore()));
    const imported = await coordinator.importSnapshot({ run, revision: "verified-base", objectionDispositions: null });
    await coordinator.savePacketDraft(imported.snapshot.run.id, imported.snapshot.revision, imported.accessToken, draft);
    const result = await coordinator.continue(imported.snapshot.run.id, imported.snapshot.revision, imported.accessToken);
    expect(result.snapshot.run.status).toBe("verifying_evidence");
    expect(result.snapshot.run.evidenceCards).toHaveLength(10);
    expect(result.snapshot.run.evidenceCards.every((card) => card.deterministicVerification.status === "verified")).toBe(true);
    expect(result.snapshot.run.executions.some(({ id }) => id === reviewerAttempt.id)).toBe(true);
  });
});
