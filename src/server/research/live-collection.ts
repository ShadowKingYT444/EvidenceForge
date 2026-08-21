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
  PendingPassageSchema,
  PlannedResearchQuerySchema,
  ProviderFailureSchema,
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
const PRIMARY_BATCH_SIZE = 3;
const REVIEW_BATCH_SIZE = 15;
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
  reviews: z.array(passageReviewSchema).min(1).max(MAX_PASSAGE_PROPOSALS),
}).strict();

export const AutomaticCollectionRequestSchema = z.object({
  expectedRevision: z.string().min(1),
  mode: z.enum(["initial", "deeper", "retry_verification"]).default("initial"),
  config: z.object({
    target: z.number().int().min(1).max(10).optional(),
    minimum: z.number().int().min(1).max(10).optional(),
    candidateCap: z.number().int().min(10).max(30).optional(),
    sourceDeadlineMs: z.number().int().min(10_000).max(180_000).optional(),
    perItemTimeoutMs: z.number().int().min(2_000).max(45_000).optional(),
    deadlineMs: z.number().int().min(30_000).max(300_000).optional(),
    maxConcurrency: z.number().int().min(1).max(6).optional(),
  }).strict().default({}),
}).strict();

type PlannedQuery = z.output<typeof PlannedResearchQuerySchema>;
type PassageReview = z.output<typeof passageReviewSchema>;
type PassageGeneration = StructuredGenerationResult<typeof passageReviewOutputSchema>;
type RunError = ResearchRun["errors"][number];
type PassageProposal = z.output<typeof PendingPassageSchema>;
type ProviderFailure = z.output<typeof ProviderFailureSchema>;

type PassageEvaluationResult = {
  provider: string;
  fallbackUsed: boolean;
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
  status: "ready" | "evidence_shortfall" | "provider_unavailable";
  pendingPassages: number;
  providerFailures: ProviderFailure[];
  blocked: boolean;
  durationMs: number;
  searchAudits: Array<WorkerAuditResult<Awaited<ReturnType<typeof searchScholarlyWorks>>>>;
  primaryAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  triageAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  reviewerAudits: Array<WorkerAuditResult<PassageEvaluationResult>>;
  importAudits: Array<WorkerAuditResult<ImportedCandidate>>;
};

class CollectionGenerationFailure extends Error {
  constructor(readonly generations: PassageGeneration[]) {
    super(generations.at(-1)?.errors.at(-1)?.message ?? "Passage evaluation failed");
    this.name = "CollectionGenerationFailure";
  }
}

function providerFailure(generation: PassageGeneration, stage: ProviderFailure["stage"], affectedPassages: number): ProviderFailure {
  const error = generation.errors.at(-1);
  const attempt = generation.attempts.at(-1);
  const httpStatus = error?.details.httpStatus ?? null;
  const code = httpStatus === 429
    ? "rate_limited"
    : error?.kind === "timeout"
      ? "timeout"
      : error?.kind === "invalid_model_json" || error?.kind === "invalid_model_output"
        ? "invalid_output"
        : "provider_error";
  return ProviderFailureSchema.parse({
    stage,
    provider: attempt?.requestedProvider ?? "unknown",
    code,
    httpStatus,
    attempts: generation.attempts.length || 1,
    affectedPassages,
    retryable: error?.retryable ?? false,
  });
}

function mayUseFallback(generation: PassageGeneration): boolean {
  const error = generation.errors.at(-1);
  return Boolean(error && (
    error.retryable ||
    error.kind === "invalid_model_json" ||
    error.kind === "invalid_model_output"
  ));
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

function anchorMatch(candidate: EvidenceCandidate, run: ResearchRun): boolean {
  const text = `${candidate.title ?? ""} ${candidate.abstract ?? ""}`.toLocaleLowerCase("en-US");
  const anchors = Array.isArray(candidate.metadata?.anchors)
    ? candidate.metadata.anchors.filter((value): value is string => typeof value === "string")
    : [];
  const multiwordAnchors = anchors.filter((anchor) => terms(anchor).length >= 2);
  const anchorPhraseMatch = multiwordAnchors.some((anchor) => text.includes(anchor.toLocaleLowerCase("en-US")));
  const questionTerms = terms(run.intake.originalQuestion);
  const questionPhrases = questionTerms.slice(0, -1).map((term, index) => `${term} ${questionTerms[index + 1]}`);
  const questionPhraseMatch = questionPhrases.some((phrase) => text.includes(phrase));
  const queryTerms = new Set(terms(candidate.query ?? ""));
  const queryMatches = [...queryTerms].filter((term) => text.includes(term)).length;
  return anchorPhraseMatch && questionPhraseMatch && queryMatches >= 2 && queryMatches / Math.max(1, queryTerms.size) >= 0.5;
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
  if (!generated.ok) throw new CollectionGenerationFailure([generated]);
  const expected = new Set(input.batch.map(({ id }) => id));
  const returned = new Set(generated.value.reviews.map(({ proposalId }) => proposalId));
  if (returned.size !== expected.size || [...expected].some((id) => !returned.has(id))) {
    throw new CollectionGenerationFailure([generated]);
  }
  return {
    provider: input.adapter.identity.provider,
    fallbackUsed: false,
    reviews: generated.value.reviews,
    attempts: generated.attempts,
    errors: generated.errors,
  };
}

async function evaluatePassageBatchWithFallback(input: {
  preferred: StructuredGenerationAdapter;
  fallback?: StructuredGenerationAdapter | null;
  run: ResearchRun;
  batch: PassageProposal[];
  batchId: string;
  reviewer: boolean;
  primary?: PassageReview[];
  signal: AbortSignal;
}): Promise<PassageEvaluationResult> {
  try {
    return await evaluatePassageBatch({ ...input, adapter: input.preferred });
  } catch (error) {
    if (!(error instanceof CollectionGenerationFailure)) throw error;
    const lastGeneration = error.generations.at(-1);
    if (!lastGeneration || !input.fallback || input.fallback.identity.provider === input.preferred.identity.provider || !mayUseFallback(lastGeneration)) throw error;
    try {
      const recovered = await evaluatePassageBatch({
        ...input,
        adapter: input.fallback,
        batchId: `${input.batchId}-fallback`,
      });
      return {
        ...recovered,
        fallbackUsed: true,
        attempts: [...error.generations.flatMap((generation) => generation.attempts), ...recovered.attempts],
        errors: [...error.generations.flatMap((generation) => generation.errors), ...recovered.errors],
      };
    } catch (fallbackError) {
      if (!(fallbackError instanceof CollectionGenerationFailure)) throw fallbackError;
      throw new CollectionGenerationFailure([...error.generations, ...fallbackError.generations]);
    }
  }
}

function generationAudit(audits: readonly WorkerAuditResult<PassageEvaluationResult>[]): { attempts: NodeExecution[]; errors: RunError[] } {
  const attempts: NodeExecution[] = [];
  const errors: RunError[] = [];
  for (const audit of audits) {
    if (audit.value) {
      attempts.push(...audit.value.attempts);
      errors.push(...audit.value.errors);
    } else if (audit.error instanceof CollectionGenerationFailure) {
      attempts.push(...audit.error.generations.flatMap((generation) => generation.attempts));
      errors.push(...audit.error.generations.flatMap((generation) => generation.errors));
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

type DraftEntry = PacketDraft["sources"][number];

function failedProviderAudits(
  audits: readonly WorkerAuditResult<PassageEvaluationResult>[],
  stage: ProviderFailure["stage"],
  affectedByItem: ReadonlyMap<string, number>,
  defaultProvider: string,
): ProviderFailure[] {
  return audits.flatMap((audit) => {
    if (audit.error instanceof CollectionGenerationFailure) {
      return audit.error.generations.map((generation) => providerFailure(generation, stage, affectedByItem.get(audit.itemId) ?? 0));
    }
    if (audit.status !== "failed" && audit.status !== "timed-out") return [];
    const code = audit.signal === "timeout" ? "timeout" : audit.signal === "429" ? "rate_limited" : "provider_error";
    return [ProviderFailureSchema.parse({
      stage,
      provider: defaultProvider,
      code,
      httpStatus: audit.signal === "429" ? 429 : null,
      attempts: 1,
      affectedPassages: affectedByItem.get(audit.itemId) ?? 0,
      retryable: audit.signal === "timeout" || audit.signal === "429" || audit.signal === "5xx",
    })];
  });
}

function narrowedDraftEntries(entries: readonly DraftEntry[], passages: readonly PassageProposal[]): DraftEntry[] {
  const sourceIds = new Set(passages.map(({ sourceId }) => sourceId));
  const chunkIds = new Set(passages.map(({ sourceChunkId }) => sourceChunkId));
  return entries.flatMap((entry) => {
    if (!sourceIds.has(entry.source.id)) return [];
    const chunks = entry.chunks.filter(({ id }) => chunkIds.has(id));
    return chunks.length ? [{ ...entry, chunks }] : [];
  });
}

async function verifyPassageProposals(input: {
  run: ResearchRun;
  proposals: PassageProposal[];
  entries: DraftEntry[];
  queries: PlannedQuery[];
  candidatesConsidered: number;
  plannerFallbackUsed: boolean;
  rejectionCounts: RejectionCounts;
  verificationAttempt: number;
  priorVerification?: PacketDraft["verification"];
  config: ResearchConfig;
  adapters: ReturnType<typeof configuredResearchAdapters>;
  signal?: AbortSignal;
  deadlineMs: () => number;
}) {
  const proposalBatches = batches(input.proposals, PRIMARY_BATCH_SIZE).map((batch, index) => ({ id: `verification-${input.verificationAttempt}-batch-${index + 1}`, query: batch }));
  const primary = await runResearchWorkerPool(proposalBatches, {
    config: { ...input.config, target: Math.max(1, proposalBatches.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, proposalBatches.length)), maxConcurrency: 1, deadlineMs: input.deadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatchWithFallback({ preferred: input.adapters.reviewer, fallback: input.adapters.primary, run: input.run, batch: item.query, batchId: item.id, reviewer: false, signal: context.signal }),
  });
  const initialPrimaryReviews = new Map(primary.results.flatMap((audit) => audit.value?.reviews ?? []).map((review) => [review.proposalId, review]));
  const primaryProviderByProposal = new Map(primary.results.flatMap((audit) => audit.value ? audit.value.reviews.map((review) => [review.proposalId, audit.value!.provider] as const) : []));
  type ReviewerQuery = { batch: PassageProposal[]; primary: PassageReview[]; primaryProvider: string };
  const reviewerItems: Array<ResearchWorkItem<ReviewerQuery>> = batches(
    input.proposals.filter((proposal) => {
      const review = initialPrimaryReviews.get(proposal.id);
      return Boolean(review?.accepted && review.relevance >= MINIMUM_RELEVANCE && review.directness >= MINIMUM_DIRECTNESS);
    }),
    REVIEW_BATCH_SIZE,
  ).map((batch, index) => ({
    id: `verification-${input.verificationAttempt}-review-${index + 1}`,
    query: {
      batch,
      primary: batch.map(({ id }) => initialPrimaryReviews.get(id)!).filter(Boolean),
      primaryProvider: primaryProviderByProposal.get(batch[0]!.id) ?? input.adapters.reviewer.identity.provider,
    },
  }));
  const reviewed = await runResearchWorkerPool(reviewerItems, {
    config: { ...input.config, target: Math.max(1, reviewerItems.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, reviewerItems.length)), maxConcurrency: 1, deadlineMs: input.deadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatchWithFallback({
      preferred: item.query.primaryProvider === input.adapters.primary.identity.provider ? input.adapters.reviewer : input.adapters.primary,
      fallback: null,
      run: input.run,
      batch: item.query.batch,
      primary: item.query.primary,
      batchId: item.id,
      reviewer: true,
      signal: context.signal,
    }),
  });

  const primarySizes = new Map(proposalBatches.map((batch) => [batch.id, batch.query.length]));
  const reviewerSizes = new Map(reviewerItems.map((batch) => [batch.id, batch.query.batch.length]));
  const providerFailures = [
    ...failedProviderAudits(primary.results, "primary_admission", primarySizes, input.adapters.reviewer.identity.provider),
    ...failedProviderAudits(reviewed.results, "review", reviewerSizes, input.adapters.primary.identity.provider),
  ];
  const pendingIds = new Set([
    ...primary.results.flatMap((audit) => audit.error ? proposalBatches.find(({ id }) => id === audit.itemId)?.query.map(({ id }) => id) ?? [] : []),
    ...reviewed.results.flatMap((audit) => audit.error ? reviewerItems.find(({ id }) => id === audit.itemId)?.query.batch.map(({ id }) => id) ?? [] : []),
  ]);
  const chunkById = new Map(input.entries.flatMap(({ chunks }) => chunks).map((chunk) => [chunk.id, chunk]));
  const sourceById = new Map(input.entries.map(({ source }) => [source.id, source]));
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

  const counts = { ...input.rejectionCounts, primaryRejected: 0, reviewerRejected: 0, providerFailure: providerFailures.length, literalValidationFailed: 0 };
  const verified = input.proposals.flatMap((proposal) => {
    const primaryReview = primaryReviewById.get(proposal.id);
    const reviewerReview = reviewerReviewById.get(proposal.id);
    if (!primaryReview) return [];
    if (!primaryReview.accepted || primaryReview.relevance < MINIMUM_RELEVANCE || primaryReview.directness < MINIMUM_DIRECTNESS || primaryReview.matchedClaimId === null || primaryReview.likelyRole === null || primaryReview.extractedResult === null || primaryReview.settingAndSample === null || primaryReview.studyType === null || primaryReview.limitation === null) {
      counts.primaryRejected += 1;
      return [];
    }
    if (!reviewerReview) return [];
    if (!reviewerReview.accepted || reviewerReview.relevance < MINIMUM_RELEVANCE || reviewerReview.directness < MINIMUM_DIRECTNESS || reviewerReview.matchedClaimId !== primaryReview.matchedClaimId || primaryReview.matchedClaimId !== proposal.claimId) {
      counts.reviewerRejected += 1;
      return [];
    }
    const chunk = chunkById.get(proposal.sourceChunkId);
    const source = sourceById.get(proposal.sourceId);
    if (!chunk || !source || !chunk.text.includes(proposal.excerpt) || source.rights.mayStore !== "allowed" || source.rights.mayDisplay !== "allowed" || source.rights.maySendToModel !== "allowed") {
      counts.literalValidationFailed += 1;
      return [];
    }
    const id = `passage-${canonicalSha256({ subclaimId: proposal.claimId, sourceChunkId: proposal.sourceChunkId, excerpt: proposal.excerpt })}`;
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
      selectionScore: (primaryReview.relevance + primaryReview.directness + reviewerReview.relevance + reviewerReview.directness) / 4,
    }];
  });
  const selected = selectVerifiedPassages(verified, input.run.claims.map(({ id }) => id));
  const claimsCovered = [...new Set(selected.map(({ subclaimId }) => subclaimId))].sort();
  const claimsMissing = input.run.claims.map(({ id }) => id).filter((id) => !claimsCovered.includes(id));
  const status = providerFailures.length > 0
    ? "provider_unavailable" as const
    : selected.length === VERIFIED_PASSAGE_TARGET && claimsMissing.length === 0
      ? "ready" as const
      : "evidence_shortfall" as const;
  const primaryGeneration = generationAudit(primary.results);
  const reviewerGeneration = generationAudit(reviewed.results);
  const pendingPassages = status === "provider_unavailable" ? input.proposals.filter(({ id }) => pendingIds.has(id)) : [];
  const selectedAsProposals = selected.map((passage) => ({
    id: passage.id,
    claimId: passage.subclaimId,
    sourceId: passage.sourceId,
    sourceChunkId: passage.sourceChunkId,
    sourceTitle: sourceById.get(passage.sourceId)?.bibliographicMetadata.title ?? "Verified source",
    excerpt: passage.excerpt,
    queryId: passage.queryId,
    sourceHash: passage.deterministic.sourceHash,
    chunkHash: passage.deterministic.chunkHash,
  }));
  const draftSources = narrowedDraftEntries(input.entries, status === "provider_unavailable" ? pendingPassages : selectedAsProposals);
  const verification = {
    status,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    queries: input.queries,
    passages: selected,
    pendingPassages,
    providerFailures,
    verificationAttempt: input.verificationAttempt,
    claimsCovered,
    claimsMissing,
    roundsCompleted: Math.max(0, ...input.queries.map(({ round }) => round)),
    candidatesConsidered: input.candidatesConsidered,
    rejectionCounts: counts,
    plannerFallbackUsed: input.plannerFallbackUsed,
    primaryAttempts: [...(input.priorVerification?.primaryAttempts ?? []), ...primaryGeneration.attempts],
    primaryErrors: [...(input.priorVerification?.primaryErrors ?? []), ...primaryGeneration.errors],
    reviewerAttempts: [...(input.priorVerification?.reviewerAttempts ?? []), ...reviewerGeneration.attempts],
    reviewerErrors: [...(input.priorVerification?.reviewerErrors ?? []), ...reviewerGeneration.errors],
  };
  return {
    draft: PacketDraftSchema.parse({ sources: draftSources, verification }),
    primary,
    reviewed,
    selected,
    status,
    counts,
    providerFailures,
    claimsCovered,
    claimsMissing,
  };
}

export async function collectAutomaticResearchPacket(input: {
  run: ResearchRun;
  currentDraft: unknown;
  mode?: "initial" | "deeper" | "retry_verification";
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
  const currentDraft = PacketDraftSchema.parse(input.currentDraft ?? { sources: [] });
  if (input.mode === "retry_verification") {
    const prior = currentDraft.verification;
    if (prior?.status !== "provider_unavailable" || prior.pendingPassages.length === 0 || currentDraft.sources.length === 0) {
      throw new Error("retry_verification requires saved pending passages from a provider-unavailable packet");
    }
    const retried = await verifyPassageProposals({
      run: input.run,
      proposals: prior.pendingPassages,
      entries: currentDraft.sources,
      queries: prior.queries,
      candidatesConsidered: prior.candidatesConsidered,
      plannerFallbackUsed: prior.plannerFallbackUsed,
      rejectionCounts: prior.rejectionCounts,
      verificationAttempt: prior.verificationAttempt + 1,
      priorVerification: prior,
      config,
      adapters,
      signal: input.signal,
      deadlineMs: phaseDeadlineMs,
    });
    return {
      draft: retried.draft,
      queries: prior.queries,
      candidatesConsidered: prior.candidatesConsidered,
      selectedCandidateIds: [...new Set(retried.draft.sources.map(({ source }) => source.id))],
      skipped: [],
      usableSources: retried.draft.sources.length,
      targetSources: VERIFIED_PASSAGE_TARGET,
      minimumSources: Math.ceil(VERIFIED_PASSAGE_TARGET / MAX_PASSAGES_PER_SOURCE),
      verifiedPassages: retried.selected.length,
      targetPassages: VERIFIED_PASSAGE_TARGET,
      claimsCovered: retried.claimsCovered,
      claimsMissing: retried.claimsMissing,
      roundsCompleted: prior.roundsCompleted,
      rejectionCounts: retried.counts,
      plannerFallbackUsed: prior.plannerFallbackUsed,
      status: retried.status,
      pendingPassages: retried.draft.verification?.pendingPassages.length ?? 0,
      providerFailures: retried.providerFailures,
      blocked: retried.status !== "ready",
      durationMs: now() - startedAt,
      searchAudits: [],
      primaryAudits: retried.primary.results,
      triageAudits: retried.primary.results,
      reviewerAudits: retried.reviewed.results,
      importAudits: [],
    };
  }
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
    if (!anchorMatch(candidate, input.run)) {
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
  const proposalBatches = batches(proposals, PRIMARY_BATCH_SIZE).map((batch, index) => ({ id: `verification-1-batch-${index + 1}`, query: batch }));
  const primary = await runResearchWorkerPool(proposalBatches, {
    config: { ...config, target: Math.max(1, proposalBatches.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, proposalBatches.length)), maxConcurrency: 1, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatchWithFallback({ preferred: adapters.reviewer, fallback: adapters.primary, run: input.run, batch: item.query, batchId: item.id, reviewer: false, signal: context.signal }),
  });
  const initialPrimaryReviews = new Map(primary.results.flatMap((audit) => audit.value?.reviews ?? []).map((review) => [review.proposalId, review]));
  const primaryProviderByProposal = new Map(primary.results.flatMap((audit) => audit.value ? audit.value.reviews.map((review) => [review.proposalId, audit.value!.provider] as const) : []));
  type InitialReviewerQuery = { batch: PassageProposal[]; primary: PassageReview[]; primaryProvider: string };
  const reviewerItems: Array<ResearchWorkItem<InitialReviewerQuery>> = batches(
    proposals.filter((proposal) => {
      const review = initialPrimaryReviews.get(proposal.id);
      return Boolean(review?.accepted && review.relevance >= MINIMUM_RELEVANCE && review.directness >= MINIMUM_DIRECTNESS);
    }),
    REVIEW_BATCH_SIZE,
  ).map((batch, index) => ({
    id: `verification-1-review-${index + 1}`,
    query: { batch, primary: batch.map(({ id }) => initialPrimaryReviews.get(id)!).filter(Boolean), primaryProvider: primaryProviderByProposal.get(batch[0]!.id) ?? adapters.reviewer.identity.provider },
  }));
  const reviewed = await runResearchWorkerPool(reviewerItems, {
    config: { ...config, target: Math.max(1, reviewerItems.length), minimum: 1, candidateCap: Math.max(1, Math.min(30, reviewerItems.length)), maxConcurrency: 1, deadlineMs: phaseDeadlineMs() },
    signal: input.signal,
    worker: (item, context) => evaluatePassageBatchWithFallback({ preferred: item.query.primaryProvider === adapters.primary.identity.provider ? adapters.reviewer : adapters.primary, fallback: null, run: input.run, batch: item.query.batch, primary: item.query.primary, batchId: item.id, reviewer: true, signal: context.signal }),
  });

  const providerFailures = [
    ...failedProviderAudits(primary.results, "primary_admission", new Map(proposalBatches.map((batch) => [batch.id, batch.query.length])), adapters.reviewer.identity.provider),
    ...failedProviderAudits(reviewed.results, "review", new Map(reviewerItems.map((batch) => [batch.id, batch.query.batch.length])), adapters.primary.identity.provider),
  ];
  const pendingIds = new Set([
    ...primary.results.flatMap((audit) => audit.error ? proposalBatches.find(({ id }) => id === audit.itemId)?.query.map(({ id }) => id) ?? [] : []),
    ...reviewed.results.flatMap((audit) => audit.error ? reviewerItems.find(({ id }) => id === audit.itemId)?.query.batch.map(({ id }) => id) ?? [] : []),
  ]);
  const pendingPassages = proposals.filter(({ id }) => pendingIds.has(id));
  rejectionCounts.providerFailure = providerFailures.length;

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
    if (!primaryReview) return [];
    if (!primaryReview.accepted || primaryReview.relevance < MINIMUM_RELEVANCE || primaryReview.directness < MINIMUM_DIRECTNESS || primaryReview.matchedClaimId === null || primaryReview.likelyRole === null || primaryReview.extractedResult === null || primaryReview.settingAndSample === null || primaryReview.studyType === null || primaryReview.limitation === null) {
      rejectionCounts.primaryRejected += 1;
      return [];
    }
    if (!reviewerReview) return [];
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
  const claimsCovered = [...new Set(selected.map(({ subclaimId }) => subclaimId))].sort();
  const claimsMissing = input.run.claims.map(({ id }) => id).filter((id) => !claimsCovered.includes(id));
  const status = providerFailures.length > 0
    ? "provider_unavailable" as const
    : selected.length === VERIFIED_PASSAGE_TARGET && claimsMissing.length === 0
      ? "ready" as const
      : "evidence_shortfall" as const;
  const proposalSourceIds = new Set(pendingPassages.map(({ sourceId }) => sourceId));
  const proposalChunkIds = new Set(pendingPassages.map(({ sourceChunkId }) => sourceChunkId));
  const draftSources = imported.results.flatMap((audit) => {
    if (!audit.value) return [];
    const retainPending = status === "provider_unavailable" && proposalSourceIds.has(audit.value.imported.source.id);
    const retainSelected = selectedSourceIds.has(audit.value.imported.source.id);
    if (!retainPending && !retainSelected) return [];
    const chunks = audit.value.imported.chunks.filter(({ id }) => retainPending ? proposalChunkIds.has(id) : selectedChunkIds.has(id));
    return chunks.length ? [{ source: audit.value.imported.source, chunks, importedAt: new Date(audit.finishedAt).toISOString() }] : [];
  });
  const primaryGeneration = generationAudit(primary.results);
  const reviewerGeneration = generationAudit(reviewed.results);
  const verification = {
    status,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    queries: plan.queries,
    passages: selected,
    pendingPassages: status === "provider_unavailable" ? pendingPassages : [],
    providerFailures,
    verificationAttempt: 1,
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
    selectedCandidateIds: draft.sources.map(({ source }) => source.id),
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
    status,
    pendingPassages: verification.pendingPassages.length,
    providerFailures,
    blocked: status !== "ready",
    durationMs: now() - startedAt,
    searchAudits: searchPool.results,
    primaryAudits: primary.results,
    triageAudits: primary.results,
    reviewerAudits: reviewed.results,
    importAudits: imported.results,
  };
}
