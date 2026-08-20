import { parseResearchConfig, type ResearchConfig } from "./config";
import { candidateIdentity } from "./dedupe";
import { preRankCandidates } from "./ranking";
import type { EvidenceCandidate, EvidencePacket, PacketSelectionRejection, RankedCandidate } from "./types";

export function hasExplicitRightsEligibility(candidate: EvidenceCandidate): boolean {
  return candidate.rights?.eligible === true || candidate.rightsEligible === true;
}

export function hasExplicitContentScopeEligibility(candidate: EvidenceCandidate): boolean {
  return candidate.contentScope?.eligible === true || candidate.contentScopeEligible === true;
}

export function isPacketEligible(candidate: EvidenceCandidate): boolean {
  return hasExplicitRightsEligibility(candidate) && hasExplicitContentScopeEligibility(candidate);
}

export interface PacketSelectionOptions extends Partial<ResearchConfig> {
  config?: ResearchConfig;
}

/**
 * Selects a bounded packet with deterministic ordering. When both roles exist,
 * one item from each role is reserved before filling remaining target slots.
 */
export function selectEvidencePacket(
  candidates: readonly EvidenceCandidate[],
  options: PacketSelectionOptions | ResearchConfig = {},
): EvidencePacket {
  const config = "config" in options && options.config ? options.config : parseResearchConfig(options);
  const ranked = preRankCandidates(candidates);
  const rejections: PacketSelectionRejection[] = [];
  const seen = new Set<string>();
  const withinCap: RankedCandidate[] = [];

  for (const candidate of ranked) {
    const identity = candidateIdentity(candidate);
    if (seen.has(identity)) {
      rejections.push({ candidate, reason: "duplicate" });
      continue;
    }
    seen.add(identity);
    if (!isPacketEligible(candidate)) {
      rejections.push({ candidate, reason: hasExplicitRightsEligibility(candidate) ? "content-scope-ineligible" : "rights-ineligible" });
      continue;
    }
    if (withinCap.length >= config.candidateCap) {
      rejections.push({ candidate, reason: "candidate-cap" });
      continue;
    }
    withinCap.push(candidate);
  }

  const selected: RankedCandidate[] = [];
  const add = (candidate: RankedCandidate | undefined) => {
    if (candidate && selected.length < config.target && !selected.some((item) => candidateIdentity(item) === candidateIdentity(candidate))) selected.push(candidate);
  };
  const support = withinCap.find((candidate) => candidate.role === "support");
  const challenge = withinCap.find((candidate) => candidate.role === "challenge");
  add(support);
  add(challenge);
  for (const candidate of withinCap) add(candidate);

  const selectedKeys = new Set(selected.map(candidateIdentity));
  for (const candidate of withinCap) {
    if (!selectedKeys.has(candidateIdentity(candidate))) rejections.push({ candidate, reason: "not-selected" });
  }
  const supportCount = selected.filter((candidate) => candidate.role === "support").length;
  const challengeCount = selected.filter((candidate) => candidate.role === "challenge").length;
  return {
    selected,
    rejected: rejections,
    supportCount,
    challengeCount,
    eligibleCount: withinCap.length,
    target: config.target,
    minimum: config.minimum,
    mixedRoles: supportCount > 0 && challengeCount > 0,
  };
}

export const selectPacket = selectEvidencePacket;
