import { z } from "zod";

import { canonicalSha256, NodeExecutionSchema, RunErrorSchema, SourceChunkSchema, SourceRecordSchema } from "../../contracts";

export const VERIFIED_PASSAGE_TARGET = 10;

export const PlannedResearchQuerySchema = z.object({
  id: z.string().min(1).max(128),
  claimId: z.string().min(1).max(128),
  query: z.string().min(2).max(160),
  intent: z.enum(["direct", "challenge", "limitation", "mechanism", "evaluation"]),
  anchors: z.array(z.string().min(2).max(80)).min(1).max(6),
  round: z.number().int().min(1).max(30),
}).strict();

const PassageDecisionSchema = z.object({
  provider: z.string().min(1),
  executionId: z.string().min(1),
  relevance: z.number().min(0).max(1),
  directness: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
}).strict();

export const SourceTypeSchema = z.enum(["empirical", "technical", "theoretical", "review", "unknown"]);

export const VerifiedPassageSchema = z.object({
  id: z.string().min(1),
  subclaimId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceChunkId: z.string().min(1),
  excerpt: z.string().min(40).max(1_200),
  excerptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  queryId: z.string().min(1),
  likelyRole: z.enum(["support", "challenge"]),
  extractedResult: z.string().min(1),
  sourceType: SourceTypeSchema.default("empirical"),
  settingAndSample: z.string().min(1).nullable(),
  studyType: z.string().min(1),
  limitation: z.string().min(1),
  extractionIssues: z.array(z.string()),
  selectionScore: z.number().min(0).max(1),
  primary: PassageDecisionSchema,
  reviewer: PassageDecisionSchema,
  deterministic: z.object({
    literalMatch: z.literal(true),
    anchorMatch: z.literal(true),
    rightsEligible: z.literal(true),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    chunkHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();

export const PendingPassageSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceChunkId: z.string().min(1),
  sourceTitle: z.string().min(1),
  excerpt: z.string().min(40).max(1_200),
  queryId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  chunkHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const ProviderFailureSchema = z.object({
  stage: z.enum(["query_plan", "search", "import", "primary_admission", "review"]),
  provider: z.string().min(1),
  code: z.enum(["rate_limited", "timeout", "provider_error", "invalid_output"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  attempts: z.number().int().positive(),
  affectedPassages: z.number().int().nonnegative(),
  retryable: z.boolean(),
  itemId: z.string().min(1).nullable().default(null),
  round: z.number().int().positive().default(1),
}).strict();

export const SearchAuditSchema = z.object({
  queryId: z.string().min(1),
  claimId: z.string().min(1),
  query: z.string().min(1),
  status: z.enum(["completed", "partial", "failed", "invalid_request", "timed_out", "worker_failed"]),
  failureCode: z.enum(["invalid_query", "deadline_exceeded", "rate_limited", "provider_unavailable", "invalid_response", "request_rejected", "cursor_loop"]).nullable(),
  candidateIds: z.array(z.string().min(1)).max(50),
  pagesFetched: z.number().int().nonnegative(),
  truncated: z.boolean(),
  round: z.number().int().positive(),
}).strict();

const RejectionCountsSchema = z.object({
  offTopic: z.number().int().nonnegative(),
  noPermittedText: z.number().int().nonnegative(),
  rightsIneligible: z.number().int().nonnegative(),
  primaryRejected: z.number().int().nonnegative(),
  reviewerRejected: z.number().int().nonnegative(),
  providerFailure: z.number().int().nonnegative(),
  literalValidationFailed: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
}).strict();

export const PacketVerificationSchema = z.object({
  status: z.enum(["ready", "evidence_shortfall", "provider_unavailable"]),
  targetPassages: z.literal(VERIFIED_PASSAGE_TARGET),
  queries: z.array(PlannedResearchQuerySchema).max(30),
  passages: z.array(VerifiedPassageSchema).max(VERIFIED_PASSAGE_TARGET),
  pendingPassages: z.array(PendingPassageSchema).max(40),
  providerFailures: z.array(ProviderFailureSchema).max(100),
  searchAudits: z.array(SearchAuditSchema).max(30).default([]),
  verificationAttempt: z.number().int().positive(),
  claimsCovered: z.array(z.string()),
  claimsMissing: z.array(z.string()),
  roundsCompleted: z.number().int().min(0).max(30),
  candidatesConsidered: z.number().int().nonnegative(),
  rejectionCounts: RejectionCountsSchema,
  plannerFallbackUsed: z.boolean(),
  primaryAttempts: z.array(NodeExecutionSchema),
  primaryErrors: z.array(RunErrorSchema),
  reviewerAttempts: z.array(NodeExecutionSchema),
  reviewerErrors: z.array(RunErrorSchema),
}).strict();

export const PacketDraftEntrySchema = z.object({
  source: SourceRecordSchema,
  chunks: z.array(SourceChunkSchema).max(32),
  importedAt: z.string().datetime({ offset: true }),
}).strict();

export const PacketDraftSchema = z.object({
  sources: z.array(PacketDraftEntrySchema).max(20),
  verification: PacketVerificationSchema.nullable().default(null),
}).strict().superRefine(({ sources, verification }, context) => {
  const sourceIds = sources.map(({ source }) => source.id);
  if (new Set(sourceIds).size !== sourceIds.length) context.addIssue({ code: "custom", path: ["sources"], message: "Draft source IDs must be unique" });

  const chunks = sources.flatMap(({ chunks: entryChunks }) => entryChunks);
  const chunkIds = chunks.map(({ id }) => id);
  if (new Set(chunkIds).size !== chunkIds.length) context.addIssue({ code: "custom", path: ["sources"], message: "Draft chunk IDs must be globally unique" });

  const sourceById = new Map(sources.map(({ source }) => [source.id, source]));
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const [entryIndex, entry] of sources.entries()) {
    for (const [chunkIndex, chunk] of entry.chunks.entries()) {
      if (chunk.sourceId !== entry.source.id) context.addIssue({ code: "custom", path: ["sources", entryIndex, "chunks", chunkIndex, "sourceId"], message: "Chunk sourceId must match its containing source" });
    }
  }

  if (!verification) return;
  const verifiedIds = verification.passages.map(({ id }) => id);
  const pendingIds = verification.pendingPassages.map(({ id }) => id);
  if (new Set(verifiedIds).size !== verifiedIds.length || new Set(pendingIds).size !== pendingIds.length) context.addIssue({ code: "custom", path: ["verification"], message: "Passage IDs must be unique within verified and pending sets" });

  const checkReference = (passage: { sourceId: string; sourceChunkId: string; excerpt: string }, sourceHash: string, chunkHash: string, path: (string | number)[], excerptHash?: string) => {
    const source = sourceById.get(passage.sourceId);
    const chunk = chunkById.get(passage.sourceChunkId);
    if (!source || !chunk || chunk.sourceId !== passage.sourceId || source.contentHash !== sourceHash || chunk.contentHash !== chunkHash || !chunk.text.includes(passage.excerpt) || (excerptHash !== undefined && canonicalSha256(passage.excerpt) !== excerptHash)) context.addIssue({ code: "custom", path, message: "Passage must reference matching source and chunk records with intact hashes" });
  };
  verification.passages.forEach((passage, index) => checkReference(passage, passage.deterministic.sourceHash, passage.deterministic.chunkHash, ["verification", "passages", index], passage.excerptHash));
  verification.pendingPassages.forEach((passage, index) => checkReference(passage, passage.sourceHash, passage.chunkHash, ["verification", "pendingPassages", index]));
});

export type PacketDraft = z.output<typeof PacketDraftSchema>;
export type SearchAudit = z.output<typeof SearchAuditSchema>;

export function addDraftSource(draftInput: unknown, entryInput: unknown): PacketDraft {
  const draft = PacketDraftSchema.parse(draftInput ?? { sources: [] });
  const entry = PacketDraftEntrySchema.parse(entryInput);
  const withoutPrior = draft.sources.filter(({ source }) => source.id !== entry.source.id);
  return PacketDraftSchema.parse({ sources: [...withoutPrior, entry], verification: null });
}

export function removeDraftSource(draftInput: unknown, sourceId: string): PacketDraft {
  const draft = PacketDraftSchema.parse(draftInput ?? { sources: [] });
  return PacketDraftSchema.parse({ sources: draft.sources.filter(({ source }) => source.id !== sourceId), verification: null });
}
