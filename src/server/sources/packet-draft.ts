import { z } from "zod";

import { SourceChunkSchema, SourceRecordSchema } from "../../contracts";

export const PacketDraftEntrySchema = z.object({
  source: SourceRecordSchema,
  chunks: z.array(SourceChunkSchema).max(32),
  importedAt: z.string().datetime({ offset: true }),
}).strict();

export const PacketDraftSchema = z.object({
  sources: z.array(PacketDraftEntrySchema).max(10),
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
  return PacketDraftSchema.parse({ sources: [...withoutPrior, entry] });
}

export function removeDraftSource(draftInput: unknown, sourceId: string): PacketDraft {
  const draft = PacketDraftSchema.parse(draftInput ?? { sources: [] });
  return PacketDraftSchema.parse({
    sources: draft.sources.filter(({ source }) => source.id !== sourceId),
  });
}

