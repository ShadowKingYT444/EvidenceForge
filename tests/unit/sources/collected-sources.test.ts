import { describe, expect, it } from "vitest";
import { ResearchRunSchema } from "../../../src/contracts";
import { goldenRunV01 } from "../../../src/fixtures/golden-run-v0.1";
import { MissingCheckpointError, InvalidExecutionAttemptError, InvalidTransitionError, persistCollectedSources } from "../../../src/server/workflow";
import { InMemoryWorkflowRunStore } from "../../../src/server/workflow/store";

function collectingRun() {
  return ResearchRunSchema.parse({ ...structuredClone(goldenRunV01), id: "collecting-test", status: "collecting_sources", scopeDecision: null, packet: null, sources: [], chunks: [], evidenceCards: [], conclusions: [], researchGaps: [], selectedGapId: null, experiment: null, review: null, objectionDispositionDecision: null, revision: null, finalDecision: null, executions: [], errors: [] });
}

describe("persistCollectedSources manual boundary", () => {
  it("moves collecting_sources to awaiting_packet_approval with a valid two-source packet", () => {
    const sources = structuredClone(goldenRunV01.sources.slice(0, 2));
    const chunks = structuredClone(goldenRunV01.chunks.filter((chunk) => sources.some((source) => source.id === chunk.sourceId)).slice(0, 2));
    const result = persistCollectedSources(collectingRun(), sources, chunks, "2026-08-18T20:00:00.000Z");
    expect(result.status).toBe("awaiting_packet_approval");
    expect(result.sources).toHaveLength(2);
    expect(result.chunks).toHaveLength(2);
  });

  it("persists the source/chunk delta on the declared lifecycle edge", () => {
    const run = collectingRun();
    const sources = structuredClone(goldenRunV01.sources.slice(0, 2));
    const chunks = structuredClone(goldenRunV01.chunks.filter((chunk) => sources.some((source) => source.id === chunk.sourceId)).slice(0, 2));
    const store = new InMemoryWorkflowRunStore();
    store.hydrate({ run, revision: "collecting-revision", objectionDispositions: null });
    const saved = store.save(
      persistCollectedSources(run, sources, chunks, "2026-08-18T20:00:00.000Z"),
      "collecting-revision",
    );
    expect(saved.run).toMatchObject({ status: "awaiting_packet_approval" });
    expect(saved.run.sources).toHaveLength(2);
  });

  it("requires at least two sources and chunks, and rejects unknown chunk references", () => {
    const run = collectingRun();
    expect(() => persistCollectedSources(run, [structuredClone(goldenRunV01.sources[0]!)], structuredClone(goldenRunV01.chunks.slice(0, 2)), "2026-08-18T20:00:00.000Z")).toThrow();
    expect(() => persistCollectedSources(run, structuredClone(goldenRunV01.sources.slice(0, 2)), [structuredClone(goldenRunV01.chunks[0]!)], "2026-08-18T20:00:00.000Z")).toThrow();
    const badChunk = { ...structuredClone(goldenRunV01.chunks[0]!), sourceId: "missing-source" };
    expect(() => persistCollectedSources(run, structuredClone(goldenRunV01.sources.slice(0, 2)), [structuredClone(goldenRunV01.chunks[0]!), badChunk], "2026-08-18T20:00:00.000Z")).toThrow(InvalidExecutionAttemptError);
  });

  it("rejects illegal phase entry and replacement after packet freeze", () => {
    const sources = structuredClone(goldenRunV01.sources.slice(0, 2));
    const chunks = structuredClone(goldenRunV01.chunks.slice(0, 2));
    expect(() => persistCollectedSources({ ...collectingRun(), status: "awaiting_packet_approval" }, sources, chunks, "2026-08-18T20:00:00.000Z")).toThrow(InvalidTransitionError);
    const frozen = ResearchRunSchema.parse({ ...collectingRun(), packet: structuredClone(goldenRunV01.packet), sources, chunks });
    expect(() => persistCollectedSources(frozen, sources, chunks, "2026-08-18T20:00:00.000Z")).toThrow(MissingCheckpointError);
    expect(frozen.packet).toEqual(goldenRunV01.packet);
  });

  it("does not mutate caller-owned source or chunk arrays", () => {
    const run = collectingRun();
    const sources = structuredClone(goldenRunV01.sources.slice(0, 2));
    const chunks = structuredClone(goldenRunV01.chunks.slice(0, 2));
    const sourceSnapshot = structuredClone(sources); const chunkSnapshot = structuredClone(chunks);
    persistCollectedSources(run, sources, chunks, "2026-08-18T20:00:00.000Z");
    expect(sources).toEqual(sourceSnapshot);
    expect(chunks).toEqual(chunkSnapshot);
  });
});
