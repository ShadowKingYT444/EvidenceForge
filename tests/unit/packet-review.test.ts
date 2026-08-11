import { describe, expect, it } from "vitest";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  buildPacketReviewModel,
  PACKET_REVIEW_SCENARIOS,
} from "../../src/features/workbench/packet-review-state";

describe("packet review model", () => {
  it("maps the frozen packet receipt and source provenance without inventing values", () => {
    const model = buildPacketReviewModel(goldenRunV01);

    expect(model.state).toBe("frozen");
    expect(model.evidenceMode).toBe("fixture");
    expect(model.packet).toEqual({
      version: goldenRunV01.packet?.packetVersion,
      fingerprint: goldenRunV01.packet?.fingerprint,
      frozenAt: goldenRunV01.packet?.frozenAt,
      sourceHashCount: goldenRunV01.packet?.sourceHashes.length,
      chunkHashCount: goldenRunV01.packet?.chunkHashes.length,
    });
    expect(model.sources).toHaveLength(goldenRunV01.sources.length);
    expect(model.sources[0]).toMatchObject({
      id: "gf-source-01",
      origin: "curated_fixture",
      contentScope: "full_text",
      canonicalDoi: "10.1038/s41598-022-15900-5",
      registrationAgency: "Crossref",
      rights: {
        mayStore: "allowed",
        mayDisplay: "allowed",
        maySendToModel: "allowed",
      },
      display: { state: "available" },
      modelAccess: { state: "included" },
    });
    expect(model.blockers).toEqual([]);
  });

  it.each(["denied", "unknown"] as const)(
    "removes source text from the UI projection when display permission is %s",
    (permission) => {
      const run = structuredClone(goldenRunV01);
      const source = run.sources[0]!;
      const chunk = run.chunks.find(({ sourceId }) => sourceId === source.id)!;
      const hiddenText = chunk.text;
      source.rights.mayDisplay = permission;
      chunk.displayPermission = permission;

      const model = buildPacketReviewModel(run);
      const first = model.sources[0]!;

      expect(model.boundaryError).toBeNull();
      expect(first.display).toEqual({
        state: "hidden",
        reason:
          permission === "denied"
            ? "Display permission is denied; source text is not rendered."
            : "Display permission is unknown; source text is not rendered.",
      });
      expect(JSON.stringify(first)).not.toContain(hiddenText);
    },
  );

  it("keeps model-denied text out of the model-access projection independently of display rights", () => {
    const run = structuredClone(goldenRunV01);
    const source = run.sources[0]!;
    source.rights.mayDisplay = "allowed";
    source.rights.maySendToModel = "denied";

    const first = buildPacketReviewModel(run).sources[0]!;

    expect(first.display.state).toBe("available");
    expect(first.modelAccess).toEqual({
      state: "excluded",
      reason: "Model-use permission is denied; no source text enters the model projection.",
    });
    expect(first.modelAccess).not.toHaveProperty("text");
  });

  it("strips canonical URL credentials, query values, and fragments from the UI projection", () => {
    const run = structuredClone(goldenRunV01);
    const source = run.sources[0]!;
    source.canonicalDoi = null;
    source.canonicalUrl =
      "https://reader:private@example.test/article?token=secret#internal";

    const first = buildPacketReviewModel(run).sources[0]!;

    expect(first.canonicalUrl).toBe("https://example.test/article");
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("token=secret");
    expect(JSON.stringify(first)).not.toContain("#internal");
  });

  it("blocks acceptance when storage permission is unresolved", () => {
    const run = structuredClone(goldenRunV01);
    run.sources[0]!.rights.mayStore = "unknown";

    const model = buildPacketReviewModel(run, "review");

    expect(model.canAccept).toBe(false);
    expect(model.blockers).toContainEqual({
      code: "storage_rights_unresolved",
      severity: "blocking",
      message: "gf-source-01: storage permission is unknown.",
    });
  });

  it("exposes every bounded UI state and preserves typed post-freeze mutation evidence", () => {
    expect(PACKET_REVIEW_SCENARIOS).toEqual([
      "frozen",
      "review",
      "loading",
      "empty",
      "denied",
      "error",
      "rejected",
      "duplicate",
      "long-content",
      "missing-packet",
      "tampered-packet",
      "stale-session",
    ]);

    expect(buildPacketReviewModel(goldenRunV01, "loading")).toMatchObject({
      state: "loading",
      sources: [],
    });
    expect(buildPacketReviewModel(goldenRunV01, "empty")).toMatchObject({
      state: "empty",
      sources: [],
      blockers: [
        expect.objectContaining({ code: "empty_packet", severity: "blocking" }),
      ],
    });
    expect(buildPacketReviewModel(goldenRunV01, "error")).toMatchObject({
      state: "error",
      mutationError: {
        name: "PacketMutationError",
        code: "packet_frozen",
        operation: "update_source",
      },
    });
    expect(buildPacketReviewModel(goldenRunV01, "rejected")).toMatchObject({
      state: "rejected",
      packet: null,
    });
    expect(
      buildPacketReviewModel(goldenRunV01, "duplicate").sources[0]
        ?.mergedSourceIds,
    ).toContain("fixture-duplicate-alias");
  });
});
