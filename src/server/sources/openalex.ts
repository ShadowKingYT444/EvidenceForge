import { createOpenAlexDiscoveryClient, type OpenAlexCandidate, type OpenAlexDiscoveryResult } from "../retrieval/openalex";
import { normalizeDoi } from "../retrieval/doi";

export type ScholarlyCandidate = {
  openAlexId: string; title: string | null; canonicalDoi: string | null;
  publicationYear: number | null; authors: string[]; isOpenAccess: boolean;
  landingPageUrl: string | null; pdfUrl: string | null; license: string | null;
};

function stableId(id: string): string { return id.replace(/^https:\/\/openalex\.org\//u, ""); }

export function normalizeOpenAlexCandidate(candidate: OpenAlexCandidate): ScholarlyCandidate {
  const location = candidate.openAccessSignal.bestLocation ?? candidate.openAccessSignal.primaryLocation;
  return {
    openAlexId: stableId(candidate.openAlexId), title: candidate.title,
    canonicalDoi: candidate.canonicalDoi, publicationYear: candidate.publicationYear,
    authors: candidate.authors.map((author) => author.displayName),
    isOpenAccess: candidate.openAccessSignal.isOpenAccess,
    landingPageUrl: location?.landingPageUrl ?? null, pdfUrl: null,
    license: location?.licenseSignal ?? null,
  };
}

export type ScholarlySearchDependencies = {
  apiKey: string;
  fetch?: typeof fetch;
  evidenceMode?: "live" | "mocked" | "fixture";
};

export async function searchScholarlyWorks(query: string, dependencies: ScholarlySearchDependencies): Promise<{
  provider: "openalex"; query: string; candidates: ScholarlyCandidate[]; raw: OpenAlexDiscoveryResult;
}> {
  const client = createOpenAlexDiscoveryClient({
    apiKey: dependencies.apiKey, evidenceMode: dependencies.evidenceMode ?? "live",
    fetch: dependencies.fetch === undefined ? undefined : (input, init) => dependencies.fetch!(input, init),
    limits: { maxResults: 10, pageSize: 10, maxPages: 1 },
  });
  const raw = await client.discover(query);
  return { provider: "openalex", query, candidates: raw.candidates.map(normalizeOpenAlexCandidate), raw };
}

export type OpenAlexWorkMetadata = ScholarlyCandidate & { abstract: string | null; doi: string | null };

export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | null {
  if (!index || Object.keys(index).length === 0) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word;
  const abstract = words.filter(Boolean).join(" ").trim();
  return abstract || null;
}

export type UnpaywallResult = { doi: string; bestOaLocation: { url: string; pdfUrl: string | null; license: string | null } | null };

export async function lookupUnpaywall(doi: string, options: { email: string; fetch?: typeof fetch }): Promise<UnpaywallResult> {
  const normalized = normalizeDoi(doi);
  if (normalized.status !== "valid") throw new Error("A valid DOI is required for Unpaywall lookup");
  const response = await (options.fetch ?? fetch)(`https://api.unpaywall.org/v2/${encodeURIComponent(normalized.canonicalDoi)}?email=${encodeURIComponent(options.email)}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Unpaywall request failed (${response.status})`);
  const body = await response.json() as { best_oa_location?: { url?: string; url_for_pdf?: string | null; license?: string | null } | null };
  const location = body.best_oa_location;
  return { doi: normalized.canonicalDoi, bestOaLocation: location?.url ? { url: location.url, pdfUrl: location.url_for_pdf ?? null, license: location.license ?? null } : null };
}
