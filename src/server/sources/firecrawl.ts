import { createHash } from "node:crypto";

import { z } from "zod";

import { SourceChunkSchema, SourceRecordSchema } from "../../contracts";
import { normalizeDoi } from "../retrieval/doi";
import { rankClaimChunks } from "./chunking";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_PAGE_CHARACTERS = 160_000;
const DEFAULT_RESULTS = 12;

const firecrawlResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const firecrawlResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ web: z.array(firecrawlResultSchema).default([]) }).passthrough(),
  warning: z.string().nullable().optional(),
}).passthrough();

export type FirecrawlFailureCode = "deadline_exceeded" | "rate_limited" | "provider_unavailable" | "invalid_response" | "request_rejected";

export type FirecrawlCandidate = {
  id: string;
  url: string;
  title: string;
  description: string | null;
  markdown: string | null;
  category: string | null;
  license: string | null;
  canonicalDoi: string | null;
  authors: string[];
  publicationYear: number | null;
  rightsEligible: boolean;
};

export type FirecrawlSearchResult = {
  provider: "firecrawl";
  query: string;
  candidates: FirecrawlCandidate[];
  raw: {
    status: "completed" | "partial" | "failed" | "invalid_request";
    failureCode: FirecrawlFailureCode | "invalid_query" | null;
    httpStatus: number | null;
    pagination: { pagesFetched: number; truncated: boolean };
  };
};

export type FirecrawlSearchDependencies = {
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxResults?: number;
  deadlineMs?: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function privateHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (/^(?:127|0)\./u.test(normalized) || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.some((value) => value > 255) || octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
}

export function canonicalWebUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || privateHostname(parsed.hostname) || parsed.href.length > 2_048) return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
    for (const name of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|fbclid|mc_cid|mc_eid)$/iu.test(name)) parsed.searchParams.delete(name);
    }
    parsed.searchParams.sort();
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString();
  } catch {
    return null;
  }
}

function metadataString(metadata: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = metadata[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function recognizedWebLicense(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLocaleLowerCase("en-US").replace(/[_\s]+/gu, "-");
  return normalized === "cc0" || normalized.includes("public-domain") || /^cc-by(?:-|$)/u.test(normalized) || normalized.includes("creativecommons.org/licenses/by/");
}

function detectedDoi(url: string, content: string): string | null {
  const decoded = decodeURIComponent(url);
  const match = /10\.\d{4,9}\/[\w.()/:;-]+/iu.exec(`${decoded} ${content.slice(0, 8_000)}`);
  if (!match) return null;
  const normalized = normalizeDoi(match[0].replace(/[),.;]+$/u, ""));
  return normalized.status === "valid" ? normalized.canonicalDoi : null;
}

function candidate(result: z.infer<typeof firecrawlResultSchema>): FirecrawlCandidate | null {
  const url = canonicalWebUrl(result.url);
  if (!url) return null;
  const metadata = result.metadata ?? {};
  const markdown = result.markdown?.trim().slice(0, MAX_PAGE_CHARACTERS) || null;
  const license = metadataString(metadata, ["license", "dc.rights", "dcterms.rights", "citation_license", "copyright"]);
  const metadataDoi = metadataString(metadata, ["doi", "citation_doi", "dc.identifier", "dcterms.identifier"]);
  const normalizedMetadataDoi = metadataDoi ? normalizeDoi(metadataDoi) : null;
  const author = metadataString(metadata, ["author", "citation_author", "byline"]);
  const published = metadataString(metadata, ["publishedTime", "article:published_time", "citation_publication_date", "date"]);
  const year = published ? Number(/(?:19|20)\d{2}/u.exec(published)?.[0] ?? NaN) : NaN;
  return {
    id: `firecrawl-${sha256(url).slice(0, 32)}`,
    url,
    title: result.title?.trim() || metadataString(metadata, ["title", "ogTitle", "citation_title"]) || new URL(url).hostname,
    description: result.description?.trim() || metadataString(metadata, ["description", "ogDescription"]),
    markdown,
    category: result.category ?? null,
    license,
    canonicalDoi: normalizedMetadataDoi?.status === "valid" ? normalizedMetadataDoi.canonicalDoi : detectedDoi(url, markdown ?? result.description ?? ""),
    authors: author ? author.split(/\s*(?:;|\band\b)\s*/iu).filter(Boolean).slice(0, 20) : [],
    publicationYear: Number.isInteger(year) ? year : null,
    rightsEligible: recognizedWebLicense(license),
  };
}

function failure(query: string, failureCode: FirecrawlSearchResult["raw"]["failureCode"], status: FirecrawlSearchResult["raw"]["status"] = "failed", httpStatus: number | null = null): FirecrawlSearchResult {
  return { provider: "firecrawl", query, candidates: [], raw: { status, failureCode, httpStatus, pagination: { pagesFetched: 0, truncated: false } } };
}

function retryAfter(response: Response, now: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(2_000, Math.max(0, date - now)) : 250;
}

async function boundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  return text;
}

export async function searchFirecrawl(queryInput: string, dependencies: FirecrawlSearchDependencies): Promise<FirecrawlSearchResult> {
  const query = queryInput.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (query.length < 2 || query.length > 500 || /[\u0000-\u001f\u007f]/u.test(query)) return failure(queryInput, "invalid_query", "invalid_request");
  const apiKey = dependencies.apiKey.trim();
  if (!apiKey) return failure(query, "request_rejected");
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxResults = Math.max(1, Math.min(20, dependencies.maxResults ?? DEFAULT_RESULTS));
  const deadlineAt = now() + Math.max(500, Math.min(60_000, dependencies.deadlineMs ?? 20_000));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) return failure(query, "deadline_exceeded");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await fetcher(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query,
          limit: maxResults,
          sources: ["web"],
          categories: [{ type: "research" }, { type: "pdf" }],
          ignoreInvalidURLs: true,
          timeout: Math.min(60_000, remaining),
          scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true, parsers: ["pdf"], timeout: Math.min(30_000, remaining), removeBase64Images: true, blockAds: true },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      dependencies.signal?.removeEventListener("abort", onAbort);
      if (dependencies.signal?.aborted || now() >= deadlineAt || (error instanceof Error && error.name === "AbortError")) return failure(query, "deadline_exceeded");
      if (attempt < 2) { await sleep(Math.min(250, Math.max(0, deadlineAt - now() - 1))); continue; }
      return failure(query, "provider_unavailable");
    }
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", onAbort);

    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const delay = retryAfter(response, now());
        if (now() + delay < deadlineAt) { await sleep(delay); continue; }
      }
      return failure(query, response.status === 429 ? "rate_limited" : response.status >= 500 ? "provider_unavailable" : "request_rejected", "failed", response.status);
    }

    try {
      const parsed = firecrawlResponseSchema.parse(JSON.parse(await boundedBody(response)));
      if (!parsed.success) return failure(query, "provider_unavailable");
      const projected = parsed.data.web.map(candidate);
      const valid = projected.filter((value): value is FirecrawlCandidate => value !== null);
      const candidates = [...new Map(valid.map((value) => [value.url, value])).values()];
      const invalid = projected.length - valid.length;
      return {
        provider: "firecrawl",
        query,
        candidates,
        raw: {
          status: invalid > 0 || parsed.warning ? "partial" : "completed",
          failureCode: invalid > 0 ? "invalid_response" : null,
          httpStatus: 200,
          pagination: { pagesFetched: 1, truncated: candidates.length >= maxResults },
        },
      };
    } catch {
      return failure(query, "invalid_response");
    }
  }
  return failure(query, "provider_unavailable");
}

export function importFirecrawlCandidate(input: { candidate: FirecrawlCandidate; claims: readonly string[]; now?: Date }) {
  const now = (input.now ?? new Date()).toISOString();
  const permitted = input.candidate.rightsEligible && Boolean(input.candidate.markdown);
  const ranked = permitted
    ? input.claims.flatMap((claim) => rankClaimChunks({ sourceId: input.candidate.id, text: input.candidate.markdown!, claim, location: input.candidate.url, maxChunks: 32 }))
    : [];
  const unique = [...new Map(ranked.map((chunk) => [chunk.contentHash, chunk])).values()].slice(0, 32);
  const content = unique.map(({ text }) => text).join("\n\n");
  const rights = {
    mayStore: permitted ? "allowed" as const : "unknown" as const,
    mayDisplay: permitted ? "allowed" as const : "unknown" as const,
    maySendToModel: permitted ? "allowed" as const : "unknown" as const,
    basis: permitted ? `Firecrawl page metadata reports ${input.candidate.license}` : "No explicit reusable-content license was reported by the page",
    checkedAt: now,
  };
  const source = SourceRecordSchema.parse({
    id: input.candidate.id,
    originalInput: input.candidate.url,
    canonicalDoi: input.candidate.canonicalDoi,
    canonicalUrl: input.candidate.url,
    doiResolution: { syntax: input.candidate.canonicalDoi ? "valid" : "not_provided", resolution: "not_checked", registrationAgency: null, checkedAt: null },
    bibliographicMetadata: { title: input.candidate.title, authors: input.candidate.authors, year: input.candidate.publicationYear, venue: new URL(input.candidate.url).hostname, studyType: null },
    access: { origin: "live_discovery", contentScope: unique.length ? "full_text" : "metadata_only", provider: "firecrawl", version: null, location: input.candidate.url, retrievedAt: now },
    rights,
    contentHash: sha256(content),
    metadataVerification: { status: "not_checked", method: "Firecrawl page metadata", checkedAt: null, fieldDiffs: [] },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: permitted ? ["Web evidence is limited to the licensed page content returned by Firecrawl."] : ["Page content was discovery-only because no explicit reusable-content license was reported."],
  });
  const chunks = unique.map((chunk) => SourceChunkSchema.parse({ id: chunk.id, sourceId: source.id, text: chunk.text, location: chunk.location, contentHash: chunk.contentHash, displayPermission: rights.mayDisplay }));
  return { source, chunks, warnings: source.warnings };
}
