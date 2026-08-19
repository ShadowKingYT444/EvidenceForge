import { describe, expect, it } from "vitest";
import { goldenRunV01 } from "../../../src/fixtures/golden-run-v0.1";
import { addDraftSource, PacketDraftSchema, removeDraftSource } from "../../../src/server/sources/packet-draft";

const importedAt = "2026-08-18T20:00:00.000Z";
const entry = (index = 0) => ({ source: structuredClone(goldenRunV01.sources[index]!), chunks: structuredClone(goldenRunV01.chunks.filter((chunk) => chunk.sourceId === goldenRunV01.sources[index]!.id)), importedAt });

describe("packet draft helpers", () => {
  it("keeps source IDs unique and replaces a repeated source", () => {
    const first = addDraftSource({ sources: [] }, entry(0));
    const replaced = addDraftSource(first, { ...entry(0), importedAt: "2026-08-18T20:01:00.000Z" });
    expect(replaced.sources).toHaveLength(1);
    expect(replaced.sources[0]?.importedAt).toBe("2026-08-18T20:01:00.000Z");
  });

  it("enforces the eight-source ceiling and supports removal", () => {
    let draft: unknown = { sources: [] };
    for (let index = 0; index < 8; index += 1) {
      const source = { ...entry(0), source: { ...entry(0).source, id: `draft-source-${index}` } };
      draft = addDraftSource(draft, source);
    }
    expect(PacketDraftSchema.parse(draft).sources).toHaveLength(8);
    expect(() => addDraftSource(draft, { ...entry(0), source: { ...entry(0).source, id: "ninth-source" } })).toThrow();
    expect(removeDraftSource(draft, "draft-source-3").sources).toHaveLength(7);
  });

  it("rejects malformed entries and duplicate source IDs in a raw draft", () => {
    expect(() => addDraftSource({ sources: [] }, { ...entry(0), importedAt: "not-a-timestamp" })).toThrow();
    expect(() => PacketDraftSchema.parse({ sources: [entry(0), entry(0)] })).toThrow(/unique/i);
  });
});
