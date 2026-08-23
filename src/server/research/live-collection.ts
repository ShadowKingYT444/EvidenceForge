import * as unpdf from "unpdf";
import { z } from "zod";

import { canonicalSha256, type NodeExecution, type ResearchRun } from "../../contracts";
import type { StructuredGenerationAdapter, StructuredGenerationResult } from "../models";
import { configuredResearchAdapters } from "../workflow/durable-coordinator";
import { providerJsonSchema } from "../workflow/run-api";
import { importFirecrawlCandidate, searchFirecrawl, type FirecrawlCandidate, type FirecrawlSearchResult } from "../sources/firecrawl";
import { importOpenAlexWork } from "../sources/import-service";
import {
  PacketDraftSchema,
  PendingPassageSchema,
  PlannedResearchQuerySchema,
  ProviderFailureSchema,
  SearchAuditSchema,
  SourceTypeSchema,
  VERIFIED_PASSAGE_TARGET,
  type PacketDraft,
  type SearchAudit,
} from "../sources/packet-draft";
import { searchScholarlyWorks, type ScholarlyCandidate } from "../sources/openalex";
import { dedupeQueries, preRankCandidates, runResearchWorkerPool } from "./index";
import { parseResearchConfig, type ResearchConfig } from "./config";
import type {
  EvidenceCandidate,
  ResearchRunResult,
  ResearchWorker,
  ResearchWorkItem,
  WorkerAuditResult,
} from "./types";

const MINIMUM_RELEVANCE = 0.8;
const MINIMUM_DIRECTNESS = 0.7;
const MAX_IMPORTED_SOURCES = 20;
const MAX_PASSAGE_PROPOSALS = 40;
const MAX_PASSAGES_PER_SOURCE = 2;
const OPENALEX_RESULTS_PER_QUERY = 40;
const OPENALEX_MAX_PAGES = 2;
export const MODEL_BATCH_MAX_ITEMS = 4;
export const MODEL_BATCH_TOKEN_BUDGET = 5_000;
const MODEL_BATCH_BASE_TOKENS = 1_200;
const CONSERVATIVE_CHARS_PER_TOKEN = 3;

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
  sourceType: SourceTypeSchema.default("empirical"),
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
    ["studyType", review.studyType],
    ["limitation", review.limitation],
  ] as const) {
    if (value === null) context.addIssue({ code: "custom", path: [field], message: `${field} is required when accepted` });
  }
  if (review.sourceType === "empirical" && review.settingAndSample === null) {
    context.addIssue({ code: "custom", path: ["settingAndSample"], message: "settingAndSample is required for empirical evidence" });
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
type PacketVerification = NonNullable<PacketDraft["verification"]>;
type DraftEntry = PacketDraft["sources"][number];
type SearchProviderResult = Awaited<ReturnType<typeof searchScholarlyWorks>> | FirecrawlSearchResult;

type PassageEvaluationResult = {
  provider: string;
  fallbackUsed: boolean;
  reviews: PassageReview[];
  attempts: readonly NodeExecution[];
  errors: readonly RunError[];
};

type CandidateAssociation = {
  claimId: string;
  queryId: string;
  query: string;
  intent: PlannedQuery["intent"];
  anchors: string[];
  rank: number;
  providerScore: number;
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
  searchAudits: Array<WorkerAuditResult<SearchProviderResult>>;
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

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it",
  "of", "on", "or", "that", "the", "to", "was", "were", "with", "does", "into", "than", "this",
]);

function terms(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu)?.filter((term) => term.length > 2 && !STOP_WORDS.has(term)) ?? [];
}

function compactQuery(value: string): string {
  return [...new Set(terms(value))].slice(0, 6).join(" ");
}

function emptyCounts(): RejectionCounts {
  return { offTopic: 0, noPermittedText: 0, rightsIneligible: 0, primaryRejected: 0, reviewerRejected: 0, providerFailure: 0, literalValidationFailed: 0, duplicate: 0 };
}

function deterministicQueryPlan(run: ResearchRun, round: number): PlannedQuery[] {
  const direct = run.claims.map((claim) => {
    const query = compactQuery(claim.statement) || compactQuery(run.intake.originalQuestion) || "bounded evidence";
    return { id: `query-${claim.id}-direct-${round}`, claimId: claim.id, query, intent: "direct" as const, anchors: [...new Set([query.split(" ").slice(0, 2).join(" "), ...terms(claim.statement).slice(0, 4)])].filter((value) => value.length > 1).slice(0, 6), round };
  });
  const extras = run.claims.flatMap((claim) => {
    const base = compactQuery(claim.statement) || "bounded evidence";
    return [
      { id: `query-${claim.id}-mechanism-${round}`, claimId: claim.id, query: `${base} mechanism`, intent: "mechanism" as const, anchors: terms(claim.statement).slice(0, 6), round },
      { id: `query-${claim.id}-limitation-${round}`, claimId: claim.id, query: `${base} limitation`, intent: "limitation" as const, anchors: terms(claim.statement).slice(0, 6), round },
      { id: `query-${claim.id}-evaluation-${round}`, claimId: claim.id, query: `${base} evaluation`, intent: "evaluation" as const, anchors: terms(claim.statement).slice(0, 6), round },
      { id: `query-${claim.id}-challenge-${round}`, claimId: claim.id, query: `${base} failure counterevidence`, intent: "challenge" as const, anchors: terms(claim.statement).slice(0, 6), round },
    ];
  });
  const unique = new Set(dedupeQueries([...direct, ...extras].map(({ query }) => query)).map((query) => query.toLocaleLowerCase("en-US")));
  return [...direct, ...extras].filter(({ query }) => unique.delete(query.toLocaleLowerCase("en-US"))).slice(0, 10);
}

async function generateQueryPlan(
  run: ResearchRun,
  adapters: ReturnType<typeof configuredResearchAdapters>,
  mode: "initial" | "deeper",
  prior: PacketVerification | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ queries: PlannedQuery[]; fallbackUsed: boolean }> {
  const nextRound = (prior?.roundsCompleted ?? 0) + 1;
  const payload = {
    question: run.intake.originalQuestion,
    application: run.intake.intendedApplication,
    mode,
    claims: run.claims.map(({ id, statement, operationalDefinition }) => ({ id, statement, operationalDefinition })),
    missingClaims: prior?.claimsMissing ?? run.claims.map(({ id }) => id),
    priorQueries: prior?.queries.map(({ claimId, query, intent }) => ({ claimId, query, intent })) ?? [],
    priorRejections: prior?.rejectionCounts ?? null,
  };
  const messages = [
    { role: "system" as const, content: "Plan compact bounded scholarly searches for every approved claim. Include direct, challenge, limitation, mechanism, and evaluation intents, prioritizing missing claims and prior rejection reasons. Never repeat a prior query. Return only JSON matching the schema." },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  for (const adapter of [adapters.primary, adapters.reviewer]) {
    const generated = await adapter.generate({
      nodeId: `plan-evidence-search-${nextRound}`,
      inputRefs: run.claims.map(({ id }) => id),
      outputRefs: [],
      promptId: "autonomous-evidence-query-plan",
      promptVersion: "2.0.0",
      promptHash: canonicalSha256(messages),
      schemaVersion: "autonomous-evidence-query-plan.v2",
      schemaName: "autonomous-evidence-query-plan-output",
      outputSchema: queryPlanOutputSchema,
      outputJsonSchema: providerJsonSchema(z.toJSONSchema(queryPlanOutputSchema)),
      messages,
      settings: { temperature: 0, maxOutputTokens: 1_600, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
      timeoutMs: Math.max(1_000, Math.min(20_000, timeoutMs)),
      measured: false,
      repairInvalidOutput: true,
      maximumAttempts: 2,
      codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
      signal,
    });
    if (!generated.ok) continue;
    return { queries: generated.value.queries, fallbackUsed: adapter !== adapters.primary };
  }
  return { queries: deterministicQueryPlan(run, nextRound), fallbackUsed: true };
}

function prepareRoundQueries(run: ResearchRun, proposed: readonly PlannedQuery[], prior: PacketVerification | null): PlannedQuery[] {
  const round = (prior?.roundsCompleted ?? 0) + 1;
  const knownClaims = new Set(run.claims.map(({ id }) => id));
  const priorQueries = new Set((prior?.queries ?? []).map(({ query }) => query.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")));
  const output: PlannedQuery[] = [];
  const seen = new Set(priorQueries);
  const add = (query: PlannedQuery) => {
    const normalized = query.query.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
    if (!knownClaims.has(query.claimId) || terms(query.query).length < 2 || terms(query.query).length > 8 || seen.has(normalized) || output.length >= 10) return;
    seen.add(normalized);
    const anchors = [...new Set(query.anchors.map((anchor) => anchor.trim()).filter((anchor) => anchor.length > 1))].slice(0, 6);
    output.push(PlannedResearchQuerySchema.parse({ ...query, id: `${query.id}-${round}-${output.length + 1}`.slice(0, 128), anchors: anchors.length ? anchors : terms(query.query).slice(0, 4), round }));
  };
  proposed.forEach(add);
  const fallback = deterministicQueryPlan(run, round);
  for (const claim of run.claims) {
    if (!output.some(({ claimId }) => claimId === claim.id)) fallback.filter(({ claimId }) => claimId === claim.id).forEach(add);
  }
  if (output.length < 2) fallback.forEach(add);
  return output;
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

function association(candidate: ScholarlyCandidate, plan: PlannedQuery, rank: number): CandidateAssociation {
  return { claimId: plan.claimId, queryId: plan.id, query: plan.query, intent: plan.intent, anchors: plan.anchors, rank, providerScore: normalizedProviderScore(candidate.providerRelevanceScore) };
}

function candidateRecord(candidate: ScholarlyCandidate, plan: PlannedQuery, rank: number): EvidenceCandidate {
  const eligible = candidate.isOpenAccess && licenseIsEligible(candidate.license);
  return {
    id: candidate.openAlexId,
    url: candidate.landingPageUrl ?? `https://openalex.org/${candidate.openAlexId}`,
    title: candidate.title ?? undefined,
    abstract: candidate.abstract ?? undefined,
    query: plan.query,
    role: plan.intent === "challenge" || plan.intent === "limitation" ? "challenge" : "support",
    rank,
    score: normalizedProviderScore(candidate.providerRelevanceScore),
    publishedAt: candidate.publicationYear ?? undefined,
    rights: { eligible, basis: eligible ? `OpenAlex license signal: ${candidate.license}` : "No eligible explicit license signal" },
    contentScope: { eligible: Boolean(candidate.abstract) || candidate.isOpenAccess, basis: candidate.abstract ? "OpenAlex abstract available" : "Open-access full text reported" },
    metadata: {
      provider: "openalex",
      canonicalDoi: candidate.canonicalDoi ?? "",
      license: candidate.license ?? "",
      hasAbstract: candidate.hasAbstract,
      citations: candidate.citationCount,
      providerRelevanceScore: candidate.providerRelevanceScore,
      associations: [association(candidate, plan, rank)],
    },
  };
}

function firecrawlCandidateRecord(candidate: FirecrawlCandidate, plan: PlannedQuery, rank: number): EvidenceCandidate {
  const abstract = [candidate.description, candidate.markdown?.slice(0, 4_000)].filter(Boolean).join("\n\n");
  return {
    id: candidate.id,
    url: candidate.url,
    title: candidate.title,
    abstract: abstract || undefined,
    query: plan.query,
    role: plan.intent === "challenge" || plan.intent === "limitation" ? "challenge" : "support",
    rank,
    score: 0,
    publishedAt: candidate.publicationYear ?? undefined,
    rights: { eligible: candidate.rightsEligible, basis: candidate.rightsEligible ? `Firecrawl page license signal: ${candidate.license}` : "No explicit reusable-content license signal" },
    contentScope: { eligible: Boolean(candidate.markdown), basis: candidate.markdown ? "Firecrawl returned bounded main-page content" : "No page content returned" },
    metadata: {
      provider: "firecrawl",
      canonicalDoi: candidate.canonicalDoi ?? "",
      license: candidate.license ?? "",
      firecrawlCandidate: candidate,
      associations: [{ claimId: plan.claimId, queryId: plan.id, query: plan.query, intent: plan.intent, anchors: plan.anchors, rank, providerScore: 0 } satisfies CandidateAssociation],
    },
  };
}

function candidateAssociations(candidate: EvidenceCandidate): CandidateAssociation[] {
  const values = Array.isArray(candidate.metadata?.associations) ? candidate.metadata.associations : [];
  return values.filter((value): value is CandidateAssociation => Boolean(value && typeof value === "object" && typeof (value as CandidateAssociation).claimId === "string" && typeof (value as CandidateAssociation).queryId === "string"));
}

function automaticCandidateIdentity(candidate: EvidenceCandidate): string {
  const doi = String(candidate.metadata?.canonicalDoi ?? "").trim().toLocaleLowerCase("en-US");
  if (doi) return `doi:${doi}`;
  if (candidate.url) {
    try {
      const url = new URL(candidate.url);
      url.hash = "";
      return `url:${url.toString().toLocaleLowerCase("en-US")}`;
    } catch {
      // Fall through to the provider ID.
    }
  }
  return `id:${candidate.id.toLocaleLowerCase("en-US")}`;
}

function candidateProvider(candidate: EvidenceCandidate): "openalex" | "firecrawl" {
  return candidate.metadata?.provider === "firecrawl" ? "firecrawl" : "openalex";
}

function mergeCandidateAssociation(prior: EvidenceCandidate, next: EvidenceCandidate): EvidenceCandidate {
  const associations = [...candidateAssociations(prior), ...candidateAssociations(next)];
  const unique = [...new Map(associations.map((item) => [`${item.claimId}|${item.queryId}`, item])).values()];
  const preferred = candidateProvider(prior) === "openalex" ? prior : candidateProvider(next) === "openalex" ? next : Number(next.score ?? 0) > Number(prior.score ?? 0) ? next : prior;
  return {
    ...preferred,
    metadata: { ...(preferred.metadata ?? {}), associations: unique },
    rights: prior.rights?.eligible ? prior.rights : next.rights,
    contentScope: prior.contentScope?.eligible ? prior.contentScope : next.contentScope,
  };
}

function overlapScore(needles: readonly string[], textTerms: ReadonlySet<string>): number {
  const unique = [...new Set(needles)];
  return unique.length ? unique.filter((term) => textTerms.has(term)).length / unique.length : 0;
}

export function deterministicCandidateRelevance(candidate: EvidenceCandidate, run: ResearchRun): number {
  const title = (candidate.title ?? "").toLocaleLowerCase("en-US");
  const abstract = (candidate.abstract ?? "").toLocaleLowerCase("en-US");
  const titleTerms = new Set(terms(title));
  const allTerms = new Set(terms(`${title} ${abstract}`));
  const claimById = new Map(run.claims.map((claim) => [claim.id, claim]));
  let best = 0;
  for (const item of candidateAssociations(candidate)) {
    const claim = claimById.get(item.claimId);
    if (!claim) continue;
    const claimTerms = terms(`${claim.statement} ${claim.operationalDefinition}`);
    const queryTerms = terms(item.query);
    const anchorTerms = item.anchors.flatMap(terms);
    const multiword = item.anchors.filter((anchor) => terms(anchor).length >= 2).some((anchor) => `${title} ${abstract}`.includes(anchor.toLocaleLowerCase("en-US")));
    let score = overlapScore(claimTerms, allTerms) * 0.48 + overlapScore(queryTerms, allTerms) * 0.24 + overlapScore(anchorTerms, allTerms) * 0.14 + overlapScore(claimTerms, titleTerms) * 0.09 + (multiword ? 0.05 : 0);
    const claimDomain = `${claim.statement} ${claim.operationalDefinition}`.toLocaleLowerCase("en-US");
    const crossDomain = /molecular|chemical|drug|protein|ligand/u.test(`${title} ${abstract}`) && /agent|language model|alignment|policy|objective|reward/u.test(claimDomain);
    if (crossDomain) score -= 0.75;
    if (/generic|broad survey|overview/u.test(title) && overlapScore(claimTerms, allTerms) < 0.35) score -= 0.25;
    best = Math.max(best, score);
  }
  return Math.max(0, Math.min(1, best));
}

function excerptFromChunk(text: string): string | null {
  const literal = text.trim();
  if (literal.length < 40) return null;
  if (literal.length <= 1_200) return literal;
  const clipped = literal.slice(0, 1_200);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > 1_000 ? boundary : 1_200).trim();
}

function stablePassageKey(value: { claimId?: string; subclaimId?: string; sourceId: string; sourceChunkId: string; excerpt: string }): string {
  return canonicalSha256({ claimId: value.claimId ?? value.subclaimId ?? "", sourceId: value.sourceId, sourceChunkId: value.sourceChunkId, excerptHash: canonicalSha256(value.excerpt) });
}

function chunkAssociationScore(text: string, item: CandidateAssociation, claim: ResearchRun["claims"][number] | undefined): number {
  const haystack = new Set(terms(text));
  return overlapScore(terms(`${claim?.statement ?? ""} ${claim?.operationalDefinition ?? ""}`), haystack) * 0.55 + overlapScore(terms(item.query), haystack) * 0.3 + overlapScore(item.anchors.flatMap(terms), haystack) * 0.15;
}

function passageProposals(imported: readonly WorkerAuditResult<ImportedCandidate>[], run: ResearchRun): PassageProposal[] {
  const proposals: PassageProposal[] = [];
  const seen = new Set<string>();
  const claimById = new Map(run.claims.map((claim) => [claim.id, claim]));
  for (const audit of imported) {
    if (!audit.value) continue;
    const { candidate, imported: sourceImport } = audit.value;
    for (const item of candidateAssociations(candidate)) {
      const rankedChunks = [...sourceImport.chunks]
        .map((chunk) => ({ chunk, score: chunkAssociationScore(chunk.text, item, claimById.get(item.claimId)) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
        .slice(0, 4);
      for (const { chunk } of rankedChunks) {
        const excerpt = excerptFromChunk(chunk.text);
        if (!excerpt) continue;
        const key = stablePassageKey({ claimId: item.claimId, sourceId: sourceImport.source.id, sourceChunkId: chunk.id, excerpt });
        if (seen.has(key)) continue;
        seen.add(key);
        proposals.push(PendingPassageSchema.parse({
          id: `proposal-${key}`,
          claimId: item.claimId,
          sourceId: sourceImport.source.id,
          sourceChunkId: chunk.id,
          sourceTitle: sourceImport.source.bibliographicMetadata.title,
          excerpt,
          queryId: item.queryId,
          sourceHash: sourceImport.source.contentHash,
          chunkHash: chunk.contentHash,
        }));
      }
    }
  }
  const balanced: PassageProposal[] = [];
  const add = (proposal: PassageProposal) => {
    if (balanced.length < MAX_PASSAGE_PROPOSALS && !balanced.some(({ id }) => id === proposal.id)) balanced.push(proposal);
  };
  for (const claimId of run.claims.map(({ id }) => id)) proposals.filter((proposal) => proposal.claimId === claimId).slice(0, 2).forEach(add);
  proposals.forEach(add);
  return balanced;
}

function estimatedProposalTokens(proposal: PassageProposal): number {
  return Math.ceil((proposal.excerpt.length + proposal.sourceTitle.length + proposal.claimId.length + 160) / CONSERVATIVE_CHARS_PER_TOKEN);
}

export function modelPassageBatches(values: readonly PassageProposal[]): PassageProposal[][] {
  const output: PassageProposal[][] = [];
  let current: PassageProposal[] = [];
  let tokens = MODEL_BATCH_BASE_TOKENS;
  for (const value of values) {
    const estimate = estimatedProposalTokens(value);
    if (current.length > 0 && (current.length >= MODEL_BATCH_MAX_ITEMS || tokens + estimate > MODEL_BATCH_TOKEN_BUDGET)) {
      output.push(current);
      current = [];
      tokens = MODEL_BATCH_BASE_TOKENS;
    }
    current.push(value);
    tokens += estimate;
  }
  if (current.length) output.push(current);
  return output;
}

async function evaluatePassageBatch(input: {
  adapter: StructuredGenerationAdapter;
  run: ResearchRun;
  batch: PassageProposal[];
  batchId: string;
  reviewer: boolean;
  primary?: PassageReview[];
  signal: AbortSignal;
  timeoutMs: number;
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
        ? "Independently audit every literal passage for direct relevance to exactly one approved claim. Do not defer to the primary. Reject generic background, keyword mentions, and cross-domain homonyms. Classify sourceType. settingAndSample is required only for empirical evidence and must be null for technical or theoretical evidence when not applicable. Return every proposal exactly once as schema-valid JSON."
        : "Judge every literal passage against the approved claims. Accept only direct claim-bearing evidence, never generic background or cross-domain homonyms. Classify sourceType. Do not invent a population, sample, or experiment: settingAndSample is required only for empirical evidence and may be null for technical or theoretical evidence. Return every proposal exactly once as schema-valid JSON.",
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  const generated = await input.adapter.generate({
    nodeId: input.reviewer ? `extract-evidence:independent-review-${input.batchId}` : `extract-evidence:primary-admission-${input.batchId}`,
    inputRefs: input.batch.map(({ id }) => id),
    outputRefs: [],
    promptId: input.reviewer ? "dual-evidence-admission-review" : "claim-grounded-passage-admission",
    promptVersion: "2.0.0",
    promptHash: canonicalSha256(messages),
    schemaVersion: "claim-grounded-passage-admission.v2",
    schemaName: "claim-grounded-passage-admission-output",
    outputSchema: passageReviewOutputSchema,
    outputJsonSchema: providerJsonSchema(z.toJSONSchema(passageReviewOutputSchema)),
    messages,
    settings: { temperature: 0, maxOutputTokens: 5_000, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
    timeoutMs: Math.max(1_000, Math.min(20_000, input.timeoutMs)),
    measured: false,
    repairInvalidOutput: true,
    maximumAttempts: 2,
    codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
    signal: input.signal,
  });
  if (!generated.ok) throw new CollectionGenerationFailure([generated]);
  const expected = new Set(input.batch.map(({ id }) => id));
  const returned = new Set(generated.value.reviews.map(({ proposalId }) => proposalId));
  if (returned.size !== expected.size || [...expected].some((id) => !returned.has(id))) throw new CollectionGenerationFailure([generated]);
  return { provider: input.adapter.identity.provider, fallbackUsed: false, reviews: generated.value.reviews, attempts: generated.attempts, errors: generated.errors };
}

function mayUseFallback(generation: PassageGeneration): boolean {
  const error = generation.errors.at(-1);
  return Boolean(error && (error.retryable || error.kind === "invalid_model_json" || error.kind === "invalid_model_output"));
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
  timeoutMs: number;
}): Promise<PassageEvaluationResult> {
  try {
    return await evaluatePassageBatch({ ...input, adapter: input.preferred });
  } catch (error) {
    if (!(error instanceof CollectionGenerationFailure)) throw error;
    const last = error.generations.at(-1);
    if (!last || !input.fallback || input.fallback.identity.provider === input.preferred.identity.provider || !mayUseFallback(last)) throw error;
    try {
      const recovered = await evaluatePassageBatch({ ...input, adapter: input.fallback, batchId: `${input.batchId}-fallback` });
      return { ...recovered, fallbackUsed: true, attempts: [...error.generations.flatMap(({ attempts }) => attempts), ...recovered.attempts], errors: [...error.generations.flatMap(({ errors }) => errors), ...recovered.errors] };
    } catch (fallbackError) {
      if (!(fallbackError instanceof CollectionGenerationFailure)) throw fallbackError;
      throw new CollectionGenerationFailure([...error.generations, ...fallbackError.generations]);
    }
  }
}

function expiredRun<T, TQuery>(items: readonly ResearchWorkItem<TQuery>[], now: () => number): ResearchRunResult<T> {
  const timestamp = now();
  return {
    results: items.map((item, index) => ({ itemId: item.id, index, status: "timed-out", finishedAt: timestamp, concurrencyAtStart: 0, fallbackUsed: false, signal: "timeout" })),
    progress: [],
    startedAt: timestamp,
    finishedAt: timestamp,
    cancelled: false,
    deadlineExceeded: true,
    finalConcurrency: 0,
  };
}

async function runBoundedPool<T, TQuery>(input: {
  items: readonly ResearchWorkItem<TQuery>[];
  config: ResearchConfig;
  remainingMs: number;
  now: () => number;
  signal?: AbortSignal;
  maxConcurrency?: number;
  worker: ResearchWorker<T, TQuery>;
}): Promise<ResearchRunResult<T>> {
  if (input.remainingMs < 100) return expiredRun(input.items, input.now);
  return runResearchWorkerPool(input.items, {
    config: {
      ...input.config,
      target: Math.max(1, input.items.length),
      minimum: 1,
      candidateCap: Math.max(1, Math.min(30, input.items.length)),
      maxConcurrency: input.maxConcurrency ?? input.config.maxConcurrency,
      perItemTimeoutMs: Math.max(1, Math.min(input.config.perItemTimeoutMs, Math.floor(input.remainingMs))),
      deadlineMs: Math.floor(input.remainingMs),
    },
    signal: input.signal,
    now: input.now,
    worker: input.worker,
  });
}

type EvaluationQuery = { batch: PassageProposal[]; primary: PassageReview[] };

async function runEvaluationStage(input: {
  items: Array<ResearchWorkItem<EvaluationQuery>>;
  run: ResearchRun;
  preferred: StructuredGenerationAdapter;
  fallback?: StructuredGenerationAdapter | null;
  reviewer: boolean;
  config: ResearchConfig;
  remainingMs: () => number;
  now: () => number;
  signal?: AbortSignal;
}): Promise<{ all: Array<WorkerAuditResult<PassageEvaluationResult>>; terminal: Array<WorkerAuditResult<PassageEvaluationResult>> }> {
  let queue = input.items;
  const all: Array<WorkerAuditResult<PassageEvaluationResult>> = [];
  const terminal: Array<WorkerAuditResult<PassageEvaluationResult>> = [];
  while (queue.length > 0) {
    const byId = new Map(queue.map((item) => [item.id, item]));
    const run = await runBoundedPool({
      items: queue,
      config: input.config,
      remainingMs: input.remainingMs(),
      now: input.now,
      signal: input.signal,
      maxConcurrency: 1,
      worker: (item, context) => evaluatePassageBatchWithFallback({
        preferred: input.preferred,
        fallback: input.fallback,
        run: input.run,
        batch: item.query.batch,
        primary: item.query.primary,
        batchId: item.id,
        reviewer: input.reviewer,
        signal: context.signal,
        timeoutMs: Math.max(1_000, context.deadlineAt - input.now()),
      }),
    });
    all.push(...run.results);
    const next: Array<ResearchWorkItem<EvaluationQuery>> = [];
    for (const audit of run.results) {
      const item = byId.get(audit.itemId);
      if (!item || audit.value || item.query.batch.length === 1 || input.remainingMs() < 1_000) {
        terminal.push(audit);
        continue;
      }
      const splitAt = Math.ceil(item.query.batch.length / 2);
      [item.query.batch.slice(0, splitAt), item.query.batch.slice(splitAt)].filter((batch) => batch.length > 0).forEach((batch, index) => {
        const ids = new Set(batch.map(({ id }) => id));
        next.push({ id: `${item.id}-split-${index + 1}`, query: { batch, primary: item.query.primary.filter(({ proposalId }) => ids.has(proposalId)) } });
      });
    }
    queue = next;
  }
  return { all, terminal };
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

function providerFailure(generation: PassageGeneration, stage: ProviderFailure["stage"], affectedPassages: number, itemId: string, round: number): ProviderFailure {
  const error = generation.errors.at(-1);
  const attempt = generation.attempts.at(-1);
  const httpStatus = error?.details.httpStatus ?? null;
  const code = httpStatus === 429 ? "rate_limited" : error?.kind === "timeout" ? "timeout" : error?.kind === "invalid_model_json" || error?.kind === "invalid_model_output" ? "invalid_output" : "provider_error";
  return ProviderFailureSchema.parse({ stage, provider: attempt?.requestedProvider ?? "unknown", code, httpStatus, attempts: generation.attempts.length || 1, affectedPassages, retryable: error?.retryable ?? false, itemId, round });
}

function failedProviderAudits(audits: readonly WorkerAuditResult<PassageEvaluationResult>[], stage: ProviderFailure["stage"], sizes: ReadonlyMap<string, number>, provider: string, round: number): ProviderFailure[] {
  return audits.flatMap((audit) => {
    if (audit.error instanceof CollectionGenerationFailure) return audit.error.generations.map((generation) => providerFailure(generation, stage, sizes.get(audit.itemId) ?? 0, audit.itemId, round));
    if (audit.status !== "failed" && audit.status !== "timed-out") return [];
    return [ProviderFailureSchema.parse({ stage, provider, code: audit.signal === "timeout" ? "timeout" : audit.signal === "429" ? "rate_limited" : "provider_error", httpStatus: audit.signal === "429" ? 429 : null, attempts: 1, affectedPassages: sizes.get(audit.itemId) ?? 0, retryable: audit.signal === "timeout" || audit.signal === "429" || audit.signal === "5xx", itemId: audit.itemId, round })];
  });
}

function selectVerifiedPassages<T extends { id: string; subclaimId: string; sourceId: string; selectionScore: number }>(passages: readonly T[], claimIds: readonly string[], incumbentIds: ReadonlySet<string> = new Set()): T[] {
  const ranked = [...passages].sort((left, right) => right.selectionScore - left.selectionScore || left.id.localeCompare(right.id));
  const incumbents = ranked.filter(({ id }) => incumbentIds.has(id));
  const selected: T[] = [];
  const sourceCounts = new Map<string, number>();
  const add = (passage: T | undefined) => {
    if (!passage || selected.length >= VERIFIED_PASSAGE_TARGET || selected.some(({ id }) => id === passage.id) || (sourceCounts.get(passage.sourceId) ?? 0) >= MAX_PASSAGES_PER_SOURCE) return;
    selected.push(passage);
    sourceCounts.set(passage.sourceId, (sourceCounts.get(passage.sourceId) ?? 0) + 1);
  };
  claimIds.forEach((claimId) => add(incumbents.find(({ subclaimId }) => subclaimId === claimId) ?? ranked.find(({ subclaimId }) => subclaimId === claimId)));
  incumbents.forEach(add);
  ranked.forEach(add);
  return selected;
}

function mergeDraftEntries(prior: readonly DraftEntry[], added: readonly DraftEntry[]): DraftEntry[] {
  const bySource = new Map(prior.map((entry) => [entry.source.id, entry]));
  for (const entry of added) {
    const existing = bySource.get(entry.source.id);
    if (!existing) {
      if (bySource.size < MAX_IMPORTED_SOURCES) bySource.set(entry.source.id, entry);
      continue;
    }
    if (existing.source.contentHash !== entry.source.contentHash) continue;
    const chunks = new Map(existing.chunks.map((chunk) => [chunk.id, chunk]));
    for (const chunk of entry.chunks) {
      const priorChunk = chunks.get(chunk.id);
      if (priorChunk && (priorChunk.sourceId !== chunk.sourceId || priorChunk.contentHash !== chunk.contentHash || priorChunk.text !== chunk.text)) throw new Error(`Chunk identity collision: ${chunk.id}`);
      chunks.set(chunk.id, chunk);
    }
    bySource.set(entry.source.id, { ...existing, chunks: [...chunks.values()].slice(0, 32) });
  }
  return [...bySource.values()];
}

function narrowedDraftEntries(entries: readonly DraftEntry[], references: readonly { sourceId: string; sourceChunkId: string }[]): DraftEntry[] {
  const sourceIds = new Set(references.map(({ sourceId }) => sourceId));
  const chunkIds = new Set(references.map(({ sourceChunkId }) => sourceChunkId));
  return entries.flatMap((entry) => {
    if (!sourceIds.has(entry.source.id)) return [];
    const chunks = entry.chunks.filter(({ id }) => chunkIds.has(id));
    return chunks.length ? [{ ...entry, chunks }] : [];
  });
}

async function verifyAndMerge(input: {
  run: ResearchRun;
  proposals: PassageProposal[];
  entries: DraftEntry[];
  queries: PlannedQuery[];
  searchAudits: SearchAudit[];
  candidatesConsidered: number;
  plannerFallbackUsed: boolean;
  rejectionCounts: RejectionCounts;
  verificationAttempt: number;
  roundsCompleted: number;
  prior: PacketVerification | null;
  currentProviderFailures: ProviderFailure[];
  blockingProviderFailure: boolean;
  config: ResearchConfig;
  adapters: ReturnType<typeof configuredResearchAdapters>;
  signal?: AbortSignal;
  remainingMs: () => number;
  now: () => number;
}) {
  const primaryItems: Array<ResearchWorkItem<EvaluationQuery>> = modelPassageBatches(input.proposals).map((batch, index) => ({ id: `verification-${input.verificationAttempt}-primary-${index + 1}`, query: { batch, primary: [] } }));
  const primary = await runEvaluationStage({ items: primaryItems, run: input.run, preferred: input.adapters.primary, fallback: input.adapters.fallback ?? null, reviewer: false, config: input.config, remainingMs: input.remainingMs, now: input.now, signal: input.signal });
  const primaryReviews = new Map(primary.terminal.flatMap((audit) => audit.value?.reviews ?? []).map((review) => [review.proposalId, review]));
  const reviewerCandidates = input.proposals.filter((proposal) => {
    const review = primaryReviews.get(proposal.id);
    return Boolean(review?.accepted && review.relevance >= MINIMUM_RELEVANCE && review.directness >= MINIMUM_DIRECTNESS);
  });
  const reviewerItems: Array<ResearchWorkItem<EvaluationQuery>> = modelPassageBatches(reviewerCandidates).map((batch, index) => ({ id: `verification-${input.verificationAttempt}-review-${index + 1}`, query: { batch, primary: batch.map(({ id }) => primaryReviews.get(id)!).filter(Boolean) } }));
  const reviewer = await runEvaluationStage({ items: reviewerItems, run: input.run, preferred: input.adapters.reviewer, fallback: null, reviewer: true, config: input.config, remainingMs: input.remainingMs, now: input.now, signal: input.signal });

  const primarySizes = new Map(primaryItems.map((item) => [item.id, item.query.batch.length]));
  const reviewerSizes = new Map(reviewerItems.map((item) => [item.id, item.query.batch.length]));
  for (const audit of primary.terminal) primarySizes.set(audit.itemId, audit.value?.reviews.length ?? primarySizes.get(audit.itemId.replace(/-split-\d+$/u, "")) ?? 1);
  for (const audit of reviewer.terminal) reviewerSizes.set(audit.itemId, audit.value?.reviews.length ?? reviewerSizes.get(audit.itemId.replace(/-split-\d+$/u, "")) ?? 1);
  const modelFailures = [
    ...failedProviderAudits(primary.terminal, "primary_admission", primarySizes, input.adapters.primary.identity.provider, input.verificationAttempt),
    ...failedProviderAudits(reviewer.terminal, "review", reviewerSizes, input.adapters.reviewer.identity.provider, input.verificationAttempt),
  ];
  const failedProposalIds = new Set([
    ...primary.terminal.flatMap((audit) => audit.value ? [] : primaryItems.find(({ id }) => audit.itemId.startsWith(id))?.query.batch.map(({ id }) => id) ?? []),
    ...reviewer.terminal.flatMap((audit) => audit.value ? [] : reviewerItems.find(({ id }) => audit.itemId.startsWith(id))?.query.batch.map(({ id }) => id) ?? []),
  ]);
  const sourceById = new Map(input.entries.map(({ source }) => [source.id, source]));
  const chunkById = new Map(input.entries.flatMap(({ chunks }) => chunks).map((chunk) => [chunk.id, chunk]));
  const primaryById = new Map<string, PassageReview & { provider: string; executionId: string }>();
  for (const audit of primary.terminal) {
    const executionId = audit.value?.attempts.at(-1)?.id;
    if (!audit.value || !executionId) continue;
    audit.value.reviews.forEach((review) => primaryById.set(review.proposalId, { ...review, provider: audit.value!.provider, executionId }));
  }
  const reviewerById = new Map<string, PassageReview & { provider: string; executionId: string }>();
  for (const audit of reviewer.terminal) {
    const executionId = audit.value?.attempts.at(-1)?.id;
    if (!audit.value || !executionId) continue;
    audit.value.reviews.forEach((review) => reviewerById.set(review.proposalId, { ...review, provider: audit.value!.provider, executionId }));
  }

  const counts = { ...input.rejectionCounts };
  counts.providerFailure += input.currentProviderFailures.length + modelFailures.length;
  const verifiedNew = input.proposals.flatMap((proposal) => {
    const primaryReview = primaryById.get(proposal.id);
    const reviewerReview = reviewerById.get(proposal.id);
    if (!primaryReview) return [];
    if (!primaryReview.accepted || primaryReview.relevance < MINIMUM_RELEVANCE || primaryReview.directness < MINIMUM_DIRECTNESS || primaryReview.matchedClaimId !== proposal.claimId || primaryReview.likelyRole === null || primaryReview.extractedResult === null || primaryReview.studyType === null || primaryReview.limitation === null || (primaryReview.sourceType === "empirical" && primaryReview.settingAndSample === null)) {
      counts.primaryRejected += 1;
      return [];
    }
    if (!reviewerReview) return [];
    if (!reviewerReview.accepted || reviewerReview.relevance < MINIMUM_RELEVANCE || reviewerReview.directness < MINIMUM_DIRECTNESS || reviewerReview.matchedClaimId !== primaryReview.matchedClaimId || reviewerReview.provider === primaryReview.provider) {
      counts.reviewerRejected += 1;
      return [];
    }
    const source = sourceById.get(proposal.sourceId);
    const chunk = chunkById.get(proposal.sourceChunkId);
    if (!source || !chunk || chunk.sourceId !== source.id || !chunk.text.includes(proposal.excerpt) || source.contentHash !== proposal.sourceHash || chunk.contentHash !== proposal.chunkHash || source.rights.mayStore !== "allowed" || source.rights.mayDisplay !== "allowed" || source.rights.maySendToModel !== "allowed" || chunk.displayPermission !== "allowed") {
      counts.literalValidationFailed += 1;
      return [];
    }
    const key = stablePassageKey(proposal);
    return [{
      id: `passage-${key}`,
      subclaimId: proposal.claimId,
      sourceId: proposal.sourceId,
      sourceChunkId: proposal.sourceChunkId,
      excerpt: proposal.excerpt,
      excerptHash: canonicalSha256(proposal.excerpt),
      queryId: proposal.queryId,
      likelyRole: primaryReview.likelyRole,
      extractedResult: primaryReview.extractedResult,
      sourceType: primaryReview.sourceType,
      settingAndSample: primaryReview.settingAndSample,
      studyType: primaryReview.studyType,
      limitation: primaryReview.limitation,
      extractionIssues: primaryReview.extractionIssues,
      selectionScore: (primaryReview.relevance + primaryReview.directness + reviewerReview.relevance + reviewerReview.directness) / 4,
      primary: { provider: primaryReview.provider, executionId: primaryReview.executionId, relevance: primaryReview.relevance, directness: primaryReview.directness, reason: primaryReview.reason },
      reviewer: { provider: reviewerReview.provider, executionId: reviewerReview.executionId, relevance: reviewerReview.relevance, directness: reviewerReview.directness, reason: reviewerReview.reason },
      deterministic: { literalMatch: true as const, anchorMatch: true as const, rightsEligible: true as const, sourceHash: proposal.sourceHash, chunkHash: proposal.chunkHash },
    }];
  });

  const verifiedByKey = new Map<string, PacketVerification["passages"][number]>();
  for (const passage of [...(input.prior?.passages ?? []), ...verifiedNew]) {
    const key = stablePassageKey(passage);
    const existing = verifiedByKey.get(key);
    if (!existing || passage.selectionScore > existing.selectionScore) verifiedByKey.set(key, passage);
  }
  const selected = selectVerifiedPassages([...verifiedByKey.values()], input.run.claims.map(({ id }) => id), new Set((input.prior?.passages ?? []).map(({ id }) => id)));
  const attemptedKeys = new Set(input.proposals.map(stablePassageKey));
  const newlyVerifiedKeys = new Set(verifiedNew.map(stablePassageKey));
  const pending = [...new Map([
    ...(input.prior?.pendingPassages ?? []).filter((proposal) => !attemptedKeys.has(stablePassageKey(proposal))).map((proposal) => [stablePassageKey(proposal), proposal] as const),
    ...input.proposals.filter((proposal) => failedProposalIds.has(proposal.id) && !newlyVerifiedKeys.has(stablePassageKey(proposal))).map((proposal) => [stablePassageKey(proposal), proposal] as const),
  ]).values()].slice(0, MAX_PASSAGE_PROPOSALS);
  const claimsCovered = [...new Set(selected.map(({ subclaimId }) => subclaimId))].sort();
  const claimsMissing = input.run.claims.map(({ id }) => id).filter((id) => !claimsCovered.includes(id));
  const ready = selected.length === VERIFIED_PASSAGE_TARGET && claimsMissing.length === 0;
  const status = ready ? "ready" as const : pending.length > 0 || input.blockingProviderFailure ? "provider_unavailable" as const : "evidence_shortfall" as const;
  const primaryGeneration = generationAudit(primary.all);
  const reviewerGeneration = generationAudit(reviewer.all);
  const providerFailures = [...(input.prior?.providerFailures ?? []), ...input.currentProviderFailures, ...modelFailures].slice(-100);
  const verification = {
    status,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    queries: input.queries.slice(-30),
    passages: selected,
    pendingPassages: pending,
    providerFailures,
    searchAudits: input.searchAudits.slice(-30),
    verificationAttempt: input.verificationAttempt,
    claimsCovered,
    claimsMissing,
    roundsCompleted: input.roundsCompleted,
    candidatesConsidered: input.candidatesConsidered,
    rejectionCounts: counts,
    plannerFallbackUsed: input.plannerFallbackUsed,
    primaryAttempts: [...(input.prior?.primaryAttempts ?? []), ...primaryGeneration.attempts],
    primaryErrors: [...(input.prior?.primaryErrors ?? []), ...primaryGeneration.errors],
    reviewerAttempts: [...(input.prior?.reviewerAttempts ?? []), ...reviewerGeneration.attempts],
    reviewerErrors: [...(input.prior?.reviewerErrors ?? []), ...reviewerGeneration.errors],
  };
  const draftSources = narrowedDraftEntries(input.entries, [...selected, ...pending]);
  return { draft: PacketDraftSchema.parse({ sources: draftSources, verification }), primary, reviewer, selected, pending, status, counts, providerFailures, claimsCovered, claimsMissing };
}

function openAlexSourceId(openAlexId: string): string {
  return `openalex-${openAlexId.replace(/^https:\/\/openalex\.org\//u, "").toLocaleLowerCase("en-US")}`;
}

function sourceIdForCandidate(candidate: EvidenceCandidate): string {
  return candidateProvider(candidate) === "firecrawl" ? candidate.id : openAlexSourceId(candidate.id);
}

function searchCandidateId(candidate: ScholarlyCandidate | FirecrawlCandidate): string {
  return "openAlexId" in candidate ? candidate.openAlexId : candidate.id;
}

function searchAuditFor(audit: WorkerAuditResult<SearchProviderResult>, query: PlannedQuery, providerHint: "openalex" | "firecrawl"): SearchAudit {
  const raw = audit.value?.raw;
  const status = raw?.status ?? (audit.status === "timed-out" ? "timed_out" : audit.value ? "completed" : "worker_failed");
  return SearchAuditSchema.parse({
    provider: audit.value?.provider ?? providerHint,
    queryId: query.id,
    claimId: query.claimId,
    query: query.query,
    status,
    failureCode: raw?.failureCode ?? (audit.status === "timed-out" ? "deadline_exceeded" : audit.value ? null : "provider_unavailable"),
    candidateIds: audit.value?.candidates.map(searchCandidateId).slice(0, 50) ?? [],
    pagesFetched: raw?.pagination?.pagesFetched ?? 0,
    truncated: raw?.pagination?.truncated ?? false,
    round: query.round,
  });
}

function searchFailure(audit: SearchAudit): ProviderFailure | null {
  if (!audit.failureCode) return null;
  const code = audit.failureCode === "rate_limited" ? "rate_limited" : audit.failureCode === "deadline_exceeded" ? "timeout" : audit.failureCode === "invalid_response" || audit.failureCode === "invalid_query" ? "invalid_output" : "provider_error";
  return ProviderFailureSchema.parse({ stage: "search", provider: audit.provider, code, httpStatus: audit.failureCode === "rate_limited" ? 429 : null, attempts: 1, affectedPassages: 0, retryable: ["rate_limited", "deadline_exceeded", "provider_unavailable", "cursor_loop"].includes(audit.failureCode), itemId: audit.queryId, round: audit.round });
}

function collectionResult(input: {
  verified: Awaited<ReturnType<typeof verifyAndMerge>>;
  now: () => number;
  startedAt: number;
  searchAudits?: Array<WorkerAuditResult<SearchProviderResult>>;
  importPool?: ResearchRunResult<ImportedCandidate>;
  currentCandidates?: EvidenceCandidate[];
}): AutomaticCollectionResult {
  const verification = input.verified.draft.verification!;
  const targetSources = Math.ceil(VERIFIED_PASSAGE_TARGET / MAX_PASSAGES_PER_SOURCE);
  const selectedSources = new Set(input.verified.draft.sources.map(({ source }) => source.id));
  return {
    draft: input.verified.draft,
    queries: verification.queries,
    candidatesConsidered: verification.candidatesConsidered,
    selectedCandidateIds: [...selectedSources],
    skipped: (input.currentCandidates ?? []).filter((candidate) => !selectedSources.has(sourceIdForCandidate(candidate))).map(({ id }) => ({ id, reason: "not-selected" })),
    usableSources: input.verified.draft.sources.length,
    targetSources,
    minimumSources: targetSources,
    verifiedPassages: verification.passages.length,
    targetPassages: VERIFIED_PASSAGE_TARGET,
    claimsCovered: verification.claimsCovered,
    claimsMissing: verification.claimsMissing,
    roundsCompleted: verification.roundsCompleted,
    rejectionCounts: verification.rejectionCounts,
    plannerFallbackUsed: verification.plannerFallbackUsed,
    status: verification.status,
    pendingPassages: verification.pendingPassages.length,
    providerFailures: verification.providerFailures,
    blocked: verification.status !== "ready",
    durationMs: input.now() - input.startedAt,
    searchAudits: input.searchAudits ?? [],
    primaryAudits: input.verified.primary.all,
    triageAudits: input.verified.primary.all,
    reviewerAudits: input.verified.reviewer.all,
    importAudits: input.importPool?.results ?? [],
  };
}

export async function collectAutomaticResearchPacket(input: {
  run: ResearchRun;
  currentDraft: unknown;
  mode?: "initial" | "deeper" | "retry_verification";
  config?: Partial<ResearchConfig>;
  openAlexApiKey: string;
  firecrawlApiKey?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  adapters?: ReturnType<typeof configuredResearchAdapters>;
  search?: typeof searchScholarlyWorks;
  webSearch?: typeof searchFirecrawl;
  importWork?: typeof importOpenAlexWork;
  now?: () => number;
}): Promise<AutomaticCollectionResult> {
  if (input.run.status !== "collecting_sources") throw new Error("Automatic collection requires the collecting_sources phase");
  const mode = input.mode ?? "initial";
  const config = parseResearchConfig(input.config ?? {});
  const adapters = input.adapters ?? configuredResearchAdapters();
  if (adapters.evidenceMode !== "live") throw new Error("Automatic research requires configured live providers");
  const now = input.now ?? Date.now;
  const startedAt = now();
  const overallDeadlineAt = startedAt + config.deadlineMs;
  const overallRemaining = () => Math.max(0, overallDeadlineAt - now());
  const currentDraft = PacketDraftSchema.parse(input.currentDraft ?? { sources: [] });
  const prior = currentDraft.verification;
  if (mode === "initial" && (prior?.passages.length ?? 0) > 0) throw new Error("initial collection cannot replace an existing verified packet; use deeper");
  if (mode === "deeper" && !prior) throw new Error("deeper collection requires a prior collection draft");

  if (mode === "retry_verification") {
    if (!prior || prior.pendingPassages.length === 0) throw new Error("retry_verification requires saved unresolved provider-failed passages");
    const verified = await verifyAndMerge({
      run: input.run,
      proposals: prior.pendingPassages,
      entries: currentDraft.sources,
      queries: prior.queries,
      searchAudits: prior.searchAudits,
      candidatesConsidered: prior.candidatesConsidered,
      plannerFallbackUsed: prior.plannerFallbackUsed,
      rejectionCounts: prior.rejectionCounts,
      verificationAttempt: prior.verificationAttempt + 1,
      roundsCompleted: prior.roundsCompleted,
      prior,
      currentProviderFailures: [],
      blockingProviderFailure: false,
      config,
      adapters,
      signal: input.signal,
      remainingMs: overallRemaining,
      now,
    });
    return collectionResult({ verified, now, startedAt });
  }

  const planned = await generateQueryPlan(input.run, adapters, mode, prior, overallRemaining(), input.signal);
  const roundQueries = prepareRoundQueries(input.run, planned.queries, prior);
  const queries = [...(prior?.queries ?? []), ...roundQueries].slice(-30);
  const sourcePhaseStartedAt = now();
  const sourceDeadlineAt = Math.min(overallDeadlineAt, sourcePhaseStartedAt + config.sourceDeadlineMs);
  const sourceRemaining = () => Math.max(0, sourceDeadlineAt - now());
  const searchItems = roundQueries.map((query) => ({ id: query.id, query }));
  const openAlexSearchPromise = runBoundedPool({
    items: searchItems,
    config,
    remainingMs: sourceRemaining(),
    now,
    signal: input.signal,
    maxConcurrency: Math.min(4, config.maxConcurrency),
    worker: async (item, context) => (input.search ?? searchScholarlyWorks)(item.query.query, {
      apiKey: input.openAlexApiKey,
      fetch: input.fetch,
      limits: { maxResults: OPENALEX_RESULTS_PER_QUERY, pageSize: 25, maxPages: OPENALEX_MAX_PAGES, deadlineMs: Math.max(100, Math.min(60_000, context.deadlineAt - now())) },
    }),
  });
  const firecrawlItems = input.firecrawlApiKey?.trim() ? searchItems : [];
  const firecrawlSearchPromise = runBoundedPool({
    items: firecrawlItems,
    config,
    remainingMs: sourceRemaining(),
    now,
    signal: input.signal,
    maxConcurrency: Math.min(2, config.maxConcurrency),
    worker: async (item, context) => (input.webSearch ?? searchFirecrawl)(item.query.query, {
      apiKey: input.firecrawlApiKey ?? "",
      signal: context.signal,
      maxResults: 12,
      deadlineMs: Math.max(500, Math.min(60_000, context.deadlineAt - now())),
    }),
  });
  const [openAlexSearchPool, firecrawlSearchPool] = await Promise.all([openAlexSearchPromise, firecrawlSearchPromise]);
  const planById = new Map(roundQueries.map((query) => [query.id, query]));
  const currentSearchAudits = openAlexSearchPool.results.flatMap((audit) => {
    const query = planById.get(audit.itemId);
    return query ? [searchAuditFor(audit, query, "openalex")] : [];
  }).concat(firecrawlSearchPool.results.flatMap((audit) => {
    const query = planById.get(audit.itemId);
    return query ? [searchAuditFor(audit, query, "firecrawl")] : [];
  }));
  const allSearchAudits = [...(prior?.searchAudits ?? []), ...currentSearchAudits].slice(-30);
  const searchFailures = currentSearchAudits.flatMap((audit) => searchFailure(audit) ?? []);
  const priorCombinations = new Set((prior?.searchAudits ?? []).flatMap((audit) => audit.candidateIds.map((id) => `${audit.provider}|${audit.query.trim().toLocaleLowerCase("en-US")}|${id}`)));
  const recordById = new Map<string, EvidenceCandidate>();
  let duplicateCombinations = 0;
  for (const audit of openAlexSearchPool.results) {
    if (!audit.value) continue;
    const plan = planById.get(audit.itemId);
    if (!plan) continue;
    audit.value.candidates.forEach((candidate, index) => {
      const combination = `openalex|${plan.query.trim().toLocaleLowerCase("en-US")}|${candidate.openAlexId}`;
      if (priorCombinations.has(combination)) {
        duplicateCombinations += 1;
        return;
      }
      const record = candidateRecord(candidate, plan, index + 1);
      const identity = automaticCandidateIdentity(record);
      const priorRecord = recordById.get(identity);
      recordById.set(identity, priorRecord ? mergeCandidateAssociation(priorRecord, record) : record);
    });
  }
  for (const audit of firecrawlSearchPool.results) {
    if (!audit.value) continue;
    const plan = planById.get(audit.itemId);
    if (!plan) continue;
    audit.value.candidates.forEach((candidate, index) => {
      const combination = `firecrawl|${plan.query.trim().toLocaleLowerCase("en-US")}|${candidate.id}`;
      if (priorCombinations.has(combination)) {
        duplicateCombinations += 1;
        return;
      }
      const record = firecrawlCandidateRecord(candidate, plan, index + 1);
      const identity = automaticCandidateIdentity(record);
      const priorRecord = recordById.get(identity);
      recordById.set(identity, priorRecord ? mergeCandidateAssociation(priorRecord, record) : record);
    });
  }

  const counts = { ...(prior?.rejectionCounts ?? emptyCounts()) };
  counts.duplicate += duplicateCombinations;
  const eligible: EvidenceCandidate[] = [];
  for (const candidate of recordById.values()) {
    if (candidate.rights?.eligible !== true) {
      counts.rightsIneligible += 1;
      continue;
    }
    if (candidate.contentScope?.eligible !== true) {
      counts.noPermittedText += 1;
      continue;
    }
    const relevance = deterministicCandidateRelevance(candidate, input.run);
    if (relevance < 0.18) {
      counts.offTopic += 1;
      continue;
    }
    const providerScore = normalizedProviderScore(Number(candidate.metadata?.providerRelevanceScore ?? 0));
    eligible.push({ ...candidate, score: relevance * 0.9 + providerScore * 0.1 });
  }
  const ranked = preRankCandidates(eligible).slice(0, MAX_IMPORTED_SOURCES);
  const existingBySource = new Map(currentDraft.sources.map((entry) => [entry.source.id, entry]));
  let remainingNewSources = Math.max(0, MAX_IMPORTED_SOURCES - existingBySource.size);
  const records = ranked.filter((candidate) => {
    if (existingBySource.has(sourceIdForCandidate(candidate))) return true;
    if (remainingNewSources <= 0) return false;
    remainingNewSources -= 1;
    return true;
  });
  const importItems = records.map((candidate) => ({ id: candidate.id, query: candidate }));
  const importPool = await runBoundedPool({
    items: importItems,
    config,
    remainingMs: sourceRemaining(),
    now,
    signal: input.signal,
    worker: async (item) => {
      const candidate = item.query;
      const existing = existingBySource.get(sourceIdForCandidate(candidate));
      if (existing) return { candidate, imported: { source: existing.source, chunks: existing.chunks, warnings: ["Reused previously imported source"] } };
      const relevantClaims = [...new Set(candidateAssociations(candidate).map(({ claimId }) => claimId))];
      const claims = input.run.claims.filter(({ id }) => relevantClaims.includes(id)).map(({ statement }) => statement);
      if (candidateProvider(candidate) === "firecrawl") {
        const webCandidate = candidate.metadata?.firecrawlCandidate as FirecrawlCandidate | undefined;
        if (!webCandidate) throw new Error("Firecrawl candidate metadata was unavailable at import");
        const result = importFirecrawlCandidate({ candidate: webCandidate, claims });
        if (result.chunks.length === 0) throw new Error("Selected Firecrawl source did not yield a licensed claim-overlapping passage");
        return { candidate, imported: result };
      }
      const license = String(candidate.metadata?.license ?? "");
      const result = await (input.importWork ?? importOpenAlexWork)({
        openAlexId: candidate.id,
        claims,
        rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: `Automatic import from ${license}; researcher freeze still required` },
      }, { apiKey: input.openAlexApiKey, fetch: input.fetch, trustedPdfOrigins: ["https://content.openalex.org"], pdfParser: unpdf });
      if (result.chunks.length === 0) throw new Error("Selected source did not yield a claim-overlapping permitted passage");
      return { candidate, imported: { ...result, chunks: result.chunks.slice(0, 6) } };
    },
  });
  counts.noPermittedText += importPool.results.filter((audit) => !audit.value && audit.signal !== "timeout" && audit.signal !== "429" && audit.signal !== "5xx").length;
  const importFailures = importPool.results.flatMap((audit) => {
    if (audit.value || !["timeout", "429", "5xx"].includes(audit.signal ?? "")) return [];
    const failedCandidate = records.find(({ id }) => id === audit.itemId);
    return [ProviderFailureSchema.parse({ stage: "import", provider: failedCandidate ? candidateProvider(failedCandidate) : "openalex", code: audit.signal === "429" ? "rate_limited" : audit.signal === "timeout" ? "timeout" : "provider_error", httpStatus: audit.signal === "429" ? 429 : null, attempts: 1, affectedPassages: 0, retryable: true, itemId: audit.itemId, round: (prior?.verificationAttempt ?? 0) + 1 })];
  });
  const addedEntries = importPool.results.flatMap((audit) => audit.value ? [{ source: audit.value.imported.source, chunks: audit.value.imported.chunks, importedAt: new Date(audit.finishedAt).toISOString() }] : []);
  const entries = mergeDraftEntries(currentDraft.sources, addedEntries);
  const proposals = passageProposals(importPool.results, input.run);
  const priorCandidateIds = new Set((prior?.searchAudits ?? []).flatMap(({ candidateIds }) => candidateIds));
  const currentCandidateIds = new Set(currentSearchAudits.flatMap(({ candidateIds }) => candidateIds));
  const newlyConsideredCandidates = [...currentCandidateIds].filter((id) => !priorCandidateIds.has(id)).length;
  const currentProviderFailures = [...searchFailures, ...importFailures];
  const verified = await verifyAndMerge({
    run: input.run,
    proposals,
    entries,
    queries,
    searchAudits: allSearchAudits,
    candidatesConsidered: (prior?.candidatesConsidered ?? 0) + newlyConsideredCandidates,
    plannerFallbackUsed: Boolean(prior?.plannerFallbackUsed || planned.fallbackUsed),
    rejectionCounts: counts,
    verificationAttempt: (prior?.verificationAttempt ?? 0) + 1,
    roundsCompleted: (prior?.roundsCompleted ?? 0) + 1,
    prior,
    currentProviderFailures,
    blockingProviderFailure: currentProviderFailures.length > 0,
    config,
    adapters,
    signal: input.signal,
    remainingMs: overallRemaining,
    now,
  });
  return collectionResult({ verified, now, startedAt, searchAudits: [...openAlexSearchPool.results, ...firecrawlSearchPool.results], importPool, currentCandidates: [...recordById.values()] });
}
