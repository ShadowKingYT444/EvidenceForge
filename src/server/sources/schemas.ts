import { z } from "zod";

const rightsState = z.enum(["allowed", "denied", "unknown"]);

export const SourceRightsRequestSchema = z.object({
  mayStore: rightsState.default("unknown"),
  mayDisplay: rightsState.default("unknown"),
  maySendToModel: rightsState.default("unknown"),
  permissionBasis: z.string().trim().min(1).max(1_000).nullable().optional(),
  checkedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export const OpenAlexSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(10).default(10),
}).strict();

export const OpenAlexSearchResponseSchema = z.object({
  provider: z.literal("openalex"),
  query: z.string(),
  candidates: z.array(z.object({
    openAlexId: z.string(), title: z.string().nullable(),
    canonicalDoi: z.string().nullable(), publicationYear: z.number().nullable(),
    authors: z.array(z.string()), isOpenAccess: z.boolean(),
    landingPageUrl: z.string().url().nullable(), pdfUrl: z.string().url().nullable(),
    license: z.string().nullable(),
  }).strict()),
}).strict();

export const OpenAlexImportRequestSchema = z.object({
  openAlexId: z.string().regex(/^W\d+$/u),
  rights: SourceRightsRequestSchema,
}).strict();

export const PasteSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  text: z.string().trim().min(1).max(160_000),
  authors: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  year: z.number().int().min(1000).max(9999).nullable().optional(),
  venue: z.string().trim().max(500).nullable().optional(),
  originalInput: z.string().trim().min(1).max(4_000),
  rights: SourceRightsRequestSchema,
}).strict();

export const UploadSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  originalInput: z.string().trim().min(1).max(4_000),
  rights: SourceRightsRequestSchema,
}).strict();

export type SourceRightsRequest = z.input<typeof SourceRightsRequestSchema>;
export type OpenAlexSearchRequest = z.infer<typeof OpenAlexSearchRequestSchema>;
export type PasteSourceRequest = z.infer<typeof PasteSourceRequestSchema>;
export type UploadSourceRequest = z.infer<typeof UploadSourceRequestSchema>;
