import { candidateIdentity, dedupeCandidates } from "./dedupe";
import type { EvidenceCandidate, RankedCandidate } from "./types";

function lexicalOverlap(candidate: EvidenceCandidate): number {
  if (!candidate.query) return 0;
  const queryTerms = new Set(candidate.query.toLocaleLowerCase("en-US").split(/\W+/).filter(Boolean));
  const text = `${candidate.title ?? ""} ${candidate.abstract ?? ""}`.toLocaleLowerCase("en-US");
  return [...queryTerms].filter((term) => text.includes(term)).length;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

/** Pure, stable pre-ranking. No network, clock, or random state is consulted. */
export function preRankCandidates(candidates: readonly EvidenceCandidate[]): RankedCandidate[] {
  const unique = dedupeCandidates(candidates);
  return unique
    .map((candidate, originalIndex) => {
      const providerScore = Number.isFinite(candidate.score) ? candidate.score! : 0;
      const rankBoost = Number.isFinite(candidate.rank) ? Math.max(0, 10_000 - candidate.rank!) / 10_000 : 0;
      const deterministicScore = providerScore + rankBoost + lexicalOverlap(candidate) * 0.001 + stableHash(candidateIdentity(candidate)) * 0.000001;
      return { ...candidate, deterministicScore, originalIndex };
    })
    .sort((left, right) => {
      const scoreOrder = right.deterministicScore - left.deterministicScore;
      if (Math.abs(scoreOrder) > Number.EPSILON) return scoreOrder;
      const idOrder = left.id.localeCompare(right.id, "en-US");
      return idOrder || left.originalIndex - right.originalIndex;
    });
}

export const rankCandidates = preRankCandidates;
