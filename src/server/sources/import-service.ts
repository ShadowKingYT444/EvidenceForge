import { createHash } from "node:crypto";
import { z } from "zod";
import { SourceChunkSchema, SourceRecordSchema } from "../../contracts";
import { normalizeDoi } from "../retrieval/doi";
import { downloadBoundedPdf } from "./download";
import { extractPdfText, type UnpdfLikeModule } from "./pdf";
import { rankClaimChunks } from "./chunking";
import { abstractFromInvertedIndex } from "./openalex";
import type { SourceRightsRequest } from "./schemas";

const workResponseSchema = z.object({
  id: z.string(), doi: z.string().nullable().optional(), title: z.string().nullable().optional(),
  publication_year: z.number().int().nullable().optional(),
  authorships: z.array(z.object({ author: z.object({ display_name: z.string() }).passthrough() }).passthrough()).default([]),
  primary_location: z.unknown().nullable().optional(), best_oa_location: z.unknown().nullable().optional(),
  open_access: z.object({ is_oa: z.boolean().default(false), oa_status: z.string().nullable().optional() }).passthrough().default({ is_oa: false }),
  abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullable().optional(),
}).passthrough();

type WorkLocation = { landing_page_url?: string | null; pdf_url?: string | null; license?: string | null; version?: string | null; source?: { display_name?: string | null } | null };
function location(value: unknown): WorkLocation | null { return value && typeof value === "object" ? value as WorkLocation : null; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function rightsDecision(rights: SourceRightsRequest | undefined, now: string) {
  return { mayStore: rights?.mayStore ?? "unknown", mayDisplay: rights?.mayDisplay ?? "unknown", maySendToModel: rights?.maySendToModel ?? "unknown", basis: rights?.permissionBasis ?? "No explicit permission basis was recorded", checkedAt: rights?.checkedAt ?? now } as const;
}
function canonicalId(id: string): string { return id.replace(/^https:\/\/openalex\.org\//u, ""); }

type SourceRecord = z.output<typeof SourceRecordSchema>;
type SourceChunk = z.output<typeof SourceChunkSchema>;
export type ImportedSource = { source: SourceRecord; chunks: SourceChunk[]; warnings: string[] };
export type OpenAlexImportServiceDependencies = {
  apiKey?: string; fetch?: typeof fetch; now?: () => Date;
  trustedPdfOrigins?: readonly string[]; pdfParser?: UnpdfLikeModule;
};

export async function importOpenAlexWork(input: { openAlexId: string; claims: readonly string[]; rights?: SourceRightsRequest }, dependencies: OpenAlexImportServiceDependencies): Promise<ImportedSource> {
  const id = canonicalId(input.openAlexId);
  if (!/^W\d+$/u.test(id)) throw new Error("OpenAlex work ID must be W followed by digits");
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const fetcher = dependencies.fetch ?? fetch;
  const workUrl = new URL(`https://api.openalex.org/works/${encodeURIComponent(id)}`);
  if (dependencies.apiKey?.trim()) workUrl.searchParams.set("api_key", dependencies.apiKey.trim());
  const response = await fetcher(workUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenAlex work lookup failed (${response.status})`);
  const work = workResponseSchema.parse(await response.json());
  const oa = location(work.best_oa_location) ?? location(work.primary_location);
  const doi = normalizeDoi(work.doi ?? null);
  const sourceId = `openalex-${id.toLowerCase()}`;
  const warnings: string[] = [];
  if (work.open_access.is_oa !== true) warnings.push("OpenAlex does not report this work as open access.");
  if (oa?.license == null) warnings.push("Open-access license was not reported; rights require researcher confirmation.");
  let text: string | null = null;
  let contentScope: "metadata_only" | "abstract" | "full_text" = "metadata_only";
  let locationLabel = oa?.landing_page_url ?? `https://openalex.org/${id}`;
  const rights = rightsDecision(input.rights, now);
  if (rights.mayStore !== "allowed" || rights.mayDisplay !== "allowed" || rights.maySendToModel !== "allowed") {
    warnings.push("Text was not imported because storage or model-use permission is not allowed.");
  } else if (oa?.pdf_url && dependencies.pdfParser && dependencies.trustedPdfOrigins?.length) {
    try {
      const providerReportedOrigin = new URL(oa.pdf_url).origin;
      const pdf = await downloadBoundedPdf(oa.pdf_url, {
        trustedOrigins: [
          ...dependencies.trustedPdfOrigins,
          providerReportedOrigin,
        ],
        fetch: fetcher,
      });
      text = (await extractPdfText(pdf.bytes, dependencies.pdfParser)).text || null;
      if (text) contentScope = "full_text";
      locationLabel = pdf.finalUrl;
    } catch (error) { warnings.push(`PDF text extraction unavailable: ${error instanceof Error ? error.message : "unknown error"}`); }
  } else {
    warnings.push("No permitted, parser-ready open-access PDF was available.");
  }
  if (text === null && rights.mayStore === "allowed" && rights.mayDisplay === "allowed" && rights.maySendToModel === "allowed") {
    const abstract = abstractFromInvertedIndex(work.abstract_inverted_index);
    if (abstract) {
      text = abstract;
      contentScope = "abstract";
      locationLabel = `https://openalex.org/${id} · abstract`;
      warnings.push("Full text was unavailable; analysis is limited to the OpenAlex abstract.");
    }
  }
  const claims = input.claims.map((claim) => claim.trim()).filter(Boolean);
  const chunks = text && claims.length ? claims.flatMap((claim) => rankClaimChunks({ sourceId, text: text!, claim, location: locationLabel, maxChunks: 32 })) : [];
  const unique = [...new Map(chunks.map((chunk) => [chunk.contentHash, chunk])).values()].slice(0, 32);
  const content = unique.map(({ text: value }) => value).join("\n\n");
  const record = SourceRecordSchema.parse({ id: sourceId, originalInput: `https://openalex.org/${id}`, canonicalDoi: doi.status === "valid" ? doi.canonicalDoi : null, canonicalUrl: oa?.landing_page_url ?? null, doiResolution: { syntax: doi.status === "valid" ? "valid" : "not_provided", resolution: "not_checked", registrationAgency: null, checkedAt: null }, bibliographicMetadata: { title: work.title?.trim() || `OpenAlex work ${id}`, authors: work.authorships.map(({ author }) => author.display_name), year: work.publication_year ?? null, venue: oa?.source?.display_name ?? null, studyType: null }, access: { origin: "live_discovery", contentScope: unique.length ? contentScope : "metadata_only", provider: "openalex", version: oa?.version ?? null, location: locationLabel, retrievedAt: now }, rights, contentHash: sha256(content), metadataVerification: { status: "not_checked", method: "OpenAlex work metadata", checkedAt: null, fieldDiffs: [] }, integrityNotices: [], mergedSourceIds: [], warnings });
  return { source: record, chunks: unique.map((chunk) => SourceChunkSchema.parse({ id: chunk.id, sourceId, text: chunk.text, location: chunk.location, contentHash: chunk.contentHash, displayPermission: rights.mayDisplay })) , warnings };
}

export function createPastedSource(input: { id: string; title: string; text: string; claims: readonly string[]; originalInput: string; authors?: readonly string[]; year?: number | null; venue?: string | null; rights?: SourceRightsRequest; now?: Date }): ImportedSource {
  const now = (input.now ?? new Date()).toISOString();
  const rights = rightsDecision(input.rights, now);
  const text = input.text.trim();
  const chunks = input.claims.flatMap((claim) => rankClaimChunks({ sourceId: input.id, text, claim, location: "pasted excerpt" }));
  const unique = [...new Map(chunks.map((chunk) => [chunk.contentHash, chunk])).values()].slice(0, 32);
  const textAllowed = rights.mayStore === "allowed" && rights.mayDisplay === "allowed" && rights.maySendToModel === "allowed";
  const warnings = textAllowed ? [] : ["Pasted text is not imported until storage, display, and model-use permission are all allowed."];
  const permittedChunks = textAllowed ? unique : [];
  const storedText = permittedChunks.map(({ text: value }) => value).join("\n\n");
  const source = SourceRecordSchema.parse({ id: input.id, originalInput: input.originalInput, canonicalDoi: null, canonicalUrl: null, doiResolution: { syntax: "not_provided", resolution: "not_checked", registrationAgency: null, checkedAt: null }, bibliographicMetadata: { title: input.title.trim(), authors: [...(input.authors ?? [])], year: input.year ?? null, venue: input.venue ?? null, studyType: null }, access: { origin: "user_import", contentScope: permittedChunks.length ? "user_excerpt" : "metadata_only", provider: "researcher", version: null, location: "pasted excerpt", retrievedAt: now }, rights, contentHash: sha256(storedText), metadataVerification: { status: "not_checked", method: "Researcher-provided metadata", checkedAt: null, fieldDiffs: [] }, integrityNotices: [], mergedSourceIds: [], warnings });
  return { source, chunks: permittedChunks.map((chunk) => SourceChunkSchema.parse({ id: chunk.id, sourceId: input.id, text: chunk.text, location: chunk.location, contentHash: chunk.contentHash, displayPermission: rights.mayDisplay })), warnings };
}
