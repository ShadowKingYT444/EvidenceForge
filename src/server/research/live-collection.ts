import * as unpdf from "unpdf";
import { z } from "zod";

import {
  canonicalSha256,
  type NodeExecution,
  type ResearchRun,
} from "../../contracts";
import type {
  StructuredGenerationAdapter,
  StructuredGenerationResult,
} from "../models";
import { configuredResearchAdapters } from "../workflow/durable-coordinator";
import { providerJsonSchema } from "../workflow/run-api";
import { importOpenAlexWork } from "../sources/import-service";
import {
  PacketDraftSchema,
  PlannedResearchQuerySchema,
  VERIFIED_PASSAGE_TARGET,
  type PacketDraft,
} from "../sources/packet-draft";
import {
  searchScholarlyWorks,
  type ScholarlyCandidate,
} from "../sources/openalex";
import {
  dedupeQueries,
  preRankCandidates,
  runResearchWorkerPool,
} from "./index";
import { parseResearchConfig, type ResearchConfig } from "./config";
import type {
  EvidenceCandidate,
  ResearchWorkItem,
  WorkerAuditResult,
} from "./types";

const MINIMUM_RELEVANCE = 0.8;
const MINIMUM_DIRECTNESS = 0.7;
const MAX_IMPORTED_SOURCES = 20;
const MAX_PASSAGE_PROPOSALS = 15;
const PRIMARY_BATCH_SIZE = 15;
const REVIEW_BATCH_SIZE = 5;
const MAX_PASSAGES_PER_SOURCE = 2;

const queryPlanOutputSchema = z.object({
  queries: z.array(PlannedResearchQuerySchema).min(2).max(10),
}).strict();

const passageReviewSchema = z.object({
  proposalId: z.string().min(1),
  accepted: z.boolean(),
  matchedClaimId: z.string().min(1).nullable(),
  likelyRole: z.enum(["support", "challenge"]).nullable(),
  relevance: z.number().min(0).max(1),
  directness: z.number().min(0).max(1),
  extractedResult: z.string().min(1).max(1_000).nullable(),
  settingAndSample: z.string().min(1).max(500).nullable(),
  studyType: z.string().min(1).max(200).nullable(),
  limitation: z.string().min(1).max(500).nullable(),
  extractionIssues: z.array(z.string().min(1).max(300)).max(8),
  reason: z.string().min(1).max(500),
}).strict().superRefine((review, context) => {
  if (!review.accepted) return;
  for (const [field, value] of [
    ["matchedClaimId", review.matchedClaimId],
    ["likelyRole", review.likelyRole],
    ["extractedResult", review.extractedResult],
    ["settingAndSample", review.settingAndSample],
    ["studyType", review.studyType],
    ["limitation", review.limitation],
  ] as const) {
    if (value === null) context.addIssue({ code: "custom", path: [field], message: `${field} is required when accepted` });
  }
});

const passageReviewOutputSchema = z.object({
  reviews: z.array(passageReviewSchema).min(1).max(PRIMARY_BATCH_SIZE),
}).strict();

export const AutomaticCollectionRequestSchema = z.object({
  expectedRevision: z.string().min(1),
  mode: z.enum(["initial", "deeper"]).default("initial"),
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

type PlannedQuery = z.output<typeof PlannedResearchQuerySchema>;
type PassageReview = z.output<typeof passageReviewSchema>;
type PassageGeneration = StructuredGenerationResult<typeof passageReviewOutputSchema>;
type RunError = ResearchRun["errors"][number];

type PassageProposal = {
  id: string;
  claimId: string;
  sourceId: string;
  sourceChunkId: string;
  sourceTitle: string;
  excerpt: string;
  queryId: string;
  sourceHash: string;
  chunkHash: string;
};

type PassageEvaluationResult = {
  provider: string;
  reviews: PassageReview[];
  attempts: readonly NodeExecution[];
  errors: readonly RunError[];
};

type ImportedCandidate = {
  candidate: EvidenceCandidate;
  imported: Awaited<ReturnType<typeof importOpenAlexWork>>;
};

type RejectionCounts = {
  offTopic: number;
  noPermittedText: number;
  rightsIneligible: number;
  primaryRejected: number;
  reviewerRejected: number;
  providerFailure: number;
  literalValidationFailed: number;
  duplicate: number;
};

export type AutomaticCollectionResult = {
  draft: PacketDraft;
  queries: PlannedQuery[];
  candidatesConsidered: number;
  selectedCandidateIds: string[];
  skipped: Array<{ id: string; reason: string }>;
  usableSources: number;
  targetSources: number;
  minimumSources: number;
  verifiedPassages: number;
  targetPassages: typeof VERIFIED_PASSAGE_TARGET;
  claimsCovered: string[];
  claimsMissing: string[];
  roundsCompleted: number;
  rejectionCounts: RejectionCounts;
  plannerFallbackUsed: boolean;
  blocked: boolean;
  durationMs: number;
  searchAudits: Array<WorkerAuditResult<Awaited<ReturnType<typeof searchScholarlyWorks>>>>;
  primaryAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  triageAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  reviewerAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  importAudits: Array<WorkerAuditResult<ImportedCandidate>>;
};

class CollectionGenerationFailure extends Error {
  constructor(readonly generation: PassageGeneration) {
    super(generation.errors.at(-1)?.message ?? "Passage evaluation failed");
    this.name = "CollectionGenerationFailure";
  }
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "in", "is", "it", "of", "on", "or", "that", "the", "to", "was", "were", "with",
]);

function terms(value: string): string[] {
  return value
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]{2,}/gu)
    ?.filter((term) => term.length > 2 && !STOP_WORDS.has(term)) ?? [];
}

function compactQuery(value: string): string {
  return [...new Set(terms(value))].slice(0, 6).join(" ");
}

function deterministicQueryPlan(run: ResearchRun): PlannedQuery[] {
  const direct = run.claims.flatMap((claim) => {
    const base = compactQuery(claim.statement);
    const query = base || compactQuery(run.intake.originalQuestion);
    const anchors = [query.split(" ").slice(0, 2).join(" "), ...terms(claim.statement).slice(0, 4)]
      .filter((value) => value.length > 1)
      .slice(0, 6);
    return [
      { id: `query-${claim.id}-direct`, claimId: claim.id, query, intent: "direct" as const, anchors, round: 1 },
      { id: `query-${claim.id}-challenge`, claimId: claim.id, query: `${query} limitation failure`, intent: "challenge" as const, anchors, round: 2 },
    ];
  });
  const unique = dedupeQueries(direct.map(({ query }) => query));
  return direct.filter(({ query }) => unique.includes(query)).slice(0, 10);
}

async function generateQueryPlan(
  run: ResearchRun,
  adapters: ReturnType<typeof configuredResearchAdapters>,
  mode: "initial" | "deeper",
  signal?: AbortSignal,
): Promise<{ queries: PlannedQuery[]; fallbackUsed: boolean }> {
  const payload = {
    question: run.intake.originalQuestion,
    application: run.intake.intendedApplication,
    mode,
    claims: run.claims.map(({ id, statement, operationalDefinition }) => ({ id, statement, operationalDefinition })),
  };
  const messages = [
    {
      role: "system" as const,
      content: "Plan compact scholarly searches for the approved claims. Each query must be a 2-8 term domain phrase, never a sentence. Include direct and limitation/counterevidence searches, claim IDs, concrete concept anchors, and rounds 1-3. Return only JSON matching the schema.",
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  for (const adapter of [adapters.reviewer, adapters.primary]) {
    const generated = await adapter.generate({
      nodeId: "plan-evidence-search",
      inputRefs: run.claims.map(({ id }) => id),
      outputRefs: [],
      promptId: "autonomous-evidence-query-plan",
      promptVersion: "1.0.0",
      promptHash: canonicalSha256(messages),
      schemaVersion: "autonomous-evidence-query-plan.v1",
      schemaName: "autonomous-evidence-query-plan-output",
      outputSchema: queryPlanOutputSchema,
      outputJsonSchema: providerJsonSchema(z.toJSONSchema(queryPlanOutputSchema)),
      messages,
      settings: { temperature: 0, maxOutputTokens: 1_600, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
      timeoutMs: 20_000,
      measured: false,
      repairInvalidOutput: true,
      maximumAttempts: 2,
      codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
      signal,
    });
    if (!generated.ok) continue;
    const knownClaims = new Set(run.claims.map(({ id }) => id));
    const seen = new Set<string>();
    const queries = generated.value.queries.filter((query) => {
      const normalized = query.query.trim().toLocaleLowerCase("en-US");
      const queryTerms = terms(query.query);
      if (!knownClaims.has(query.claimId) || queryTerms.length < 2 || queryTerms.length > 8 || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    if (queries.length >= 2) return { queries, fallbackUsed: adapter !== adapters.reviewer };
  }
  return { queries: deterministicQueryPlan(run), fallbackUsed: true };
}

function licenseIsEligible(license: string | null): boolean {
  if (!license) return false;
  const normalized = license.trim().toLocaleLowerCase("en-US");
  return normalized === "cc0" || normalized === "public-domain" || normalized.startsWith("cc-by");
}

function normalizedProviderScore(score: number | null): number {
  if (score === null || !Number.isFinite(score) || score <= 0) return 0;
  return score / (score + 100);
}

function candidateRecord(candidate: ScholarlyCandidate, plan: PlannedQuery, rank: number): EvidenceCandidate {
  const eligible = candidate.isOpenAccess && licenseIsEligible(candidate.license);
  return {
    id: candidate.openAlexId,
    url: candidate.landingPageUrl ?? `https://openalex.org/${candidate.openAlexId}`,
    title: candidate.title ?? undefined,
    abstract: candidate.abstract ?? undefined,
    query: plan.query,
    role: plan.intent === "challenge" ? "challenge" : "support",
    rank,
    score: normalizedProviderScore(candidate.providerRelevanceScore),
    publishedAt: candidate.publicationYear ?? undefined,
    rights: { eligible, basis: eligible ? `OpenAlex license signal: ${candidate.license}` : "No eligible explicit license signal" },
    contentScope: { eligible: Boolean(candidate.abstract) || candidate.isOpenAccess, basis: candidate.abstract ? "OpenAlex abstract available" : "Open-access full text reported" },
    metadata: {
      canonicalDoi: candidate.canonicalDoi ?? "",
      license: candidate.license ?? "",
      hasAbstract: candidate.hasAbstract,
      citations: candidate.citationCount,
      providerRelevanceScore: candidate.providerRelevanceScore,
      queryId: plan.id,
      claimId: plan.claimId,
      anchors: plan.anchors,
      intent: plan.intent,
    },
  };
}

function anchorMatch(candidate: EvidenceCandidate): boolean {
  const text = `${candidate.title ?? ""} ${candidate.abstract ?? ""}`.toLocaleLowerCase("en-US");
  const anchors = Array.isArray(candidate.metadata?.anchors)
    ? candidate.metadata.anchors.filter((value): value is string => typeof value === "string")
    : [];
  if (anchors.some((anchor) => text.includes(anchor.toLocaleLowerCase("en-US")))) return true;
  const anchorTerms = new Set(anchors.flatMap(terms));
  let matches = 0;
  for (const term of anchorTerms) if (text.includes(term) && ++matches >= 2) return true;
  return false;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function excerptFromChunk(text: string): string | null {
  const literal = text.trim();
  if (literal.length < 40) return null;
  if (literal.length <= 1_200) return literal;
  const clipped = literal.slice(0, 1_200);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > 1_000 ? boundary : 1_200).trim();
}

function passageProposals(imported: readonly WorkerAuditResult<ImportedCandidate>[]): PassageProposal[] {
  const proposals: PassageProposal[] = [];
  const seen = new Set<string>();
  for (const audit of imported) {
    if (!audit.value) continue;
    const { candidate, imported: sourceImport } = audit.value;
    const claimId = String(candidate.metadata?.claimId ?? "");
    const queryId = String(candidate.metadata?.queryId ?? "");
    for (const chunk of sourceImport.chunks.slice(0, 4)) {
      const excerpt = excerptFromChunk(chunk.text);
      if (!excerpt) continue;
      const id = `proposal-${canonicalSha256({ claimId, sourceChunkId: chunk.id, excerpt })}`;
      if (seen.has(id)) continue;
      seen.add(id);
      proposals.push({
        id,
        claimId,
        sourceId: sourceImport.source.id,
        sourceChunkId: chunk.id,
        sourceTitle: sourceImport.source.bibliographicMetadata.title,
        excerpt,
        queryId,
        sourceHash: sourceImport.source.contentHash,
        chunkHash: chunk.contentHash,
      });
    }
  }
  const balanced: PassageProposal[] = [];
  const add = (proposal: PassageProposal) => {
    if (balanced.length < MAX_PASSAGE_PROPOSALS && !balanced.some(({ id }) => id === proposal.id)) balanced.push(proposal);
  };
  for (const claimId of [...new Set(proposals.map(({ claimId }) => claimId))].sort()) {
    for (const proposal of proposals.filter((candidate) => candidate.claimId === claimId).slice(0, 2)) add(proposal);
  }
  for (const proposal of proposals) add(proposal);
  return balanced;
}

async function evaluatePassageBatch(input: {
  adapter: StructuredGenerationAdapter;
  run: ResearchRun;
  batch: PassageProposal[];
  batchId: string;
  reviewer: boolean;
  primary?: PassageReview[];
  signal: AbortSignal;
}): Promise<PassageEvaluationResult> {
  const payload = {
    question: input.run.intake.originalQuestion,
    application: input.run.intake.intendedApplication,
    claims: input.run.claims.map(({ id, statement, operationalDefinition }) => ({ id, statement, operationalDefinition })),
    passages: input.batch.map(({ id, claimId, sourceTitle, excerpt }) => ({ proposalId: id, proposedClaimId: claimId, sourceTitle, excerpt })),
    primaryReviews: input.primary ?? [],
  };
  const messages = [
    {
      role: "system" as const,
      content: input.reviewer
        ? "Independently audit every supplied literal passage for direct relevance to exactly one approved claim. Reject generic background, mere keyword mentions, cross-domain homonyms, and passages that do not bear on the claim. Do not defer to the primary review. For rejected passages set matchedClaimId, likelyRole, extractedResult, settingAndSample, studyType, and limitation to null. Return every proposal ID exactly once and only JSON matching the schema."
        : "Judge every supplied literal passage against the approved claims. Accept only passages that directly bear on a claim; reject generic background, keyword-only matches, and cross-domain homonyms. Describe only what the passage literally reports and preserve limitations. For rejected passages set matchedClaimId, likelyRole, extractedResult, settingAndSample, studyType, and limitation to null. Return every proposal ID exactly once as JSON matching the schema.",
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  const nodeId = input.reviewer ? `extract-evidence:review-draft-${input.batchId}` : `extract-evidence:draft-${input.batchId}`;
  const generated = await input.adapter.generate({
    nodeId,
    inputRefs: input.batch.map(({ id }) => id),
    outputRefs: [],
    promptId: input.reviewer ? "dual-evidence-admission-review" : "claim-grounded-passage-admission",
    promptVersion: "1.0.0",
    promptHash: canonicalSha256(messages),
    schemaVersion: "claim-grounded-passage-admission.v1",
    schemaName: "claim-grounded-passage-admission-output",
    outputSchema: passageReviewOutputSchema,
    outputJsonSchema: providerJsonSchema(z.toJSONSchema(passageReviewOutputSchema)),
    messages,
    settings: { temperature: 0, maxOutputTokens: 5_000, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
    timeoutMs: 20_000,
    measured: false,
    repairInvalidOutput: true,
    maximumAttempts: 2,
    codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
    signal: input.signal,
  });
  if (!generated.ok) throw new CollectionGenerationFailure(generated);
  const expected = new Set(input.batch.map(({ id }) => id));
  const returned = new Set(generated.value.reviews.map(({ proposalId }) => proposalId));
  if (returned.size !== expected.size || [...expected].some((id) => !returned.has(id))) {
    throw new CollectionGenerationFailure(generated);
  }
  return {
    provider: input.adapter.identity.provider,
    reviews: generated.value.reviews,
    attempts: generated.attempts,
    errors: generated.errors,
  };
}

function generationAudit(audits: readonly WorkerAuditResult<PassageEvaluationResult>[]): { attempts: NodeExecution[]; errors: RunError[] } {
  const attempts: NodeExecution[] = [];
  const errors: RunError[] = [];
  for (const audit of audits) {
    if (audit.value) {
      attempts.push(...audit.value.attempts);
      errors.push(...audit.value.errors);
    } else if (audit.error instanceof CollectionGenerationFailure) {
      attempts.push(...audit.error.generation.attempts);
      errors.push(...audit.error.generation.errors);
    }
  }
  return { attempts, errors };
}

function selectVerifiedPassages<T extends { id: string; subclaimId: string; sourceId: string; selectionScore: number }>(
  passages: readonly T[],
  claimIds: readonly string[],
): T[] {
  const ranked = [...passages].sort((left, right) => right.selectionScore - left.selectionScore || left.id.localeCompare(right.id));
  const selected: T[] = [];
  const sourceCounts = new Map<string, number>();
  const add = (passage: T | undefined) => {
    if (!passage || selected.length >= VERIFIED_PASSAGE_TARGET || selected.some(({ id }) => id === passage.id)) return;
    if ((sourceCounts.get(passage.sourceId) ?? 0) >= MAX_PASSAGES_PER_SOURCE) return;
    selected.push(passage);
    sourceCounts.set(passage.sourceId, (sourceCounts.get(passage.sourceId) ?? 0) + 1);
  };
  for (const claimId of claimIds) add(ranked.find(({ subclaimId }) => subclaimId === claimId));
  for (const passage of ranked) add(passage);
  return selected;
}

export async function collectAutomaticResearchPacket(input: {
  run: ResearchRun;
  currentDraft: unknown;
  mode?: "initial" | "deeper";
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
  const adapters = input.adapters ?? configuredResearchAdapters();
  if (adapters.evidenceMode !== "live") throw new Error("Automatic research requires configured live providers");
  const now = input.now ?? Date.now;
  const startedAt = now();
  const sourceDeadlineAt = startedAt + config.sourceDeadlineMs;
  const phaseDeadlineMs = () => Math.max(1, sourceDeadlineAt - now());
  const plan = await generateQueryPlan(input.run, adapters, input.mode ?? "initial", input.signal);

  const searchPool = await runResearchWorkerPool(
    plan.queries.map((query) => ({ id: query.id, query })),
    {
      config: { ...config, target: plan.queries.length, minimum: 1, candidateCap: Math.max(1, Math.min(30, plan.queries.length)), maxConcurrency: Math.min(4, config.maxConcurrency), deadlineMs: phaseDeadlineMs() },
      signal: input.signal,
      worker: async (item) => (input.search ?? searchScholarlyWorks)(item.query.query, { apiKey: input.openAlexApiKey, fetch: input.fetch }),
    },
  );

  const planById = new Map(plan.queries.map((query) => [query.id, query]));
  const recordById = new Map<string, EvidenceCandidate>();
  for (const audit of searchPool.results) {
    if (!audit.value) continue;
    const queryPlan = planById.get(audit.itemId);
    if (!queryPlan) continue;
    audit.value.candidates.forEach((candidate, index) => {
      const record = candidateRecord(candidate, queryPlan, index + 1);
      const prior = recordById.get(record.id);
      if (!prior || (record.score ?? 0) > (prior.score ?? 0)) recordById.set(record.id, record);
    });
  }

  const rejectionCounts: RejectionCounts = {
    offTopic: 0,
    noPermittedText: 0,
    rightsIneligible: 0,
    primaryRejected: 0,
    reviewerRejected: 0,
    providerFailure: 0,
    literalValidationFailed: 0,
    duplicate: 0,
  };
  const eligible: EvidenceCandidate[] = [];
  for (const candidate of recordById.values()) {
    if (candidate.rights?.eligible !== true) {
      rejectionCounts.rightsIneligible += 1;
      continue;
    }
    if (candidate.contentScope?.eligible !== true) {
      rejectionCounts.noPermittedText += 1;
      continue;
    }
    if (!anchorMatch(candidate)) {
      rejectionCounts.offTopic += 1;
      continue;
    }
    eligible.push(candidate);
  }
  const records = preRankCandidates(eligible).slice(0, MAX_IMPORTED_SOURCES);

  const importItems = records.map((candidate) => ({ id: candidate.id, query: candidate }));
  const imported = await runResearchWorkerPool(importItems, {
    config: { ...config, target: Math.max(1, importItems.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, importItems.length)), deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: async (item) => {
      const candidate = item.query;
      const license = String(candidate.metadata?.license ?? "");
      const result = await (input.importWork ?? importOpenAlexWork)({
        openAlexId: candidate.id,
        claims: input.run.claims.map(({ statement }) => statement),
        rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: `Automatic import from ${license}; researcher freeze still required` },
      }, { apiKey: input.openAlexApiKey, fetch: input.fetch, trustedPdfOrigins: ["https://content.openalex.org"], pdfParser: unpdf });
      if (result.chunks.length === 0) throw new Error("Selected source did not yield a claim-overlapping permitted passage");
      return { candidate, imported: { ...result, chunks: result.chunks.slice(0, 6) } };
    },
  });
  rejectionCounts.noPermittedText += imported.results.filter((audit) => !audit.value).length;

  const proposals = passageProposals(imported.results);
  const proposalBatches = batches(proposals, PRIMARY_BATCH_SIZE).map((batch, index) => ({ id: `batch-${index + 1}`, query: batch }));
  const primary = await runResearchWorkerPool(proposalBatches, {
    config: { ...config, target: Math.max(1, proposalBatches.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, proposalBatches.length)), maxConcurrency: 1, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatch({ adapter: adapters.primary, run: input.run, batch: item.query, batchId: item.id, reviewer: false, signal: context.signal }),
  });
  const initialPrimaryReviews = new Map(primary.results.flatMap((audit) => audit.value?.reviews ?? []).map((review) => [review.proposalId, review]));
  const reviewerItems: Array<ResearchWorkItem<{ batch: PassageProposal[]; primary: PassageReview[] }>> = batches(
    proposals.filter((proposal) => {
      const review = initialPrimaryReviews.get(proposal.id);
      return Boolean(review?.accepted && review.relevance >= MINIMUM_RELEVANCE && review.directness >= MINIMUM_DIRECTNESS);
    }),
    REVIEW_BATCH_SIZE,
  ).map((batch, index) => ({
    id: `review-batch-${index + 1}`,
    query: { batch, primary: batch.map(({ id }) => initialPrimaryReviews.get(id)!).filter(Boolean) },
  }));
  const reviewed = await runResearchWorkerPool(reviewerItems, {
    config: { ...config, target: Math.max(1, reviewerItems.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, reviewerItems.length)), maxConcurrency: 1, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatch({ adapter: adapters.reviewer, run: input.run, batch: item.query.batch, primary: item.query.primary, batchId: item.id, reviewer: true, signal: context.signal }),
  });

  const chunkById = new Map(imported.results.flatMap((audit) => audit.value?.imported.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  const sourceById = new Map(imported.results.flatMap((audit) => audit.value ? [audit.value.imported.source] : []).map((source) => [source.id, source]));
  const primaryReviewById = new Map<string, PassageReview & { provider: string; executionId: string }>();
  for (const audit of primary.results) {
    if (!audit.value) continue;
    const executionId = audit.value.attempts.at(-1)?.id;
    if (!executionId) continue;
    for (const review of audit.value.reviews) primaryReviewById.set(review.proposalId, { ...review, provider: audit.value.provider, executionId });
  }
  const reviewerReviewById = new Map<string, PassageReview & { provider: string; executionId: string }>();
  for (const audit of reviewed.results) {
    if (!audit.value) continue;
    const executionId = audit.value.attempts.at(-1)?.id;
    if (!executionId) continue;
    for (const review of audit.value.reviews) reviewerReviewById.set(review.proposalId, { ...review, provider: audit.value.provider, executionId });
  }

  const verified = proposals.flatMap((proposal) => {
    const primaryReview = primaryReviewById.get(proposal.id);
    const reviewerReview = reviewerReviewById.get(proposal.id);
    if (!primaryReview) {
      rejectionCounts.providerFailure += 1;
      return [];
    }
    if (!primaryReview.accepted || primaryReview.relevance < MINIMUM_RELEVANCE || primaryReview.directness < MINIMUM_DIRECTNESS || primaryReview.matchedClaimId === null || primaryReview.likelyRole === null || primaryReview.extractedResult === null || primaryReview.settingAndSample === null || primaryReview.studyType === null || primaryReview.limitation === null) {
      rejectionCounts.primaryRejected += 1;
      return [];
    }
    if (!reviewerReview) {
      rejectionCounts.providerFailure += 1;
      return [];
    }
    if (!reviewerReview.accepted || reviewerReview.relevance < MINIMUM_RELEVANCE || reviewerReview.directness < MINIMUM_DIRECTNESS || reviewerReview.matchedClaimId !== primaryReview.matchedClaimId) {
      rejectionCounts.reviewerRejected += 1;
      return [];
    }
    if (primaryReview.matchedClaimId !== proposal.claimId) {
      rejectionCounts.reviewerRejected += 1;
      return [];
    }
    const chunk = chunkById.get(proposal.sourceChunkId);
    const source = sourceById.get(proposal.sourceId);
    if (!chunk || !source || !chunk.text.includes(proposal.excerpt) || source.rights.mayStore !== "allowed" || source.rights.mayDisplay !== "allowed" || source.rights.maySendToModel !== "allowed") {
      rejectionCounts.literalValidationFailed += 1;
      return [];
    }
    const id = `passage-${canonicalSha256({ subclaimId: proposal.claimId, sourceChunkId: proposal.sourceChunkId, excerpt: proposal.excerpt })}`;
    const score = (primaryReview.relevance + primaryReview.directness + reviewerReview.relevance + reviewerReview.directness) / 4;
    return [{
      id,
      subclaimId: proposal.claimId,
      sourceId: proposal.sourceId,
      sourceChunkId: proposal.sourceChunkId,
      excerpt: proposal.excerpt,
      excerptHash: canonicalSha256(proposal.excerpt),
      queryId: proposal.queryId,
      likelyRole: primaryReview.likelyRole,
      extractedResult: primaryReview.extractedResult,
      settingAndSample: primaryReview.settingAndSample,
      studyType: primaryReview.studyType,
      limitation: primaryReview.limitation,
      extractionIssues: primaryReview.extractionIssues,
      primary: { provider: primaryReview.provider, executionId: primaryReview.executionId, relevance: primaryReview.relevance, directness: primaryReview.directness, reason: primaryReview.reason },
      reviewer: { provider: reviewerReview.provider, executionId: reviewerReview.executionId, relevance: reviewerReview.relevance, directness: reviewerReview.directness, reason: reviewerReview.reason },
      deterministic: { literalMatch: true as const, anchorMatch: true as const, rightsEligible: true as const, sourceHash: proposal.sourceHash, chunkHash: proposal.chunkHash },
      selectionScore: score,
    }];
  });

  const selected = selectVerifiedPassages(verified, input.run.claims.map(({ id }) => id));
  const selectedSourceIds = new Set(selected.map(({ sourceId }) => sourceId));
  const selectedChunkIds = new Set(selected.map(({ sourceChunkId }) => sourceChunkId));
  const draftSources = imported.results.flatMap((audit) => {
    if (!audit.value || !selectedSourceIds.has(audit.value.imported.source.id)) return [];
    const chunks = audit.value.imported.chunks.filter(({ id }) => selectedChunkIds.has(id));
    return [{ source: audit.value.imported.source, chunks, importedAt: new Date(audit.finishedAt).toISOString() }];
  });
  const claimsCovered = [...new Set(selected.map(({ subclaimId }) => subclaimId))].sort();
  const claimsMissing = input.run.claims.map(({ id }) => id).filter((id) => !claimsCovered.includes(id));
  const blocked = selected.length !== VERIFIED_PASSAGE_TARGET || claimsMissing.length > 0;
  const primaryGeneration = generationAudit(primary.results);
  const reviewerGeneration = generationAudit(reviewed.results);
  const verification = {
    status: blocked ? "shortfall" as const : "ready" as const,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    queries: plan.queries,
    passages: selected,
    claimsCovered,
    claimsMissing,
    roundsCompleted: Math.max(0, ...plan.queries.map(({ round }) => round)),
    candidatesConsidered: recordById.size,
    rejectionCounts,
    plannerFallbackUsed: plan.fallbackUsed,
    primaryAttempts: primaryGeneration.attempts,
    primaryErrors: primaryGeneration.errors,
    reviewerAttempts: reviewerGeneration.attempts,
    reviewerErrors: reviewerGeneration.errors,
  };
  const draft = PacketDraftSchema.parse({ sources: draftSources, verification });

  return {
    draft,
    queries: plan.queries,
    candidatesConsidered: recordById.size,
    selectedCandidateIds: [...selectedSourceIds],
    skipped: [...recordById.values()].filter((candidate) => !selectedSourceIds.has(`openalex-${candidate.id.toLocaleLowerCase("en-US")}`)).map(({ id }) => ({ id, reason: "not-selected" })),
    usableSources: draft.sources.length,
    targetSources: VERIFIED_PASSAGE_TARGET,
    minimumSources: Math.ceil(VERIFIED_PASSAGE_TARGET / MAX_PASSAGES_PER_SOURCE),
    verifiedPassages: selected.length,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    claimsCovered,
    claimsMissing,
    roundsCompleted: verification.roundsCompleted,
    rejectionCounts,
    plannerFallbackUsed: plan.fallbackUsed,
    blocked,
    durationMs: now() - startedAt,
    searchAudits: searchPool.results,
    primaryAudits: primary.results,
    triageAudits: primary.results,
    reviewerAudits: reviewed.results,
    importAudits: imported.results,
  };
}
