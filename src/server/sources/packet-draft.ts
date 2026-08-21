import { z } from "zod";

import { NodeExecutionSchema, RunErrorSchema, SourceChunkSchema, SourceRecordSchema } from "../../contracts";

export const VERIFIED_PASSAGE_TARGET = 10;

export const PlannedResearchQuerySchema = z.object({
  id: z.string().min(1).max(128),
  claimId: z.string().min(1).max(128),
  query: z.string().min(2).max(160),
  intent: z.enum(["direct", "challenge"]),
  anchors: z.array(z.string().min(2).max(80)).min(1).max(6),
  round: z.number().int().min(1).max(3),
}).strict();

const PassageDecisionSchema = z.object({
  provider: z.string().min(1),
  executionId: z.string().min(1),
  relevance: z.number().min(0).max(1),
  directness: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
}).strict();

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
  settingAndSample: z.string().min(1),
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
  status: z.enum(["ready", "shortfall"]),
  targetPassages: z.literal(VERIFIED_PASSAGE_TARGET),
  queries: z.array(PlannedResearchQuerySchema).max(10),
  passages: z.array(VerifiedPassageSchema).max(VERIFIED_PASSAGE_TARGET),
  claimsCovered: z.array(z.string()),
  claimsMissing: z.array(z.string()),
  roundsCompleted: z.number().int().min(0).max(3),
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
  sources: z.array(PacketDraftEntrySchema).max(10),
  verification: PacketVerificationSchema.nullable().default(null),
}).strict().superRefine(({ sources }, context) => {
  const ids = sources.map(({ source }) => source.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Draft source IDs must be unique" });
  }
});

export type PacketDraft = z.output<typeof PacketDraftSchema>;

export function addDraftSource(draftInput: unknown, entryInput: unknown): PacketDraft {
  const draft = PacketDraftSchema.parse(draftInput ?? { sources: [] });
  const entry = PacketDraftEntrySchema.parse(entryInput);
  const withoutPrior = draft.sources.filter(({ source }) => source.id !== entry.source.id);
  return PacketDraftSchema.parse({ sources: [...withoutPrior, entry], verification: null });
}

export function removeDraftSource(draftInput: unknown, sourceId: string): PacketDraft {
  const draft = PacketDraftSchema.parse(draftInput ?? { sources: [] });
  return PacketDraftSchema.parse({
    sources: draft.sources.filter(({ source }) => source.id !== sourceId),
    verification: null,
  });
}

