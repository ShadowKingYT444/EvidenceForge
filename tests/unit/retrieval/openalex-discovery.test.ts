import { describe, expect, it, vi } from "vitest";

import {
  OpenAlexSelectionError,
  createOpenAlexDiscoveryClient,
  createOpenAlexSelectionAudit,
  normalizeOpenAlexQuery,
} from "../../../src/server/retrieval/openalex";
import {
  OPENALEX_WORK_1,
  OPENALEX_WORK_2,
  OPENALEX_WORK_3,
  openAlexPage,
} from "../../fixtures/retrieval/openalex-service";

const API_KEY = "oa-secret-value";
const ORIGINAL_QUERY = "  battery\tbiodegradation\n evidence  ";
const NORMALIZED_QUERY = "battery biodegradation evidence";
const CHECKED_AT = "2026-08-06T23:55:00.000Z";

function response(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

function client(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<
    Parameters<typeof createOpenAlexDiscoveryClient>[0]
  > = {},
) {
  return createOpenAlexDiscoveryClient({
    apiKey: API_KEY,
    evidenceMode: "fixture",
    fetch,
    now: () => new Date(CHECKED_AT),
    sleep: vi.fn(async () => undefined),
    limits: {
      maxResults: 3,
      pageSize: 2,
      maxPages: 2,
      deadlineMs: 5_000,
    },
    retry: {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      timeoutMs: 1_000,
    },
    ...overrides,
  });
}

describe("OpenAlex query boundary", () => {
  it("preserves the original query and produces one bounded normalized query", () => {
    expect(normalizeOpenAlexQuery(ORIGINAL_QUERY)).toEqual({
      status: "valid",
      originalQuery: ORIGINAL_QUERY,
      normalizedQuery: NORMALIZED_QUERY,
    });
  });

  it("removes wildcard punctuation from ordinary research questions", () => {
    expect(normalizeOpenAlexQuery("Does RAG reduce hallucination? *")).toMatchObject({
      status: "valid",
      originalQuery: "Does RAG reduce hallucination? *",
      normalizedQuery: "Does RAG reduce hallucination",
    });
  });

  it.each(["", " \t\n ", "ok\u0000secret", "x".repeat(501)])(
    "rejects an empty, control-bearing, or oversized query without fetching: %j",
    async (query) => {
      const fetch = vi.fn();
      const result = await client(fetch).discover(query);

      expect(result.status).toBe("invalid_request");
      expect(result.candidates).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("bounded OpenAlex discovery", () => {
  it("uses deterministic cursor pagination and stops exactly at maxResults", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, openAlexPage([OPENALEX_WORK_1, OPENALEX_WORK_2], "next")),
      )
      .mockResolvedValueOnce(
        response(200, openAlexPage([OPENALEX_WORK_3], null, { count: 3 })),
      );

    const result = await client(fetch).discover(ORIGINAL_QUERY);

    expect(result).toMatchObject({
      status: "completed",
      evidenceMode: "fixture",
      provider: "openalex",
      originalQuery: ORIGINAL_QUERY,
      normalizedQuery: NORMALIZED_QUERY,
      startedAt: CHECKED_AT,
      completedAt: CHECKED_AT,
      pagination: {
        maxResults: 3,
        pageSize: 2,
        maxPages: 2,
        pagesFetched: 2,
        providerResultCount: 3,
        nextCursorAvailable: false,
        truncated: false,
      },
    });
    expect(result.candidates.map((candidate) => candidate.openAlexId)).toEqual([
      "W1111111111",
      "W2222222222",
      "W3333333333",
    ]);
    expect(result.snapshotId).toMatch(/^oa-snapshot-[a-f0-9]{64}$/);
    expect(fetch).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(fetch.mock.calls[0]![0]);
    const secondUrl = new URL(fetch.mock.calls[1]![0]);
    expect(firstUrl.origin + firstUrl.pathname).toBe(
      "https://api.openalex.org/works",
    );
    expect(firstUrl.searchParams.get("api_key")).toBe(API_KEY);
    expect(firstUrl.searchParams.get("search")).toBe(NORMALIZED_QUERY);
    expect(firstUrl.searchParams.get("cursor")).toBe("*");
    expect(firstUrl.searchParams.get("per_page")).toBe("2");
    expect(firstUrl.searchParams.get("sort")).toBeNull();
    expect(secondUrl.searchParams.get("cursor")).toBe("next");
  });

  it("projects only auditable candidate signals without converting them to rights or authority", async () => {
    const fetch = vi.fn(async () =>
      response(
        200,
        openAlexPage([OPENALEX_WORK_1, OPENALEX_WORK_2], null, {
          count: 2,
          costUsd: 0.002,
        }),
        {
          "x-ratelimit-limit": "1.00",
          "x-ratelimit-remaining": "0.75",
          "x-ratelimit-credits-used": "0.25",
          "x-ratelimit-reset": "3600",
        },
      ),
    );

    const result = await client(fetch).discover("oa signals");

    expect(result.status).toBe("completed");
    expect(result.candidates[0]).toEqual({
      openAlexId: "W1111111111",
      openAlexUrl: "https://openalex.org/W1111111111",
      title: "A bounded evidence discovery example",
      authors: [
        {
          openAlexId: "A1111111111",
          displayName: "Ada Example",
        },
      ],
      publicationYear: 2024,
      providerDoi: "https://doi.org/10.1000/example-one",
      canonicalDoi: "10.1000/example-one",
      source: {
        openAlexId: "S1111111111",
        displayName: "Journal of Bounded Examples",
      },
      abstractSignal: {
        providerReportedAvailable: true,
        contentFetched: false,
      },
      openAccessSignal: {
        isOpenAccess: false,
        status: "closed",
        repositoryFullTextReported: false,
        primaryLocation: {
          landingPageUrl: "https://publisher.example/work-one",
          licenseSignal: null,
          version: "publishedVersion",
        },
        bestLocation: null,
        rightsAssessment: "not_assessed",
      },
      citations: {
        count: 12,
        providerApiUrl:
          "https://api.openalex.org/works?filter=cites%3AW1111111111",
      },
    });
    expect(result.candidates[1]?.openAccessSignal).toEqual({
      isOpenAccess: true,
      status: "green",
      repositoryFullTextReported: true,
      primaryLocation: {
        landingPageUrl: "https://repository.example/work-two",
        licenseSignal: "cc-by",
        version: "acceptedVersion",
      },
      bestLocation: {
        landingPageUrl: "https://repository.example/work-two",
        licenseSignal: "cc-by",
        version: "acceptedVersion",
      },
      rightsAssessment: "not_assessed",
    });
    expect(result.doesNotEstablish).toEqual([
      "authority",
      "completeness",
      "entailment",
      "content_availability",
      "content_rights",
    ]);
    expect(result.providerUsage).toEqual({
      reportedCostUsd: 0.002,
      rateLimit: {
        limit: 1,
        remaining: 0.75,
        creditsUsed: 0.25,
        resetSeconds: 3600,
      },
    });
    expect(JSON.stringify(result.candidates)).not.toContain(
      "abstract_inverted_index",
    );
  });

  it("preserves a completed empty candidate snapshot without inventing a not-found claim", async () => {
    const result = await client(
      vi.fn(async () => response(200, openAlexPage([], null, { count: 0 }))),
    ).discover("no matching candidates");

    expect(result).toMatchObject({
      status: "completed",
      failureCode: null,
      candidates: [],
      pagination: {
        providerResultCount: 0,
        pagesFetched: 1,
      },
    });
    expect(result.snapshotId).toMatch(/^oa-snapshot-[a-f0-9]{64}$/);
    expect(createOpenAlexSelectionAudit(result, [])).toMatchObject({
      candidateOpenAlexIds: [],
      selectedOpenAlexIds: [],
      rejectedOpenAlexIds: [],
    });
  });

  it("keeps fixture and live evidence labels explicit", async () => {
    const result = await client(
      vi.fn(async () =>
        response(200, openAlexPage([OPENALEX_WORK_1], null)),
      ),
      { evidenceMode: "live" },
    ).discover("separately labeled");

    expect(result.evidenceMode).toBe("live");
  });

  it("marks a bounded snapshot truncated instead of implying complete coverage", async () => {
    const fetch = vi.fn(async () =>
      response(
        200,
        openAlexPage([OPENALEX_WORK_1, OPENALEX_WORK_2], "more", {
          count: 500,
        }),
      ),
    );

    const result = await client(fetch, {
      limits: {
        maxResults: 2,
        pageSize: 2,
        maxPages: 1,
        deadlineMs: 5_000,
      },
    }).discover("bounded");

    expect(result.status).toBe("completed");
    expect(result.pagination).toMatchObject({
      pagesFetched: 1,
      providerResultCount: 500,
      nextCursorAvailable: true,
      truncated: true,
      truncatedReason: "max_results",
    });
    expect(result.doesNotEstablish).toContain("completeness");
  });

  it("fails closed on an invalid stable OpenAlex work ID", async () => {
    const fetch = vi.fn(async () =>
      response(
        200,
        openAlexPage([
          {
            ...OPENALEX_WORK_1,
            id: "https://attacker.example/W1111111111",
          },
        ], null),
      ),
    );

    const result = await client(fetch).discover("invalid id");

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "invalid_response",
      candidates: [],
    });
  });

  it("fails closed when a cursor repeats instead of looping", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, openAlexPage([OPENALEX_WORK_1], "repeated")),
      )
      .mockResolvedValueOnce(
        response(200, openAlexPage([OPENALEX_WORK_2], "repeated")),
      );

    const result = await client(fetch).discover("cursor loop");

    expect(result).toMatchObject({
      status: "partial",
      failureCode: "cursor_loop",
      pagination: {
        pagesFetched: 2,
      },
    });
    expect(result.candidates).toHaveLength(2);
  });
});

describe("retry, deadline, usage, and logging boundaries", () => {
  it("honors bounded Retry-After, preserves attempts, and never logs key, query, URLs, or headers", async () => {
    const events: unknown[] = [];
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(429, { message: `${ORIGINAL_QUERY}?api_key=${API_KEY}` }, {
          "retry-after": "99",
          "x-private-header": "do-not-log",
        }),
      )
      .mockResolvedValueOnce(
        response(200, openAlexPage([OPENALEX_WORK_1], null)),
      );

    const result = await client(fetch, {
      sleep,
      log: (event) => events.push(event),
    }).discover(ORIGINAL_QUERY);

    expect(result.status).toBe("completed");
    expect(result.pageHistory[0]?.attemptHistory).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "rate_limited",
        httpStatus: 429,
        retryDelayMs: 100,
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: "success",
        httpStatus: 200,
        retryDelayMs: null,
      }),
    ]);
    expect(sleep).toHaveBeenCalledWith(100);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(API_KEY);
    expect(serializedEvents).not.toContain(NORMALIZED_QUERY);
    expect(serializedEvents).not.toContain("api.openalex.org");
    expect(serializedEvents).not.toContain("do-not-log");
    expect(serializedEvents).not.toContain("retry-after");
  });

  it("preserves exhausted rate limiting instead of reporting no candidates", async () => {
    const result = await client(
      vi.fn(async () => response(429, { message: "rate limited" })),
      {
        retry: {
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 100,
          timeoutMs: 1_000,
        },
      },
    ).discover("rate limited");

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "rate_limited",
      candidates: [],
    });
  });

  it("does not spend another request after the provider reports no remaining allowance", async () => {
    const fetch = vi.fn(async () =>
      response(
        200,
        openAlexPage([OPENALEX_WORK_1], "next", { count: 10 }),
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "3600",
        },
      ),
    );

    const result = await client(fetch).discover("allowance exhausted");

    expect(result).toMatchObject({
      status: "partial",
      failureCode: "rate_limited",
      candidates: [{ openAlexId: "W1111111111" }],
      providerUsage: {
        rateLimit: {
          remaining: 0,
          resetSeconds: 3600,
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enforces a total deadline across pages", async () => {
    let tick = 0;
    const now = () => new Date(Date.parse(CHECKED_AT) + tick++ * 600);
    const fetch = vi.fn(async () =>
      response(200, openAlexPage([OPENALEX_WORK_1], "next")),
    );

    const result = await client(fetch, {
      now,
      limits: {
        maxResults: 3,
        pageSize: 1,
        maxPages: 3,
        deadlineMs: 1_000,
      },
    }).discover("deadline");

    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("deadline_exceeded");
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("enforces the total deadline while a successful response body is consumed", async () => {
    let elapsedMs = 0;
    const slowResponse = new Response(null, { status: 200 });
    Object.defineProperty(slowResponse, "text", {
      value: vi.fn(async () => {
        elapsedMs = 1_100;
        return JSON.stringify(
          openAlexPage([OPENALEX_WORK_1], null, { count: 1 }),
        );
      }),
    });
    const fetch = vi.fn(async () => slowResponse);
    const now = () =>
      new Date(Date.parse(CHECKED_AT) + elapsedMs);

    const result = await client(fetch, {
      now,
      limits: {
        maxResults: 1,
        pageSize: 1,
        maxPages: 1,
        deadlineMs: 1_000,
      },
      retry: {
        maxAttempts: 1,
        baseDelayMs: 10,
        maxDelayMs: 100,
        timeoutMs: 1_000,
      },
    }).discover("slow successful body");

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "deadline_exceeded",
      candidates: [],
      pagination: {
        pagesFetched: 0,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { elapsedMs: 999, expectedStatus: "completed" },
    { elapsedMs: 1_000, expectedStatus: "failed" },
  ] as const)(
    "treats body completion at $elapsedMs ms against a 1,000 ms deadline exactly",
    async ({ elapsedMs: completedAtMs, expectedStatus }) => {
      let elapsedMs = 0;
      const timedResponse = new Response(null, { status: 200 });
      Object.defineProperty(timedResponse, "text", {
        value: vi.fn(async () => {
          elapsedMs = completedAtMs;
          return JSON.stringify(
            openAlexPage([OPENALEX_WORK_1], null, { count: 1 }),
          );
        }),
      });

      const result = await client(vi.fn(async () => timedResponse), {
        now: () => new Date(Date.parse(CHECKED_AT) + elapsedMs),
        limits: {
          maxResults: 1,
          pageSize: 1,
          maxPages: 1,
          deadlineMs: 1_000,
        },
        retry: {
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 100,
          timeoutMs: 1_000,
        },
      }).discover("exact deadline");

      expect(result.status).toBe(expectedStatus);
      expect(result.failureCode).toBe(
        expectedStatus === "failed" ? "deadline_exceeded" : null,
      );
      expect(result.candidates).toHaveLength(
        expectedStatus === "failed" ? 0 : 1,
      );
    },
  );

  it("keeps the abort timer active through a hanging body and cleans it up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown) => unhandled(reason);
    process.on("unhandledRejection", onUnhandled);
    let requestAborted = false;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          requestAborted = true;
        },
        { once: true },
      );
      return new Response(body, { status: 200 });
    });

    try {
      const resultPromise = client(fetch, {
        now: () => new Date(Date.now()),
        limits: {
          maxResults: 1,
          pageSize: 1,
          maxPages: 1,
          deadlineMs: 1_000,
        },
        retry: {
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 100,
          timeoutMs: 1_000,
        },
      }).discover("hanging body");

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;
      await Promise.resolve();

      expect(result).toMatchObject({
        status: "failed",
        failureCode: "deadline_exceeded",
        candidates: [],
      });
      expect(requestAborted).toBe(true);
      expect(bodyCancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("rejects an oversized streamed body before parsing it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_100_000));
        controller.enqueue(new Uint8Array(1_100_000));
        controller.close();
      },
    });
    const result = await client(
      vi.fn(async () => new Response(body, { status: 200 })),
      {
        retry: {
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 100,
          timeoutMs: 1_000,
        },
      },
    ).discover("oversized stream");

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "invalid_response",
      candidates: [],
    });
  });

  it("does not retry when backoff would land exactly on the total deadline", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => response(429));
    const result = await client(fetch, {
      sleep,
      limits: {
        maxResults: 1,
        pageSize: 1,
        maxPages: 1,
        deadlineMs: 1_000,
      },
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        timeoutMs: 1_000,
      },
    }).discover("bounded backoff");

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "rate_limited",
      candidates: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns provider_unavailable without preserving a secret-bearing exception", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(
        `request failed for ${ORIGINAL_QUERY}?api_key=${API_KEY}`,
      );
    });

    const result = await client(fetch, {
      retry: {
        maxAttempts: 1,
        baseDelayMs: 10,
        maxDelayMs: 100,
        timeoutMs: 1_000,
      },
    }).discover(ORIGINAL_QUERY);

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "provider_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});

describe("explicit human selection audit", () => {
  async function discoverySnapshot() {
    return client(
      vi.fn(async () =>
        response(
          200,
          openAlexPage([OPENALEX_WORK_1, OPENALEX_WORK_2], null),
        ),
      ),
    ).discover("selection");
  }

  it("requires explicit selected/rejected decisions and is idempotent", async () => {
    const discovery = await discoverySnapshot();
    const decisions = [
      {
        openAlexId: "W1111111111",
        decision: "selected" as const,
        decidedAt: CHECKED_AT,
        reason: "Relevant to the approved scope",
      },
      {
        openAlexId: "W2222222222",
        decision: "rejected" as const,
        decidedAt: CHECKED_AT,
        reason: "Out of scope",
      },
    ];

    const first = createOpenAlexSelectionAudit(discovery, decisions);
    const second = createOpenAlexSelectionAudit(discovery, [...decisions]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      selectionAuthority: "human",
      discoverySnapshotId: discovery.snapshotId,
      originalQuery: "selection",
      selectedOpenAlexIds: ["W1111111111"],
      rejectedOpenAlexIds: ["W2222222222"],
    });
    expect(first.auditId).toMatch(/^oa-selection-[a-f0-9]{64}$/);
    expect(discovery.candidates.map((candidate) => candidate.openAlexId)).toEqual([
      "W1111111111",
      "W2222222222",
    ]);
  });

  it("rejects a mutated candidate list whose preserved snapshot hash no longer matches", async () => {
    const discovery = await discoverySnapshot();
    discovery.candidates.pop();

    expect(() =>
      createOpenAlexSelectionAudit(discovery, [
        {
          openAlexId: "W1111111111",
          decision: "selected",
          decidedAt: CHECKED_AT,
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<OpenAlexSelectionError>>({
        code: "snapshot_mismatch",
      }),
    );
  });

  it.each([
    {
      name: "duplicate",
      decisions: [
        {
          openAlexId: "W1111111111",
          decision: "selected" as const,
          decidedAt: CHECKED_AT,
        },
        {
          openAlexId: "W1111111111",
          decision: "rejected" as const,
          decidedAt: CHECKED_AT,
        },
      ],
      code: "duplicate_candidate",
    },
    {
      name: "unknown",
      decisions: [
        {
          openAlexId: "W1111111111",
          decision: "selected" as const,
          decidedAt: CHECKED_AT,
        },
        {
          openAlexId: "W9999999999",
          decision: "rejected" as const,
          decidedAt: CHECKED_AT,
        },
      ],
      code: "unknown_candidate",
    },
    {
      name: "missing",
      decisions: [
        {
          openAlexId: "W1111111111",
          decision: "selected" as const,
          decidedAt: CHECKED_AT,
        },
      ],
      code: "missing_decision",
    },
  ])("rejects $name selection records", async ({ decisions, code }) => {
    const discovery = await discoverySnapshot();

    expect(() =>
      createOpenAlexSelectionAudit(discovery, decisions),
    ).toThrowError(
      expect.objectContaining<Partial<OpenAlexSelectionError>>({
        code: code as OpenAlexSelectionError["code"],
      }),
    );
  });
});
