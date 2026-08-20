import type { EvidenceCandidate, ResearchWorkItem } from "./types";

export function normalizeResearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
export function dedupeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const query of queries) {
    const normalized = normalizeResearchQuery(query);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(query.trim().replace(/\s+/g, " "));
  }
  return unique;
}

export function dedupeWorkItems<TQuery = string>(items: readonly ResearchWorkItem<TQuery>[]): ResearchWorkItem<TQuery>[] {
  const seen = new Set<string>();
  const output: ResearchWorkItem<TQuery>[] = [];
  for (const item of items) {
    const key = item.key ?? (typeof item.query === "string" ? normalizeResearchQuery(item.query) : item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
    if (parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString().toLocaleLowerCase("en-US");
  } catch {
    return url.trim().replace(/\/$/, "").toLocaleLowerCase("en-US");
  }
}

export function candidateIdentity(candidate: EvidenceCandidate): string {
  if (candidate.url?.trim()) return `url:${canonicalUrl(candidate.url)}`;
  return `id:${candidate.id.trim().toLocaleLowerCase("en-US")}`;
}

export function dedupeCandidates(candidates: readonly EvidenceCandidate[]): EvidenceCandidate[] {
  const seen = new Set<string>();
  const output: EvidenceCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateIdentity(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}
