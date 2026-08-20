import { describe, expect, it } from "vitest";

import { selectEvidencePacket } from "@/server/research/packet";
import type { EvidenceCandidate } from "@/server/research/types";

const eligible = (candidate: Partial<EvidenceCandidate> & Pick<EvidenceCandidate, "id" | "role">): EvidenceCandidate => ({
  ...candidate,
  rights: { eligible: true, basis: "license" },
  contentScope: { eligible: true, basis: "requested corpus" },
});
describe("research packet selection", () => {
  it("keeps support and challenge roles and rejects implicit eligibility", () => {
    const packet = selectEvidencePacket([
      eligible({ id: "support", role: "support", score: 10 }),
      eligible({ id: "challenge", role: "challenge", score: 1 }),
      { id: "unknown-rights", role: "support", score: 100 },
    ], { target: 2, minimum: 2, candidateCap: 30 });

    expect(packet.selected.map((candidate) => candidate.id)).toEqual(["support", "challenge"]);
    expect(packet.mixedRoles).toBe(true);
    expect(packet.rejected.some((rejection) => rejection.reason === "rights-ineligible")).toBe(true);
  });

  it("dedupes URLs and makes ties repeatable", () => {
    const packet = selectEvidencePacket([
      eligible({ id: "b", url: "https://example.test/paper/", role: "support", score: 1 }),
      eligible({ id: "a", url: "https://example.test/paper", role: "support", score: 1 }),
      eligible({ id: "c", role: "challenge", score: 1 }),
    ], { target: 3, minimum: 1, candidateCap: 30 });
    expect(packet.selected.map((candidate) => candidate.id)).toEqual(["b", "c"]);
  });
});
