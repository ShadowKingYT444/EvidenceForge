import { describe, expect, it } from "vitest";

import { runResearchWorkerPool } from "@/server/research/worker-pool";
import type { ResearchWorkItem } from "@/server/research/types";

const items: ResearchWorkItem[] = Array.from({ length: 8 }, (_, index) => ({ id: `q-${index}`, query: `query ${index}` }));

describe("bounded research worker pool", () => {
  it("returns stable input ordering and audits one fallback invocation per failed item", async () => {
    const fallbackIds: string[] = [];
    const result = await runResearchWorkerPool(items.slice(0, 3), {
      config: { target: 3, minimum: 1, candidateCap: 3, perItemTimeoutMs: 10_000, deadlineMs: 10_000, maxConcurrency: 2 },
      worker: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item.id === "q-0" ? 5 : 1));
        if (item.id === "q-1") throw Object.assign(new Error("rate limited"), { status: 429 });
        return item.id;
      },
      fallback: (item) => {
        fallbackIds.push(item.id);
        return `fallback:${item.id}`;
      },
    });

    expect(result.results.map((audit) => audit.itemId)).toEqual(["q-0", "q-1", "q-2"]);
    expect(result.results[1]).toMatchObject({ status: "fallback", fallbackUsed: true, value: "fallback:q-1", signal: "429" });
    expect(fallbackIds).toEqual(["q-1"]);
    expect(result.finalConcurrency).toBe(1);
  });

  it("reduces concurrency on transient signals and cancels queued work", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    controller.abort();
    const resultPromise = runResearchWorkerPool(items, {
      config: { target: 8, minimum: 1, candidateCap: 8, perItemTimeoutMs: 10_000, deadlineMs: 10_000, maxConcurrency: 6 },
      signal: controller.signal,
      worker: async (item) => {
        started.push(item.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return item.id;
      },
    });
    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
    expect(result.results.every((audit) => audit.status === "cancelled")).toBe(true);
    expect(started.length).toBe(0);
  });

  it("stops an in-flight provider that ignores cancellation at the run deadline", async () => {
    const result = await runResearchWorkerPool(items.slice(0, 1), {
      config: { target: 1, minimum: 1, candidateCap: 1, perItemTimeoutMs: 10_000, deadlineMs: 20, maxConcurrency: 1 },
      worker: () => new Promise<string>(() => undefined),
    });
    expect(result.deadlineExceeded).toBe(true);
    expect(result.results[0]).toMatchObject({ status: "timed-out", signal: "timeout" });
  });

  it("does not fall back for non-transient worker failures", async () => {
    let fallbackCalls = 0;
    const result = await runResearchWorkerPool(items.slice(0, 1), {
      config: { target: 1, minimum: 1, candidateCap: 1, sourceDeadlineMs: 10_000, perItemTimeoutMs: 10_000, deadlineMs: 10_000, maxConcurrency: 1 },
      worker: () => { throw new Error("schema validation failed"); },
      fallback: () => { fallbackCalls += 1; return "not-allowed"; },
    });
    expect(result.results[0]).toMatchObject({ status: "failed", fallbackUsed: false, signal: "error" });
    expect(fallbackCalls).toBe(0);
  });
});
