import { describe, expect, it } from "vitest";

import { canonicalSha256, NodeExecutionSchema, RunErrorSchema, type ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import type { StructuredGenerationAdapter, StructuredGenerationRequest } from "../../src/server/models";
import { collectAutomaticResearchPacket } from "../../src/server/research/live-collection";
import type { ScholarlyCandidate } from "../../src/server/sources/openalex";

function candidate(id: number, input: Partial<ScholarlyCandidate> = {}): ScholarlyCandidate {
  return {
    openAlexId: `W${id}`,
    title: `Claim-specific research result ${id}`,
    canonicalDoi: `10.1000/result-${id}`,
    publicationYear: 2025,
    authors: ["Researcher"],
    isOpenAccess: true,
    landingPageUrl: `https://example.test/${id}`,
    pdfUrl: null,
    license: "cc-by",
    citationCount: id,
    hasAbstract: true,
    abstract: "A controlled study directly evaluates the claim-specific mechanism and reports bounded results.",
    providerRelevanceScore: 900 - id,
    ...input,
  };
}

function liveRun(): ResearchRun {
  return { ...structuredClone(goldenRunV02), id: "live-auto-run", evidenceMode: "live", status: "collecting_sources" } as ResearchRun;
}

function focusedRun(): ResearchRun {
  const run = liveRun();
  run.claims = [run.claims[0]!];
  return run;
}

type TestProvider = "groq" | "nvidia_nim" | "featherless";

function execution(request: StructuredGenerationRequest, provider: TestProvider) {
  const modelId = provider === "groq" ? "test-primary" : provider === "nvidia_nim" ? "test-reviewer" : "test-fallback";
  return NodeExecutionSchema.parse({
    id: `execution-${provider}-${request.nodeId}`,
    nodeId: request.nodeId,
    attempt: 1,
    status: "succeeded",
    evidenceMode: "live",
    inputRefs: [...request.inputRefs],
    outputRefs: [],
    requestedProvider: provider,
    returnedProvider: provider,
    requestedModelId: modelId,
    returnedModelId: modelId,
    requestedDeveloperFamily: "test",
    returnedDeveloperFamily: "test",
    requestedBaseFamily: "test",
    returnedBaseFamily: "test",
    returnedReasoningMode: "disabled",
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    promptHash: request.promptHash,
    structuredOutputSchemaVersion: request.schemaVersion,
    generationSettings: request.settings,
    startedAt: "2026-08-20T00:00:00.000Z",
    endedAt: "2026-08-20T00:00:01.000Z",
    clientLatencyMs: 1_000,
    providerTiming: { queueMs: null, promptMs: null, completionMs: null, totalMs: null },
    requestIds: { clientRequestId: `request-${provider}-${request.nodeId}`, providerRequestId: null, responseId: `response-${provider}-${request.nodeId}` },
    finishReason: "stop",
    refusal: { refused: false, reason: null },
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null },
    pricing: { currency: "USD", inputPerMillionTokens: null, outputPerMillionTokens: null, estimatedCost: null, snapshotDate: null },
    validation: { valid: true, issues: [] },
    errorIds: [],
    retryOfExecutionId: null,
    fallbackFromExecutionId: null,
    codeVersion: null,
  });
}

function adapter(provider: TestProvider): StructuredGenerationAdapter {
  return {
    identity: { provider, modelId: provider === "groq" ? "test-primary" : provider === "nvidia_nim" ? "test-reviewer" : "test-fallback", developerFamily: "test", baseFamily: "test" },
    async generate(request) {
      const payload = JSON.parse(request.messages.at(-1)!.content) as Record<string, unknown>;
      let value: unknown;
      if (request.promptId === "autonomous-evidence-query-plan") {
        const claims = payload.claims as Array<{ id: string; statement: string }>;
        value = {
          queries: claims.flatMap((claim, index) => {
            const claimTerms = claim.statement.split(/\s+/u).filter((term) => term.length > 1);
            const anchors = [claimTerms.slice(0, 2).join(" "), ...claimTerms.slice(0, 3)];
            return [
              { id: `query-${index}-direct`, claimId: claim.id, query: `${claim.statement.split(/\s+/u).slice(0, 4).join(" ")} evidence`, intent: "direct", anchors, round: 1 },
              { id: `query-${index}-challenge`, claimId: claim.id, query: `${claim.statement.split(/\s+/u).slice(0, 4).join(" ")} limitation`, intent: "challenge", anchors, round: 2 },
            ];
          }).slice(0, 10),
        };
      } else {
        const passages = payload.passages as Array<{ proposalId: string; proposedClaimId: string; sourceTitle: string }>;
        value = {
          reviews: passages.map((passage) => {
            const accepted = !/generic|molecular/iu.test(passage.sourceTitle);
            return {
              proposalId: passage.proposalId,
              accepted,
              matchedClaimId: passage.proposedClaimId,
              likelyRole: "support",
              relevance: accepted ? 0.96 : 0.2,
              directness: accepted ? 0.94 : 0.1,
              extractedResult: "The passage reports a direct claim-specific result.",
              settingAndSample: "Bounded test setting and reported sample.",
              studyType: "controlled study",
              limitation: "Limited to the reported source context.",
              extractionIssues: [],
              reason: accepted ? "Directly evaluates the approved claim." : "Only generic or cross-domain background.",
            };
          }),
        };
      }
      const parsed = request.outputSchema.parse(value);
      return { ok: true as const, value: parsed, attempts: [execution(request, provider)], errors: [] };
    },
  } as StructuredGenerationAdapter;
}

function failingAdapter(provider: TestProvider, httpStatus = 429): StructuredGenerationAdapter {
  return {
    identity: { provider, modelId: "test-failure", developerFamily: "test", baseFamily: "test" },
    async generate(request) {
      const successful = execution(request, provider);
      const error = RunErrorSchema.parse({
        id: `error-${provider}-${request.nodeId}`,
        kind: "provider_failure",
        message: `provider returned HTTP ${httpStatus}`,
        nodeId: request.nodeId,
        executionId: successful.id,
        retryable: true,
        occurredAt: successful.endedAt,
        details: { field: null, providerCode: "rate_limit", httpStatus },
      });
      const attempt = NodeExecutionSchema.parse({ ...successful, status: "failed", validation: { valid: false, issues: [error.message] }, errorIds: [error.id] });
      return { ok: false as const, attempts: [attempt], errors: [error] };
    },
  } as StructuredGenerationAdapter;
}

function automaticDependencies() {
  let searchIndex = 0;
  const queryByWork = new Map<string, string>();
  return {
    search: async (query: string) => {
      const offset = ++searchIndex * 10;
      const candidates = [
        candidate(offset + 1, { title: `${query} biodegradable battery environmental sensor study one`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
        candidate(offset + 2, { title: `${query} biodegradable battery environmental sensor study two`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
        candidate(offset + 3, { title: `${query} biodegradable battery environmental sensor study three`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
        candidate(offset + 4, { title: `${query} biodegradable battery environmental sensor study four`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
        candidate(offset + 5, { title: `${query} biodegradable battery environmental sensor study five`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
      ];
      for (const work of candidates) queryByWork.set(work.openAlexId, query);
      return { provider: "openalex" as const, query, candidates, raw: {} as never };
    },
    importWork: async ({ openAlexId }: { openAlexId: string }) => {
      const sourceId = `openalex-${openAlexId.toLowerCase()}`;
      const query = queryByWork.get(openAlexId) ?? "claim evidence";
      const baseSource = structuredClone(goldenRunV02.sources[0]!);
      const texts = [
        `This controlled result directly evaluates ${query} and reports a bounded measurable outcome in the approved setting.`,
        `A second independent passage about ${query} reports the observed mechanism and preserves the study limitations.`,
      ];
      return {
        source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(texts.join("\n\n")), bibliographicMetadata: { ...baseSource.bibliographicMetadata, title: `${query} evidence paper` }, access: { ...baseSource.access, contentScope: "abstract" as const }, rights: { ...baseSource.rights, mayStore: "allowed" as const, mayDisplay: "allowed" as const, maySendToModel: "allowed" as const } },
        chunks: texts.map((text, index) => ({ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-chunk-${index + 1}`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const })),
        warnings: ["Abstract-scoped test source"],
      };
    },
  };
}

describe("automatic research collection", () => {
  it("builds exactly ten dual-model verified passages with claim coverage", async () => {
    let searchIndex = 0;
    const queryByWork = new Map<string, string>();
    const run = focusedRun();
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), evidenceMode: "live" },
      search: async (query) => {
        const offset = ++searchIndex * 10;
        const candidates = [
          candidate(offset + 1, { title: `${query} biodegradable battery environmental sensor study one`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
          candidate(offset + 2, { title: `${query} biodegradable battery environmental sensor study two`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
          candidate(offset + 3, { title: `${query} biodegradable battery environmental sensor study three`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
          candidate(offset + 4, { title: `${query} biodegradable battery environmental sensor study four`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
          candidate(offset + 5, { title: `${query} biodegradable battery environmental sensor study five`, abstract: `${query} direct bounded evidence for a biodegradable battery environmental sensor.` }),
        ];
        for (const work of candidates) queryByWork.set(work.openAlexId, query);
        return { provider: "openalex", query, candidates, raw: {} as never };
      },
      importWork: async ({ openAlexId }) => {
        const sourceId = `openalex-${openAlexId.toLowerCase()}`;
        const query = queryByWork.get(openAlexId) ?? "claim evidence";
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        const texts = [
          `This controlled result directly evaluates ${query} and reports a bounded measurable outcome in the approved setting.`,
          `A second independent passage about ${query} reports the observed mechanism and preserves the study limitations.`,
        ];
        return {
          source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(texts.join("\n\n")), bibliographicMetadata: { ...baseSource.bibliographicMetadata, title: `${query} evidence paper` }, access: { ...baseSource.access, contentScope: "abstract" }, rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } },
          chunks: texts.map((text, index) => ({ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-chunk-${index + 1}`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const })),
          warnings: ["Abstract-scoped test source"],
        };
      },
    });
    expect(result.queries.length).toBeGreaterThanOrEqual(2);
    expect(result.queries.length).toBeLessThanOrEqual(10);
    expect(result.verifiedPassages).toBe(10);
    expect(result.draft.verification?.status).toBe("ready");
    expect(result.claimsMissing).toEqual([]);
    expect(result.draft.sources.length).toBeGreaterThanOrEqual(5);
    expect(result.primaryAudits.every(({ status }) => status === "completed")).toBe(true);
    expect(result.reviewerAudits.every(({ status }) => status === "completed")).toBe(true);
  });

  it("rejects generic high-citation and cross-domain reward-hacking matches", async () => {
    const run = liveRun();
    run.intake.originalQuestion = "Does reward hacking cause agents to optimize proxy rewards instead of intended objectives?";
    run.claims = [{ ...run.claims[0]!, statement: "Reward hacking causes agents to optimize proxy rewards instead of intended objectives.", operationalDefinition: "Observed optimization of a proxy reward with degraded intended-task performance." }];
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), evidenceMode: "live" },
      search: async (query) => ({
        provider: "openalex",
        query,
        candidates: [
          candidate(1, { title: "Defining and Characterizing Reward Hacking", abstract: "Reward hacking causes agents to optimize an imperfect proxy reward, leading to poor performance under the true objective.", citationCount: 21, providerRelevanceScore: 900 }),
          candidate(2, { title: "Generic Survey of Large Language Models", abstract: "A broad survey of artificial intelligence architectures and applications.", citationCount: 5_000, providerRelevanceScore: 100 }),
          candidate(3, { title: "Avoiding reward hacking in molecular design", abstract: "Molecular drug design prediction models exhibit reward hacking during chemical optimization.", citationCount: 2_000, providerRelevanceScore: 700 }),
        ],
        raw: {} as never,
      }),
      importWork: async ({ openAlexId }) => {
        const sourceId = `openalex-${openAlexId.toLowerCase()}`;
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        const title = openAlexId === "W3" ? "Avoiding reward hacking in molecular design" : "Defining and Characterizing Reward Hacking";
        const text = openAlexId === "W3"
          ? "Molecular candidates exploit a chemical property predictor during drug optimization, outside the approved agent-alignment claim."
          : "Optimizing an imperfect proxy reward can decrease performance according to the intended objective, which defines reward hacking.";
        return {
          source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(text), bibliographicMetadata: { ...baseSource.bibliographicMetadata, title }, rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } },
          chunks: [{ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-chunk-1`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const }],
          warnings: [],
        };
      },
    });
    const titles = result.draft.sources.map(({ source }) => source.bibliographicMetadata.title);
    expect(titles).toContain("Defining and Characterizing Reward Hacking");
    expect(titles).not.toContain("Generic Survey of Large Language Models");
    expect(titles).not.toContain("Avoiding reward hacking in molecular design");
    expect(result.blocked).toBe(true);
    expect(result.draft.verification?.status).toBe("evidence_shortfall");
  });

  it("uses NVIDIA for admission and Groq once as the independent reviewer", async () => {
    const dependencies = automaticDependencies();
    const run = focusedRun();
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(result.status).toBe("ready");
    expect(result.providerFailures).toEqual([]);
    expect(result.draft.verification?.passages.every(({ primary, reviewer }) => primary.provider === "nvidia_nim" && reviewer.provider === "groq")).toBe(true);
  });

  it("retries saved passages without repeating search or import work", async () => {
    const dependencies = automaticDependencies();
    const run = focusedRun();
    const first = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: failingAdapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(first.status).toBe("provider_unavailable");
    expect(first.pendingPassages).toBeGreaterThan(0);
    expect(first.rejectionCounts.primaryRejected).toBe(0);
    expect(first.providerFailures.every(({ stage }) => stage === "review")).toBe(true);

    const retried = await collectAutomaticResearchPacket({
      run,
      currentDraft: first.draft,
      mode: "retry_verification",
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: adapter("featherless"), evidenceMode: "live" },
      search: async () => { throw new Error("retry_verification must not search"); },
      importWork: async () => { throw new Error("retry_verification must not import"); },
    });
    expect(retried.status).toBe("ready");
    expect(retried.providerFailures).toEqual([]);
    expect(retried.searchAudits).toEqual([]);
    expect(retried.importAudits).toEqual([]);
    expect(retried.draft.verification?.verificationAttempt).toBe(2);
  });
});
