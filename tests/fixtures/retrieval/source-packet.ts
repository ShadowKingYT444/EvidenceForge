import type { z } from "zod";

import { HumanDecisionSchema } from "../../../src/contracts";
import type { SourceIngestionInput } from "../../../src/server/provenance/source-packet";

export const PACKET_CHECKED_AT = "2026-08-06T12:00:00.000Z";
export const PACKET_FROZEN_AT = "2026-08-06T12:05:00.000Z";

type FreezeDecisionInput = z.input<typeof HumanDecisionSchema>;

export function fixtureSource(
  overrides: Partial<SourceIngestionInput> = {},
): SourceIngestionInput {
  return {
    id: "fixture-source-1",
    stableId: "fixture:source:1",
    originalInput: "fixture source 1",
    doi: "doi:10.5555/packet.1",
    url: "https://example.test/articles/packet-1",
    title: "Bounded synthetic evidence",
    authors: ["Ada Lovelace", "Grace Hopper"],
    year: 2026,
    venue: "Fixture Journal",
    studyType: "synthetic fixture",
    origin: "curated_fixture",
    contentScope: "user_excerpt",
    provider: "fixture",
    version: "fixture-v1",
    location: "approved fixture excerpt",
    retrievedAt: PACKET_CHECKED_AT,
    content: "Synthetic excerpt for deterministic packet tests.",
    rights: {
      mayStore: "allowed",
      mayDisplay: "allowed",
      maySendToModel: "allowed",
      permissionBasis: "author-created fixture approved for this test",
      checkedAt: PACKET_CHECKED_AT,
    },
    warnings: ["fixture evidence only"],
    ...overrides,
  };
}

export function packetFreezeDecision(
  overrides: Partial<FreezeDecisionInput> = {},
): FreezeDecisionInput {
  return {
    id: "fixture-packet-freeze",
    checkpoint: "packet_freeze",
    optionsShown: ["approve packet", "return to source review"],
    decision: "approve",
    edits: [],
    decidedAt: PACKET_FROZEN_AT,
    unresolvedObjections: [],
    ...overrides,
  };
}
