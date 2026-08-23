import { describe, expect, it } from "vitest";

import { canonicalSha256, NodeExecutionSchema, RunErrorSchema, type ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import type { StructuredGenerationAdapter, StructuredGenerationRequest } from "../../src/server/models";
import { MODEL_BATCH_MAX_ITEMS, collectAutomaticResearchPacket } from "../../src/server/research/live-collection";
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

function automaticDependencies(candidatesPerQuery = 5) {
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
      ].slice(0, candidatesPerQuery);
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
        source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(texts.join("\n\n")), bibliographicMetadata: { ...baseSource.bibliographicMetadata, title: `${query} evidence paper ${openAlexId}` }, access: { ...baseSource.access, contentScope: "abstract" as const }, rights: { ...baseSource.rights, mayStore: "allowed" as const, mayDisplay: "allowed" as const, maySendToModel: "allowed" as const } },
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

  it("uses the configured primary for admission and NVIDIA as the independent reviewer", async () => {
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
    expect(result.draft.verification?.passages.every(({ primary, reviewer }) => primary.provider === "groq" && reviewer.provider === "nvidia_nim")).toBe(true);
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
    expect(first.providerFailures.every(({ stage }) => stage === "primary_admission")).toBe(true);

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
    expect(retried.providerFailures.length).toBeGreaterThan(0);
    expect(retried.draft.verification?.status).toBe("ready");
    expect(retried.searchAudits).toEqual([]);
    expect(retried.importAudits).toEqual([]);
    expect(retried.draft.verification?.verificationAttempt).toBe(2);
  });

  it("preserves prior verified passages during deeper search and can become ready", async () => {
    const dependencies = automaticDependencies(2);
    const run = focusedRun();
    const first = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(first.status).toBe("evidence_shortfall");
    expect(first.verifiedPassages).toBe(8);
    const priorIds = new Set(first.draft.verification?.passages.map(({ id }) => id));

    const deeper = await collectAutomaticResearchPacket({
      run,
      currentDraft: first.draft,
      mode: "deeper",
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(deeper.status).toBe("ready");
    expect(deeper.verifiedPassages).toBe(10);
    expect([...priorIds].every((id) => deeper.draft.verification?.passages.some((passage) => passage.id === id))).toBe(true);
    expect(deeper.draft.verification?.verificationAttempt).toBe(2);
  });

  it("preserves successful batches across a partial provider failure and retry", async () => {
    const dependencies = automaticDependencies(2);
    const run = focusedRun();
    const baseReviewer = adapter("nvidia_nim");
    const failedReviewer = failingAdapter("nvidia_nim");
    const selectiveReviewer: StructuredGenerationAdapter = {
      ...baseReviewer,
      async generate(request) {
        if (request.promptId === "dual-evidence-admission-review") {
          const payload = JSON.parse(request.messages.at(-1)!.content) as { passages: Array<{ sourceTitle: string }> };
          if (payload.passages.some(({ sourceTitle }) => /W22/u.test(sourceTitle))) return failedReviewer.generate(request);
        }
        return baseReviewer.generate(request);
      },
    };
    const first = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: selectiveReviewer, fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(first.verifiedPassages).toBeGreaterThan(0);
    expect(first.pendingPassages).toBeGreaterThan(0);
    const preserved = new Set(first.draft.verification?.passages.map(({ id }) => id));

    const retried = await collectAutomaticResearchPacket({
      run,
      currentDraft: first.draft,
      mode: "retry_verification",
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
    });
    expect([...preserved].every((id) => retried.draft.verification?.passages.some((passage) => passage.id === id))).toBe(true);
    expect(retried.verifiedPassages).toBeGreaterThanOrEqual(first.verifiedPassages);
  });

  it("does not let a failed extra batch block ten already verified passages", async () => {
    const dependencies = automaticDependencies();
    const run = focusedRun();
    const baseReviewer = adapter("nvidia_nim");
    const failedReviewer = failingAdapter("nvidia_nim");
    const selectiveReviewer: StructuredGenerationAdapter = {
      ...baseReviewer,
      async generate(request) {
        if (request.promptId === "dual-evidence-admission-review") {
          const payload = JSON.parse(request.messages.at(-1)!.content) as { passages: Array<{ sourceTitle: string }> };
          if (payload.passages.some(({ sourceTitle }) => /W25/u.test(sourceTitle))) return failedReviewer.generate(request);
        }
        return baseReviewer.generate(request);
      },
    };
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: selectiveReviewer, fallback: null, evidenceMode: "live" },
      ...dependencies,
    });
    expect(result.verifiedPassages).toBe(10);
    expect(result.status).toBe("ready");
    expect(result.providerFailures.length).toBeGreaterThan(0);
  });

  it("retains selected and pending chunks from the same source", async () => {
    const run = focusedRun();
    const baseReviewer = adapter("nvidia_nim");
    const failedReviewer = failingAdapter("nvidia_nim");
    const selectiveReviewer: StructuredGenerationAdapter = {
      ...baseReviewer,
      async generate(request) {
        if (request.promptId === "dual-evidence-admission-review") {
          const payload = JSON.parse(request.messages.at(-1)!.content) as { passages: Array<{ excerpt: string }> };
          if (payload.passages.some(({ excerpt }) => excerpt.includes("second unresolved"))) return failedReviewer.generate(request);
        }
        return baseReviewer.generate(request);
      },
    };
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: selectiveReviewer, fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [candidate(1, { title: `${query} direct study`, abstract: `${query} direct bounded evidence` })], raw: {} as never }),
      importWork: async ({ openAlexId }) => {
        const sourceId = `openalex-${openAlexId.toLowerCase()}`;
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        const texts = [
          "This first controlled passage reports claim evidence in a bounded empirical setting.",
          "This second unresolved passage reports claim evidence and a separate bounded outcome.",
        ];
        return { source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(texts.join("\n\n")), rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } }, chunks: texts.map((text, index) => ({ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-stable-${index}`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const })), warnings: [] };
      },
    });
    expect(result.status).toBe("provider_unavailable");
    expect(result.draft.sources).toHaveLength(1);
    expect(result.draft.sources[0]?.chunks).toHaveLength(2);
    expect(result.draft.verification?.passages).toHaveLength(1);
    expect(result.draft.verification?.pendingPassages).toHaveLength(1);
  });

  it("attributes distinct passages from one work to two claims", async () => {
    const run = liveRun();
    run.claims = [
      { ...run.claims[0]!, id: "claim-storage", statement: "Biodegradable batteries reduce persistent storage waste.", operationalDefinition: "Lower persistent material after disposal." },
      { ...run.claims[0]!, id: "claim-sensor", statement: "Environmental sensors retain reliable field measurements.", operationalDefinition: "Stable measurement accuracy in field deployment." },
    ];
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [candidate(77, { title: `${query} biodegradable battery environmental sensor`, abstract: `${query} storage waste and reliable field measurement evidence` })], raw: {} as never }),
      importWork: async ({ openAlexId }) => {
        const sourceId = `openalex-${openAlexId.toLowerCase()}`;
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        const texts = [
          "Biodegradable battery materials reduced persistent storage waste after disposal in the reported evaluation.",
          "Environmental sensors retained reliable field measurement accuracy throughout the reported deployment.",
        ];
        return { source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(texts.join("\n\n")), rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } }, chunks: texts.map((text, index) => ({ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-distinct-${index}`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const })), warnings: [] };
      },
    });
    expect(new Set(result.draft.verification?.passages.map(({ subclaimId }) => subclaimId))).toEqual(new Set(["claim-storage", "claim-sensor"]));
    expect(result.draft.sources).toHaveLength(1);
  });

  it("allows a relevant paraphrase through deterministic triage", async () => {
    const run = liveRun();
    run.intake.originalQuestion = "Does reward hacking cause agents to optimize proxy rewards instead of intended objectives?";
    run.claims = [{ ...run.claims[0]!, statement: "Reward hacking causes agents to optimize proxy rewards instead of intended objectives.", operationalDefinition: "Agents exploit proxy feedback while intended goal performance degrades." }];
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [candidate(90, { title: "Agents exploit proxy feedback and fail intended goals", abstract: "Policies maximize surrogate feedback while performance on the intended objective degrades." })], raw: {} as never }),
      importWork: async ({ openAlexId }) => {
        const sourceId = `openalex-${openAlexId.toLowerCase()}`;
        const text = "Agents exploit proxy feedback and maximize surrogate signals while performance on the intended objective degrades.";
        const baseSource = structuredClone(goldenRunV02.sources[0]!);
        return { source: { ...baseSource, id: sourceId, contentHash: canonicalSha256(text), rights: { ...baseSource.rights, mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" } }, chunks: [{ ...structuredClone(goldenRunV02.chunks[0]!), id: `${sourceId}-paraphrase`, sourceId, text, contentHash: canonicalSha256(text), displayPermission: "allowed" as const }], warnings: [] };
      },
    });
    expect(result.draft.sources).toHaveLength(1);
    expect(result.rejectionCounts.offTopic).toBe(0);
  });

  it("reports raw OpenAlex failure as provider_unavailable but valid empty results as a shortfall", async () => {
    const run = focusedRun();
    const failed = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [], raw: { status: "failed", failureCode: "rate_limited", pagination: { pagesFetched: 0, truncated: true } } as never }),
    });
    expect(failed.status).toBe("provider_unavailable");
    expect(failed.providerFailures.some(({ stage, code }) => stage === "search" && code === "rate_limited")).toBe(true);

    const empty = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [], raw: { status: "completed", failureCode: null, pagination: { pagesFetched: 1, truncated: false } } as never }),
    });
    expect(empty.status).toBe("evidence_shortfall");
  });

  it("splits reviewer requests by the bounded item budget", async () => {
    const dependencies = automaticDependencies();
    const run = focusedRun();
    const observed: number[] = [];
    const reviewer = adapter("nvidia_nim");
    const observingReviewer: StructuredGenerationAdapter = {
      ...reviewer,
      async generate(request) {
        if (request.promptId === "dual-evidence-admission-review") {
          const payload = JSON.parse(request.messages.at(-1)!.content) as { passages: unknown[] };
          observed.push(payload.passages.length);
        }
        return reviewer.generate(request);
      },
    };
    await collectAutomaticResearchPacket({ run, currentDraft: { sources: [] }, openAlexApiKey: "test-key", adapters: { primary: adapter("groq"), reviewer: observingReviewer, fallback: null, evidenceMode: "live" }, ...dependencies });
    expect(observed.length).toBeGreaterThan(1);
    expect(Math.max(...observed)).toBeLessThanOrEqual(MODEL_BATCH_MAX_ITEMS);
  });

  it("keeps source and overall deadlines separate", async () => {
    const dependencies = automaticDependencies();
    const run = focusedRun();
    const observedSourceDeadlines: number[] = [];
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "test-key",
      config: { sourceDeadlineMs: 1_000, deadlineMs: 30_000, perItemTimeoutMs: 10_000 },
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      ...dependencies,
      search: async (query, options) => {
        observedSourceDeadlines.push(options.limits?.deadlineMs ?? 0);
        return dependencies.search(query);
      },
    });
    expect(Math.max(...observedSourceDeadlines)).toBeLessThanOrEqual(1_000);
    expect(result.primaryAudits.length).toBeGreaterThan(0);
  });

  it("accepts technical evidence without fabricating a sample", async () => {
    const dependencies = automaticDependencies(1);
    const run = focusedRun();
    const technical = (provider: TestProvider): StructuredGenerationAdapter => {
      const base = adapter(provider);
      return {
        ...base,
        async generate(request) {
          if (request.promptId === "autonomous-evidence-query-plan") return base.generate(request);
          const payload = JSON.parse(request.messages.at(-1)!.content) as { passages: Array<{ proposalId: string; proposedClaimId: string }> };
          const value = request.outputSchema.parse({ reviews: payload.passages.map((passage) => ({ proposalId: passage.proposalId, accepted: true, matchedClaimId: passage.proposedClaimId, likelyRole: "support", relevance: 0.96, directness: 0.94, extractedResult: "The technical analysis establishes the bounded mechanism.", sourceType: "technical", settingAndSample: null, studyType: "technical analysis", limitation: "No empirical population is claimed.", extractionIssues: [], reason: "Direct technical evidence." })) });
          return { ok: true as const, value, attempts: [execution(request, provider)], errors: [] } as never;
        },
      };
    };
    const result = await collectAutomaticResearchPacket({ run, currentDraft: { sources: [] }, openAlexApiKey: "test-key", adapters: { primary: technical("groq"), reviewer: technical("nvidia_nim"), fallback: null, evidenceMode: "live" }, ...dependencies });
    expect(result.draft.verification?.passages.length).toBeGreaterThan(0);
    expect(result.draft.verification?.passages.every(({ sourceType, settingAndSample }) => sourceType === "technical" && settingAndSample === null)).toBe(true);
  });

  it("uses licensed Firecrawl results alongside valid-empty OpenAlex discovery", async () => {
    const run = focusedRun();
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "openalex-test",
      firecrawlApiKey: "firecrawl-test",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [], raw: { status: "completed", failureCode: null, pagination: { pagesFetched: 1, truncated: false } } as never }),
      webSearch: async (query) => ({
        provider: "firecrawl",
        query,
        candidates: [{ id: "firecrawl-licensed-source", url: "https://research.example/licensed", title: `${query} licensed technical report`, description: `${query} direct evidence`, markdown: `This licensed report directly evaluates ${query} and reports a bounded outcome.\n\nA second licensed passage explains the mechanism for ${query} and its limitations.`, category: "research", license: "CC BY 4.0", canonicalDoi: null, authors: ["Researcher"], publicationYear: 2025, rightsEligible: true }],
        raw: { status: "completed", failureCode: null, httpStatus: 200, pagination: { pagesFetched: 1, truncated: false } },
      }),
    });
    expect(result.draft.sources).toEqual([expect.objectContaining({ source: expect.objectContaining({ id: "firecrawl-licensed-source", access: expect.objectContaining({ provider: "firecrawl" }) }) })]);
    expect(result.draft.verification?.passages.length).toBeGreaterThan(0);
    expect(result.draft.verification?.searchAudits.some(({ provider }) => provider === "firecrawl")).toBe(true);
  });

  it("surfaces Firecrawl provider failure without relabeling valid-empty OpenAlex as a shortfall", async () => {
    const run = focusedRun();
    const result = await collectAutomaticResearchPacket({
      run,
      currentDraft: { sources: [] },
      openAlexApiKey: "openalex-test",
      firecrawlApiKey: "firecrawl-test",
      adapters: { primary: adapter("groq"), reviewer: adapter("nvidia_nim"), fallback: null, evidenceMode: "live" },
      search: async (query) => ({ provider: "openalex", query, candidates: [], raw: { status: "completed", failureCode: null, pagination: { pagesFetched: 1, truncated: false } } as never }),
      webSearch: async (query) => ({ provider: "firecrawl", query, candidates: [], raw: { status: "failed", failureCode: "rate_limited", httpStatus: 429, pagination: { pagesFetched: 0, truncated: false } } }),
    });
    expect(result.status).toBe("provider_unavailable");
    expect(result.providerFailures.some(({ provider, code }) => provider === "firecrawl" && code === "rate_limited")).toBe(true);
  });
});
