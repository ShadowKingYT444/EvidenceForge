import { parseResearchConfig, type ResearchConfig } from "./config";
import type {
  ResearchFallback,
  ResearchProgressEvent,
  ResearchRunResult,
  ResearchWorkItem,
  ResearchWorker,
  ResearchWorkerContext,
  WorkerAuditResult,
} from "./types";

export class ResearchTimeoutError extends Error {
  readonly code = "RESEARCH_TIMEOUT";
  constructor(message = "Research item timed out") {
    super(message);
    this.name = "ResearchTimeoutError";
  }
}

export interface ResearchPoolOptions<T, TQuery = string> {
  config?: Partial<ResearchConfig>;
  worker: ResearchWorker<T, TQuery>;
  fallback?: ResearchFallback<T, TQuery>;
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (event: ResearchProgressEvent) => void;
}

export interface ResearchPool<T, TQuery = string> {
  run(items: readonly ResearchWorkItem<TQuery>[]): Promise<ResearchRunResult<T>>;
}

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [value.status, value.statusCode, value.response?.status]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

function signalFromError(error: unknown): WorkerAuditResult<unknown>["signal"] {
  const status = statusFromError(error);
  if (status === 429) return "429";
  if (status !== undefined && status >= 500 && status <= 599) return "5xx";
  if (error instanceof ResearchTimeoutError || (error instanceof Error && /timeout|timed out/i.test(error.message))) return "timeout";
  return "error";
}

function abortError(): Error {
  const error = new Error("Research run cancelled");
  error.name = "AbortError";
  return error;
}

export function createResearchWorkerPool<T, TQuery = string>(options: ResearchPoolOptions<T, TQuery>): ResearchPool<T, TQuery> {
  const config = parseResearchConfig(options.config ?? {});
  const now = options.now ?? Date.now;

  return {
    run: (items) => runResearchWorkerPool(items, { ...options, config, now }),
  };
}

export async function runResearchWorkerPool<T, TQuery = string>(
  items: readonly ResearchWorkItem<TQuery>[],
  options: ResearchPoolOptions<T, TQuery>,
): Promise<ResearchRunResult<T>> {
  const config = parseResearchConfig(options.config ?? {});
  const now = options.now ?? Date.now;
  const startedAt = now();
  const progress: ResearchProgressEvent[] = [];
  const total = items.length;
  const audits: Array<WorkerAuditResult<T> | undefined> = new Array(total);
  const parentController = new AbortController();
  let explicitlyCancelled = options.signal?.aborted === true;
  let deadlineExceeded = false;
  let finishedCount = 0;
  let active = 0;
  let cursor = 0;
  let concurrency = config.maxConcurrency;
  let resolveRun: (value: ResearchRunResult<T>) => void = () => undefined;
  let settled = false;
  const itemControllers = new Set<AbortController>();

  const emit = (event: ResearchProgressEvent) => {
    progress.push(event);
    options.onProgress?.(event);
  };
  const markDegraded = () => {
    const next = concurrency > 3 ? Math.min(3, config.maxConcurrency) : concurrency > 1 ? 1 : 1;
    if (next === concurrency) return;
    concurrency = next;
    emit({ kind: "degraded", completed: finishedCount, total, concurrency, timestamp: now(), detail: `concurrency reduced to ${concurrency}` });
  };
  const cancelItems = () => {
    for (const controller of itemControllers) controller.abort();
  };
  const onAbort = () => {
    explicitlyCancelled = true;
    parentController.abort();
    cancelItems();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  for (const item of items) emit({ kind: "queued", itemId: item.id, completed: 0, total, concurrency, timestamp: startedAt });

  const complete = () => {
    if (settled || finishedCount !== total) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    const finishedAt = now();
    emit({ kind: "finished", completed: total, total, concurrency, timestamp: finishedAt });
    resolveRun({
      results: audits as Array<WorkerAuditResult<T>>,
      progress: [...progress],
      startedAt,
      finishedAt,
      cancelled: explicitlyCancelled,
      deadlineExceeded,
      finalConcurrency: concurrency,
    });
  };

  const finishWithoutStart = (index: number, status: "cancelled" | "timed-out") => {
    const item = items[index];
    const finishedAt = now();
    audits[index] = { itemId: item.id, index, status, finishedAt, concurrencyAtStart: concurrency, fallbackUsed: false, signal: status === "cancelled" ? "cancelled" : "timeout" };
    finishedCount += 1;
    emit({ kind: status === "cancelled" ? "cancelled" : "failed", itemId: item.id, completed: finishedCount, total, concurrency, timestamp: finishedAt });
  };

  const execute = async (index: number): Promise<void> => {
    const item = items[index];
    if (explicitlyCancelled || parentController.signal.aborted) {
      finishWithoutStart(index, "cancelled");
      return;
    }
    const itemController = new AbortController();
    itemControllers.add(itemController);
    const concurrencyAtStart = concurrency;
    const itemStarted = now();
    const context: ResearchWorkerContext<TQuery> = { signal: itemController.signal, item, index, concurrency: concurrencyAtStart, deadlineAt: startedAt + config.deadlineMs };
    emit({ kind: "started", itemId: item.id, completed: finishedCount, total, concurrency, timestamp: itemStarted });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const work = Promise.resolve().then(() => options.worker(item, context));
      const timeout = new Promise<never>((_, reject) => {
        const timeoutMs = Math.max(1, Math.min(config.perItemTimeoutMs, context.deadlineAt - now()));
        timeoutId = setTimeout(() => {
          timedOut = true;
          if (timeoutMs < config.perItemTimeoutMs) deadlineExceeded = true;
          itemController.abort();
          reject(new ResearchTimeoutError(timeoutMs < config.perItemTimeoutMs ? "Research deadline exceeded" : undefined));
        }, timeoutMs);
      });
      const abort = new Promise<never>((_, reject) => {
        itemController.signal.addEventListener("abort", () => {
          if (timedOut || deadlineExceeded) reject(new ResearchTimeoutError("Research deadline exceeded"));
          else reject(abortError());
        }, { once: true });
      });
      const value = await Promise.race([work, timeout, abort]);
      const finishedAt = now();
      const wasCancelled = explicitlyCancelled || options.signal?.aborted === true;
      const wasDeadline = deadlineExceeded;
      const status = wasCancelled ? "cancelled" : wasDeadline ? "timed-out" : "completed";
      audits[index] = { itemId: item.id, index, status, value: status === "completed" ? value : undefined, startedAt: itemStarted, finishedAt, durationMs: finishedAt - itemStarted, concurrencyAtStart, fallbackUsed: false, signal: status === "completed" ? undefined : status === "cancelled" ? "cancelled" : "timeout" };
      emit({ kind: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", itemId: item.id, completed: finishedCount + 1, total, concurrency, timestamp: finishedAt });
    } catch (error) {
      const signal = timedOut || deadlineExceeded ? "timeout" : explicitlyCancelled ? "cancelled" : signalFromError(error);
      if (signal === "429" || signal === "5xx" || signal === "timeout") {
        markDegraded();
        emit({ kind: "degraded", itemId: item.id, completed: finishedCount, total, concurrency, timestamp: now(), detail: signal });
      }
      let value: T | undefined;
      let fallbackUsed = false;
      if (options.fallback && (signal === "429" || signal === "5xx" || signal === "timeout") && !explicitlyCancelled) {
        fallbackUsed = true;
        emit({ kind: "fallback", itemId: item.id, completed: finishedCount, total, concurrency, timestamp: now(), detail: "audited fallback invoked" });
        let fallbackTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const fallbackTimeout = new Promise<never>((_, reject) => {
            const remaining = Math.max(1, context.deadlineAt - now());
            fallbackTimeoutId = setTimeout(() => reject(new ResearchTimeoutError("Research fallback deadline exceeded")), remaining);
          });
          const fallbackAbort = parentController.signal.aborted
            ? Promise.reject<never>(deadlineExceeded ? new ResearchTimeoutError("Research deadline exceeded") : abortError())
            : new Promise<never>((_, reject) => parentController.signal.addEventListener("abort", () => reject(deadlineExceeded ? new ResearchTimeoutError("Research deadline exceeded") : abortError()), { once: true }));
          value = await Promise.race([Promise.resolve().then(() => options.fallback!(item, error, context)), fallbackTimeout, fallbackAbort]);
        } catch (fallbackError) {
          error = fallbackError;
          fallbackUsed = true;
        } finally {
          if (fallbackTimeoutId !== undefined) clearTimeout(fallbackTimeoutId);
        }
      }
      const finishedAt = now();
      const finalSignal = explicitlyCancelled ? "cancelled" : deadlineExceeded ? "timeout" : signal;
      const status = fallbackUsed && value !== undefined && finalSignal !== "cancelled" ? "fallback" : finalSignal === "timeout" ? "timed-out" : finalSignal === "cancelled" ? "cancelled" : "failed";
      audits[index] = { itemId: item.id, index, status, value: status === "fallback" ? value : undefined, error: status === "fallback" || status === "cancelled" ? undefined : error, startedAt: itemStarted, finishedAt, durationMs: finishedAt - itemStarted, concurrencyAtStart, fallbackUsed, signal: finalSignal };
      emit({ kind: status === "cancelled" ? "cancelled" : status === "fallback" ? "fallback" : "failed", itemId: item.id, completed: finishedCount + 1, total, concurrency, timestamp: finishedAt });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      itemControllers.delete(itemController);
      finishedCount += 1;
    }
  };

  const pump = () => {
    while (cursor < total && active < concurrency && !explicitlyCancelled && !deadlineExceeded) {
      const index = cursor++;
      active += 1;
      void execute(index).finally(() => {
        active -= 1;
        if (finishedCount === total) complete();
        else pump();
      });
    }
    if ((explicitlyCancelled || deadlineExceeded) && cursor < total) {
      while (cursor < total) finishWithoutStart(cursor++, explicitlyCancelled ? "cancelled" : "timed-out");
      if (finishedCount === total && active === 0) complete();
    }
  };

  const deadlineId = setTimeout(() => {
    if (settled) return;
    deadlineExceeded = true;
    parentController.abort();
    cancelItems();
    pump();
  }, config.deadlineMs);
  const result = new Promise<ResearchRunResult<T>>((resolve) => {
    resolveRun = resolve;
    if (total === 0) complete();
    else pump();
  });
  const output = await result;
  clearTimeout(deadlineId);
  return output;
}

export const runResearchPool = runResearchWorkerPool;
