import * as unpdf from "unpdf";
import { z } from "zod";

import { canonicalSha256, type ResearchRun } from "../../contracts";
import type { StructuredGenerationAdapter } from "../models";
import { configuredResearchAdapters } from "../workflow/durable-coordinator";
import { providerJsonSchema } from "../workflow/run-api";
import { importOpenAlexWork } from "../sources/import-service";
import { addDraftSource, PacketDraftSchema, type PacketDraft } from "../sources/packet-draft";
import { searchScholarlyWorks, type ScholarlyCandidate } from "../sources/openalex";
import { dedupeQueries, preRankCandidates, runResearchWorkerPool, selectEvidencePacket } from "./index";
import { parseResearchConfig, type ResearchConfig } from "./config";
import type { EvidenceCandidate, ResearchWorkItem, WorkerAuditResult } from "./types";

const ratingSchema = z.object({
  openAlexId: z.string().min(1),
  role: z.enum(["support", "challenge"]),
  score: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
}).strict();

const triageOutputSchema = z.object({ ratings: z.array(ratingSchema).min(1).max(6) }).strict();

export const AutomaticCollectionRequestSchema = z.object({
  expectedRevision: z.string().min(1),
  config: z.object({
    target: z.number().int().min(1).max(10).optional(),
    minimum: z.number().int().min(1).max(10).optional(),
    candidateCap: z.number().int().min(10).max(30).optional(),
    sourceDeadlineMs: z.number().int().min(10_000).max(180_000).optional(),
    perItemTimeoutMs: z.number().int().min(2_000).max(20_000).optional(),
    deadlineMs: z.number().int().min(30_000).max(300_000).optional(),
    maxConcurrency: z.number().int().min(1).max(6).optional(),
  }).strict().default({}),
}).strict();

export type AutomaticCollectionResult = {
  draft: PacketDraft;
  queries: string[];
  candidatesConsidered: number;
  selectedCandidateIds: string[];
  skipped: Array<{ id: string; reason: string }>;
  usableSources: number;
  targetSources: number;
  minimumSources: number;
  blocked: boolean;
  durationMs: number;
  searchAudits: Array<WorkerAuditResult<Awaited<ReturnType<typeof searchScholarlyWorks>>>>;
  triageAudits: Array<WorkerAuditResult<TriageBatchResult>>;
  importAudits: Array<WorkerAuditResult<ImportedCandidate>>;
};

type TriageBatch = { candidates: ScholarlyCandidate[] };
type TriageBatchResult = {
  provider: string;
  ratings: z.output<typeof ratingSchema>[];
  attempts: unknown[];
  errors: unknown[];
};
type ImportedCandidate = {
  candidate: EvidenceCandidate;
  imported: Awaited<ReturnType<typeof importOpenAlexWork>>;
};

function buildQueries(run: ResearchRun): string[] {
  return dedupeQueries([
    run.intake.originalQuestion,
    ...run.claims.slice(0, 2).map(({ statement }) => statement),
    `${run.intake.originalQuestion} limitations contradictory evidence`,
  ]).slice(0, 4);
}

function licenseIsEligible(license: string | null): boolean {
  if (!license) return false;
  const normalized = license.trim().toLocaleLowerCase("en-US");
  return normalized === "cc0" || normalized === "public-domain" || normalized.startsWith("cc-by");
}

function candidateRecord(candidate: ScholarlyCandidate, query: string): EvidenceCandidate {
  const eligible = candidate.isOpenAccess && licenseIsEligible(candidate.license);
  return {
    id: candidate.openAlexId,
    url: candidate.landingPageUrl ?? `https://openalex.org/${candidate.openAlexId}`,
    title: candidate.title ?? undefined,
    query,
    role: query.toLocaleLowerCase("en-US").includes("limitation") ? "challenge" : "support",
    score: Math.log10(candidate.citationCount + 1),
    publishedAt: candidate.publicationYear ?? undefined,
    rights: { eligible, basis: eligible ? `OpenAlex license signal: ${candidate.license}` : "No eligible explicit license signal" },
    contentScope: { eligible: candidate.hasAbstract || candidate.isOpenAccess, basis: candidate.hasAbstract ? "OpenAlex abstract reported" : "Open-access full text reported" },
    metadata: { canonicalDoi: candidate.canonicalDoi ?? "", license: candidate.license ?? "", hasAbstract: candidate.hasAbstract },
  };
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function triageBatch(
  adapter: StructuredGenerationAdapter,
  batch: TriageBatch,
  run: ResearchRun,
  signal: AbortSignal,
): Promise<TriageBatchResult> {
  const payload = {
    question: run.intake.originalQuestion,
    application: run.intake.intendedApplication,
    claims: run.claims.map(({ id, statement, operationalDefinition }) => ({ id, statement, operationalDefinition })),
    candidates: batch.candidates.map((candidate) => ({
      openAlexId: candidate.openAlexId,
      title: candidate.title,
      year: candidate.publicationYear,
      doi: candidate.canonicalDoi,
      license: candidate.license,
      hasAbstract: candidate.hasAbstract,
      citations: candidate.citationCount,
    })),
  };
  const messages = [
    {
      role: "system" as const,
      content: "You are a bounded scholarly-source triage worker. Classify each supplied candidate as support or challenge and score likely relevance to the approved claims. Metadata is not evidence. Do not invent passages or omit candidates. Return only JSON matching the schema.",
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  const promptHash = canonicalSha256(messages);
  const generated = await adapter.generate({
    nodeId: `source-triage-${canonicalSha256(batch.candidates.map(({ openAlexId }) => openAlexId)).slice(0, 12)}`,
    inputRefs: batch.candidates.map(({ openAlexId }) => openAlexId),
    outputRefs: [],
    promptId: "automatic-source-triage",
    promptVersion: "1.0.0",
    promptHash,
    schemaVersion: "automatic-source-triage.v1",
    schemaName: "automatic-source-triage-output",
    outputSchema: triageOutputSchema,
    outputJsonSchema: providerJsonSchema(z.toJSONSchema(triageOutputSchema)),
    messages,
    settings: { temperature: 0, maxOutputTokens: 1_200, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
    timeoutMs: 20_000,
    measured: false,
    repairInvalidOutput: true,
    maximumAttempts: 2,
    codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
    signal,
  });
  if (!generated.ok) {
    const failure = generated.errors.at(-1);
    const error = Object.assign(new Error(failure?.message ?? "Source triage failed"), {
      status: failure?.details.httpStatus ?? (failure?.retryable ? 503 : undefined),
    });
    throw error;
  }
  const expected = new Set(batch.candidates.map(({ openAlexId }) => openAlexId));
  const returned = new Set(generated.value.ratings.map(({ openAlexId }) => openAlexId));
  if (expected.size !== returned.size || [...expected].some((id) => !returned.has(id))) {
    throw new Error("Source triage omitted or invented candidate IDs");
  }
  return { provider: adapter.identity.provider, ratings: generated.value.ratings, attempts: [...generated.attempts], errors: [...generated.errors] };
}

export async function collectAutomaticResearchPacket(input: {
  run: ResearchRun;
  currentDraft: unknown;
  config?: Partial<ResearchConfig>;
  openAlexApiKey: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  adapters?: ReturnType<typeof configuredResearchAdapters>;
  search?: typeof searchScholarlyWorks;
  importWork?: typeof importOpenAlexWork;
  now?: () => number;
}): Promise<AutomaticCollectionResult> {
  if (input.run.status !== "collecting_sources") throw new Error("Automatic collection requires the collecting_sources phase");
  const config = parseResearchConfig(input.config ?? {});
  const now = input.now ?? Date.now;
  const startedAt = now();
  const sourceDeadlineAt = startedAt + config.sourceDeadlineMs;
  const phaseDeadlineMs = () => Math.max(1, sourceDeadlineAt - now());
  const queries = buildQueries(input.run);
  const searchPool = await runResearchWorkerPool(queries.map((query, index) => ({ id: `query-${index}`, query })), {
    config: { ...config, maxConcurrency: Math.min(4, config.maxConcurrency), deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: async (item) => (input.search ?? searchScholarlyWorks)(item.query, { apiKey: input.openAlexApiKey, fetch: input.fetch }),
  });
  const discovered = searchPool.results.flatMap((audit) => audit.value?.candidates.map((candidate) => ({ candidate, query: String(audit.value?.query ?? "") })) ?? []);
  const records = preRankCandidates(discovered.map(({ candidate, query }) => candidateRecord(candidate, query))).slice(0, config.candidateCap);
  const candidateById = new Map(discovered.map(({ candidate }) => [candidate.openAlexId, candidate]));
  const triageItems: Array<ResearchWorkItem<TriageBatch>> = batches(records.map(({ id }) => candidateById.get(id)).filter((value): value is ScholarlyCandidate => Boolean(value)), 5)
    .map((candidates, index) => ({ id: `triage-batch-${index}`, query: { candidates } }));
  const adapters = input.adapters ?? configuredResearchAdapters();
  if (adapters.evidenceMode !== "live") throw new Error("Automatic research requires configured live providers");
  const triaged = await runResearchWorkerPool(triageItems, {
    config: { ...config, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: (item, context) => triageBatch(adapters.primary, item.query, input.run, context.signal),
    fallback: (item, _error, context) => triageBatch(adapters.reviewer, item.query, input.run, context.signal),
  });
  const ratings = new Map(triaged.results.flatMap((audit) => audit.value?.ratings ?? []).map((rating) => [rating.openAlexId, rating]));
  const ratedCandidates = records.map((candidate) => {
    const rating = ratings.get(candidate.id);
    return { ...candidate, role: rating?.role ?? candidate.role, score: rating?.score ?? candidate.deterministicScore, metadata: { ...candidate.metadata, triageReason: rating?.reason ?? "Deterministic pre-ranking fallback" } };
  });
  const selected = selectEvidencePacket(ratedCandidates, config);
  const importItems = selected.selected.map((candidate) => ({ id: candidate.id, query: candidate }));
  const imported = await runResearchWorkerPool(importItems, {
    config: { ...config, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: async (item) => {
      const candidate = item.query;
      const license = String(candidate.metadata?.license ?? "explicit-open-license");
      const result = await (input.importWork ?? importOpenAlexWork)({
        openAlexId: candidate.id,
        claims: input.run.claims.map(({ statement }) => statement),
        rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: `Automatic import from ${license}; researcher freeze still required` },
      }, { apiKey: input.openAlexApiKey, fetch: input.fetch, trustedPdfOrigins: ["https://content.openalex.org"], pdfParser: unpdf });
      if (result.chunks.length === 0) throw new Error("Selected source did not yield permitted text");
      const perSourceChunkLimit = Math.max(1, Math.floor(128 / config.target));
      return {
        candidate,
        imported: {
          ...result,
          chunks: result.chunks.slice(0, perSourceChunkLimit),
          warnings: result.chunks.length > perSourceChunkLimit
            ? [...result.warnings, `Automatic packet retained the top ${perSourceChunkLimit} claim-ranked chunks for the global packet limit.`]
            : result.warnings,
        },
      };
    },
  });
  let draft = PacketDraftSchema.parse(input.currentDraft ?? { sources: [] });
  for (const audit of imported.results) {
    if (!audit.value) continue;
    draft = addDraftSource(draft, { source: audit.value.imported.source, chunks: audit.value.imported.chunks, importedAt: new Date(audit.finishedAt).toISOString() });
  }
  const usableSources = draft.sources.filter(({ chunks }) => chunks.length > 0).length;
  return {
    draft,
    queries,
    candidatesConsidered: records.length,
    selectedCandidateIds: selected.selected.map(({ id }) => id),
    skipped: [...selected.rejected.map(({ candidate, reason }) => ({ id: candidate.id, reason })), ...imported.results.filter((audit) => !audit.value).map((audit) => ({ id: audit.itemId, reason: audit.status }))],
    usableSources,
    targetSources: config.target,
    minimumSources: config.minimum,
    blocked: usableSources < config.minimum,
    durationMs: now() - startedAt,
    searchAudits: searchPool.results,
    triageAudits: triaged.results,
    importAudits: imported.results,
  };
}
