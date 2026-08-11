import { describe, expect, it, vi } from "vitest";

import {
  createCrossrefMetadataVerifier,
  type CrossrefLogEvent,
} from "../../../src/server/retrieval/crossref";
import type { RegistrationAgencyResult } from "../../../src/server/retrieval/doi";
import {
  CROSSREF_DOI,
  CROSSREF_WORK,
  crossrefEnvelope,
} from "../../fixtures/retrieval/crossref-service";

const CHECKED_AT = "2026-08-06T12:00:00.000Z";
const CROSSREF_AGENCY: RegistrationAgencyResult = {
  status: "identified",
  agency: "Crossref",
  attempts: 1,
  checkedAt: CHECKED_AT,
  attemptHistory: [],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function workWith(doi: string, title: string) {
  return {
    ...CROSSREF_WORK,
    DOI: doi,
    title: [title],
    "update-to": undefined,
    relation: {},
  };
}

function response(
  status: number,
  body: unknown = null,
  headers: HeadersInit = {},
) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

function hangingCancellationResponse(
  kind: "streamed overflow" | "declared oversize" | "non-2xx",
  onCancel: () => void,
) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (kind === "streamed overflow") {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
      }
    },
    cancel: () => {
      onCancel();
      return new Promise<void>(() => undefined);
    },
  });
  return new Response(body, {
    status: kind === "non-2xx" ? 503 : 200,
    headers:
      kind === "declared oversize"
        ? { "content-length": "1001" }
        : undefined,
  });
}

function verifier(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<
    Parameters<typeof createCrossrefMetadataVerifier>[0]
  > = {},
) {
  return createCrossrefMetadataVerifier({
    evidenceMode: "fixture",
    fetch,
    now: () => new Date(CHECKED_AT),
    retry: {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      timeoutMs: 1_000,
    },
    limits: {
      deadlineMs: 2_000,
      responseBytes: 1_000_000,
    },
    ...overrides,
  });
}

function request(
  overrides: Partial<{
    doi: string;
    registrationAgency: RegistrationAgencyResult;
    supplied: {
      title?: string | null;
      authors?: string[] | null;
      year?: number | null;
    };
  }> = {},
) {
  return {
    doi: overrides.doi ?? `https://doi.org/${CROSSREF_DOI.toUpperCase()}`,
    registrationAgency:
      overrides.registrationAgency ?? CROSSREF_AGENCY,
    supplied: overrides.supplied ?? {
      title: "Evidence-first metadata verification",
      authors: ["Lovelace, Ada", "Grace Hopper"],
      year: 2024,
    },
  };
}

describe("Crossref agency and identifier boundary", () => {
  it("only fetches Crossref-owned DOI metadata and uses the versioned record route", async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      return response(200, crossrefEnvelope(), {
        "x-rate-limit-limit": "10",
        "x-rate-limit-interval": "1s",
        "x-concurrency-limit": "3",
      });
    });

    const result = await verifier(fetch).verify(request());

    expect(result).toMatchObject({
      status: "verified",
      failureCode: null,
      provider: "crossref",
      evidenceMode: "fixture",
      canonicalDoi: CROSSREF_DOI,
      checkedAt: CHECKED_AT,
      source: {
        apiVersion: "v1",
        recordUrl:
          "https://api.crossref.org/v1/works/10.5555%2Fevidence.2026.21",
        access: "fixture_transport",
        fromCache: false,
      },
      rateLimit: {
        limit: 10,
        interval: "1s",
        concurrencyLimit: 3,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.crossref.org/v1/works/10.5555%2Fevidence.2026.21",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
      },
    });
  });

  it.each([
    {
      label: "DataCite",
      agency: {
        ...CROSSREF_AGENCY,
        agency: "DataCite",
      } satisfies RegistrationAgencyResult,
      expected: "unsupported_agency",
    },
    {
      label: "unidentified",
      agency: {
        status: "unknown",
        agency: null,
        failureCode: "unknown_agency",
        attempts: 1,
        checkedAt: CHECKED_AT,
        attemptHistory: [],
      } satisfies RegistrationAgencyResult,
      expected: "not_applicable",
    },
  ])("does not fetch for $label registration agency", async ({ agency, expected }) => {
    const fetch = vi.fn();
    const result = await verifier(fetch).verify(
      request({ registrationAgency: agency }),
    );

    expect(result.status).toBe(expected);
    expect(result.checkedAt).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed DOI input before network access", async () => {
    const fetch = vi.fn();
    const result = await verifier(fetch).verify(request({ doi: "not a doi" }));

    expect(result).toMatchObject({
      status: "not_applicable",
      failureCode: "invalid_doi",
      canonicalDoi: null,
      checkedAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("explicit Crossref field comparison rubric", () => {
  it("stores per-field normalized values, exact reasons, and year-source precedence", async () => {
    const result = await verifier(
      vi.fn(async () => response(200, crossrefEnvelope())),
    ).verify(request());

    expect(result.comparison).toMatchObject({
      rubricVersion: "crossref-v0",
      fields: [
        {
          field: "doi",
          status: "match",
          supplied: CROSSREF_DOI,
          provider: CROSSREF_DOI,
          reason: "canonical_doi_equal",
        },
        {
          field: "title",
          status: "match",
          supplied: "evidence-first metadata verification",
          provider: "evidence-first metadata verification",
          reason: "normalized_title_equal",
        },
        {
          field: "authors",
          status: "match",
          supplied: ["ada lovelace", "grace hopper"],
          provider: ["ada lovelace", "grace hopper"],
          reason: "ordered_normalized_authors_equal",
        },
        {
          field: "year",
          status: "match",
          supplied: 2024,
          provider: 2024,
          reason: "publication_year_equal",
          providerSource: "published-print",
        },
      ],
      providerYearCandidates: [
        { source: "published-print", year: 2024 },
        { source: "published-online", year: 2023 },
        { source: "issued", year: 2022 },
      ],
    });
  });

  it.each([
    {
      supplied: "Sodium Na+ transport",
      provider: "Sodium Na− transport",
      label: "plus and mathematical minus",
    },
    {
      supplied: "Threshold x < y",
      provider: "Threshold x > y",
      label: "less-than and greater-than",
    },
    {
      supplied: "Phase α response",
      provider: "Phase a response",
      label: "Greek and Latin letters",
    },
    {
      supplied: "Signal x²",
      provider: "Signal x2",
      label: "superscript and baseline digits",
    },
    {
      supplied: "Molecular H₂O",
      provider: "Molecular H2O",
      label: "subscript and baseline digits",
    },
    {
      supplied: "Charge Na⁺",
      provider: "Charge Na+",
      label: "superscript and baseline operators",
    },
  ])(
    "does not erase semantic title distinctions: $label",
    async ({ supplied, provider }) => {
      const result = await verifier(
        vi.fn(async () =>
          response(
            200,
            crossrefEnvelope(workWith(CROSSREF_DOI, provider)),
          ),
        ),
      ).verify(request({ supplied: { title: supplied } }));

      expect(result.status).toBe("mismatch");
      expect(
        result.comparison.fields.find(({ field }) => field === "title"),
      ).toMatchObject({
        status: "mismatch",
        reason: "normalized_title_differs",
      });
    },
  );

  it.each([
    {
      supplied: "Café transport",
      provider: "Cafe\u0301 transport",
      label: "canonically equivalent combining marks",
    },
    {
      supplied: "Alpha-beta response",
      provider: "Alpha‐beta response",
      label: "typographic hyphen",
    },
    {
      supplied: "\"Quoted\" evidence",
      provider: "“Quoted” evidence",
      label: "typographic double quotes",
    },
    {
      supplied: "Author's result",
      provider: "Author’s result",
      label: "typographic apostrophe",
    },
  ])(
    "collapses only documented typographic title equivalence: $label",
    async ({ supplied, provider }) => {
      const result = await verifier(
        vi.fn(async () =>
          response(
            200,
            crossrefEnvelope(workWith(CROSSREF_DOI, provider)),
          ),
        ),
      ).verify(request({ supplied: { title: supplied } }));

      expect(
        result.comparison.fields.find(({ field }) => field === "title"),
      ).toMatchObject({
        status: "match",
        reason: "normalized_title_equal",
      });
    },
  );

  it("treats author order and lossy initials as mismatches rather than false equality", async () => {
    const client = verifier(
      vi.fn(async () => response(200, crossrefEnvelope())),
    );

    const reordered = await client.verify(
      request({ supplied: { authors: ["Grace Hopper", "Ada Lovelace"] } }),
    );
    const initials = await client.verify(
      request({ supplied: { authors: ["A. Lovelace", "G. Hopper"] } }),
    );

    expect(reordered).toMatchObject({ status: "mismatch" });
    expect(
      reordered.comparison.fields.find(({ field }) => field === "authors"),
    ).toMatchObject({
      status: "mismatch",
      reason: "author_order_differs",
    });
    expect(
      initials.comparison.fields.find(({ field }) => field === "authors"),
    ).toMatchObject({
      status: "mismatch",
      reason: "author_names_differ",
    });
  });

  it("reports mismatch and missing values distinctly", async () => {
    const work = {
      ...CROSSREF_WORK,
      DOI: "10.5555/different",
      title: [],
      author: [],
      "published-print": undefined,
      "published-online": undefined,
      issued: undefined,
    };
    const result = await verifier(
      vi.fn(async () => response(200, crossrefEnvelope(work))),
    ).verify(request());

    expect(result.status).toBe("mismatch");
    expect(result.comparison.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "doi",
          status: "mismatch",
          reason: "canonical_doi_differs",
        }),
        expect.objectContaining({
          field: "title",
          status: "provider_missing",
        }),
        expect.objectContaining({
          field: "authors",
          status: "provider_missing",
        }),
        expect.objectContaining({
          field: "year",
          status: "provider_missing",
        }),
      ]),
    );
  });

  it("returns partial when the caller did not supply optional comparison fields", async () => {
    const result = await verifier(
      vi.fn(async () => response(200, crossrefEnvelope())),
    ).verify(request({ supplied: {} }));

    expect(result.status).toBe("partial");
    expect(result.comparison.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "doi", status: "match" }),
        expect.objectContaining({ field: "title", status: "not_supplied" }),
        expect.objectContaining({ field: "authors", status: "not_supplied" }),
        expect.objectContaining({ field: "year", status: "not_supplied" }),
      ]),
    );
  });
});

describe("Crossref integrity relation evidence", () => {
  it("preserves exact identifiers, direction, source, and update type from both relation shapes", async () => {
    const result = await verifier(
      vi.fn(async () => response(200, crossrefEnvelope())),
    ).verify(request());

    expect(result.integrityNotice).toMatchObject({
      status: "notice_relations_found",
      summary: "notice relation evidence found in checked Crossref fields",
      checkedFields: [
        "message.update-to",
        "message.relation.update-to",
        "message.relation.updated-by",
      ],
      relations: [
        {
          direction: "update-to",
          identifier: "10.5555/evidence.2026.correction",
          canonicalIdentifier: "10.5555/evidence.2026.correction",
          identifierType: "doi",
          updateType: "correction",
          source: "publisher",
          label: "Correction",
          updatedAt: "2025-02-03T00:00:00Z",
          location: "message.update-to[0]",
        },
        {
          direction: "updated-by",
          identifier: "10.5555/evidence.2026.notice",
          canonicalIdentifier: "10.5555/evidence.2026.notice",
          identifierType: "doi",
          assertedBy: "subject",
          location: "message.relation.updated-by[0]",
        },
      ],
      issues: [],
    });
  });

  it("uses the exact bounded absence wording and does not imply an authoritative finding", async () => {
    const work = {
      ...CROSSREF_WORK,
      "update-to": undefined,
      relation: {},
    };
    const result = await verifier(
      vi.fn(async () => response(200, crossrefEnvelope(work))),
    ).verify(request());

    expect(result.integrityNotice).toMatchObject({
      status: "no_notice_found_in_checked_sources",
      summary: "no notice found in checked sources",
      relations: [],
      issues: [],
    });
    expect(JSON.stringify(result.integrityNotice)).not.toMatch(
      /safe|authoritative|complete|rights.clear|entail/iu,
    );
  });

  it("preserves duplicates and conflicts while flagging malformed relation entries", async () => {
    const relation = {
      "update-to": [
        {
          id: "10.5555/exact",
          "id-type": "doi",
          "asserted-by": "subject",
        },
        {
          id: "10.5555/exact",
          "id-type": "doi",
          "asserted-by": "subject",
        },
        {
          id: "10.5555/exact",
          "id-type": "doi",
          "asserted-by": "subject",
          "update-type": "retraction",
        },
        {
          id: 42,
          "id-type": "doi",
        },
        {
          id: "10.5555/wrong-type",
          "id-type": 42,
        },
      ],
      "updated-by": "wrong-shape",
    };
    const result = await verifier(
      vi.fn(async () =>
        response(
          200,
          crossrefEnvelope({
            ...CROSSREF_WORK,
            "update-to": undefined,
            relation,
          }),
        ),
      ),
    ).verify(request());

    expect(result.integrityNotice).toMatchObject({
      status: "notice_relations_found_with_issues",
      relations: [
        expect.objectContaining({ identifier: "10.5555/exact" }),
        expect.objectContaining({ identifier: "10.5555/exact" }),
        expect.objectContaining({
          identifier: "10.5555/exact",
          updateType: "retraction",
        }),
      ],
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_relation" }),
        expect.objectContaining({ code: "conflicting_relation" }),
        expect.objectContaining({ code: "malformed_relation" }),
        expect.objectContaining({ location: "message.relation.updated-by" }),
      ]),
    });
  });

  it("reports an incomplete check, not a clean absence, when relation fields are malformed", async () => {
    const result = await verifier(
      vi.fn(async () =>
        response(
          200,
          crossrefEnvelope({
            ...CROSSREF_WORK,
            "update-to": { DOI: "10.5555/wrong-container" },
            relation: null,
          }),
        ),
      ),
    ).verify(request());

    expect(result.integrityNotice).toMatchObject({
      status: "relation_check_incomplete",
      summary: "relation evidence could not be fully inspected",
      relations: [],
    });
  });
});

describe("bounded transport, retry, cache, and privacy behavior", () => {
  it("coalesces concurrent same-DOI cold misses and returns independent result objects", async () => {
    const transport = deferred<Response>();
    const events: CrossrefLogEvent[] = [];
    const fetch = vi.fn(async () => transport.promise);
    const client = verifier(fetch, {
      log: (event) => events.push(event),
    });

    const leaderPromise = client.verify(request());
    const followerPromise = client.verify(request());
    await flushMicrotasks();

    expect(fetch).toHaveBeenCalledTimes(1);
    transport.resolve(response(200, crossrefEnvelope()));
    const [leader, follower] = await Promise.all([
      leaderPromise,
      followerPromise,
    ]);

    expect(leader).toMatchObject({
      status: "verified",
      cache: { status: "miss" },
      source: { requestCoalesced: false },
    });
    expect(follower).toMatchObject({
      status: "verified",
      cache: { status: "coalesced" },
      source: { requestCoalesced: true },
    });
    expect(events).toHaveLength(1);
    expect(leader).not.toBe(follower);
    expect(leader.comparison).not.toBe(follower.comparison);
    expect(leader.comparison.fields).not.toBe(follower.comparison.fields);
    leader.comparison.fields[0]!.provider = "mutated-by-first-caller";
    expect(follower.comparison.fields[0]?.provider).toBe(CROSSREF_DOI);
    if (
      leader.integrityNotice.status !== "not_checked" &&
      follower.integrityNotice.status !== "not_checked"
    ) {
      (
        leader.integrityNotice.checkedFields as unknown as string[]
      )[0] = "mutated-by-first-caller";
      expect(follower.integrityNotice.checkedFields[0]).toBe(
        "message.update-to",
      );
    }
    (leader.doesNotEstablish as unknown as string[])[0] =
      "mutated-by-first-caller";
    expect(follower.doesNotEstablish[0]).toBe("authority");

    const cached = await client.verify(request());
    expect(cached).toMatchObject({
      cache: { status: "hit" },
      source: { fromCache: true, requestCoalesced: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("globally serializes different DOI transports across verifier instances", async () => {
    const firstDoi = "10.5555/concurrency-first";
    const secondDoi = "10.5555/concurrency-second";
    const firstTransport = deferred<Response>();
    const firstFetch = vi.fn(async () => firstTransport.promise);
    const secondFetch = vi.fn(async () =>
      response(
        200,
        crossrefEnvelope(workWith(secondDoi, "Second result")),
      ),
    );
    const firstClient = verifier(firstFetch);
    const secondClient = verifier(secondFetch);

    const firstPromise = firstClient.verify(
      request({
        doi: firstDoi,
        supplied: { title: "First result" },
      }),
    );
    const secondPromise = secondClient.verify(
      request({
        doi: secondDoi,
        supplied: { title: "Second result" },
      }),
    );
    await flushMicrotasks();

    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
    firstTransport.resolve(
      response(
        200,
        crossrefEnvelope(workWith(firstDoi, "First result")),
      ),
    );
    await firstPromise;
    await flushMicrotasks();

    expect(secondFetch).toHaveBeenCalledTimes(1);
    await expect(secondPromise).resolves.toMatchObject({
      status: "partial",
      canonicalDoi: secondDoi,
    });
  });

  it("shares leader failure with followers, clears single-flight state, and permits a clean retry", async () => {
    const transport = deferred<Response>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => transport.promise)
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      retry: { maxAttempts: 1 },
    });

    const leaderPromise = client.verify(request());
    const followerPromise = client.verify(request());
    await flushMicrotasks();
    expect(fetch).toHaveBeenCalledTimes(1);

    transport.reject(new Error("synthetic provider disconnect"));
    const [leader, follower] = await Promise.all([
      leaderPromise,
      followerPromise,
    ]);
    expect(leader).toMatchObject({
      status: "provider_unavailable",
      failureCode: "network_error",
      cache: { status: "miss" },
      source: { requestCoalesced: false },
    });
    expect(follower).toMatchObject({
      status: "provider_unavailable",
      failureCode: "network_error",
      cache: { status: "coalesced" },
      source: { requestCoalesced: true },
    });

    const retry = await client.verify(request());
    expect(retry).toMatchObject({
      status: "verified",
      cache: { status: "miss" },
      source: { requestCoalesced: false },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts one hanging same-DOI leader, releases all followers, and cleans up for retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const leaderPromise = client.verify(request());
      const followerPromise = client.verify(request());
      await flushMicrotasks();
      expect(fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      const [leader, follower] = await Promise.all([
        leaderPromise,
        followerPromise,
      ]);
      expect(leader).toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        source: { requestCoalesced: false },
      });
      expect(follower).toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        source: { requestCoalesced: true },
      });
      expect(bodyCancelled).toBe(true);

      await flushMicrotasks();
      const retry = await client.verify(request());
      expect(retry).toMatchObject({
        status: "verified",
        cache: { status: "miss" },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a different-DOI permit waiter within its own budget and leaves no stale queue entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    const blockingBody = new ReadableStream<Uint8Array>();
    const firstFetch = vi.fn(async () =>
      new Response(blockingBody, { status: 200 }),
    );
    const secondFetch = vi.fn(async () =>
      response(
        200,
        crossrefEnvelope(workWith("10.5555/queued", "Queued result")),
      ),
    );
    const firstClient = verifier(firstFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 2_000 },
      retry: { maxAttempts: 1, timeoutMs: 2_000 },
    });
    const secondClient = verifier(secondFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const firstPromise = firstClient.verify(
        request({ doi: "10.5555/blocking", supplied: {} }),
      );
      await flushMicrotasks();
      const queuedPromise = secondClient.verify(
        request({ doi: "10.5555/queued", supplied: {} }),
      );
      await flushMicrotasks();
      expect(firstFetch).toHaveBeenCalledTimes(1);
      expect(secondFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(queuedPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        attempts: 0,
      });
      expect(secondFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(firstPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
      });
      await flushMicrotasks();

      const cleanRetry = secondClient.verify(
        request({ doi: "10.5555/queued", supplied: {} }),
      );
      await flushMicrotasks();
      await expect(cleanRetry).resolves.toMatchObject({
        status: "partial",
        failureCode: null,
      });
      expect(secondFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the global permit when fetch ignores abort and cancels a late response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    const ignoredFetch = deferred<Response>();
    let lateBodyCancelled = false;
    const lateBody = new ReadableStream<Uint8Array>({
      cancel: () => {
        lateBodyCancelled = true;
      },
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => ignoredFetch.promise)
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const timedOutPromise = client.verify(request());
      await flushMicrotasks();
      expect(fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(timedOutPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
      });
      await flushMicrotasks();

      await expect(client.verify(request())).resolves.toMatchObject({
        status: "verified",
        cache: { status: "miss" },
      });
      expect(fetch).toHaveBeenCalledTimes(2);

      ignoredFetch.resolve(new Response(lateBody, { status: 200 }));
      await flushMicrotasks();
      expect(lateBodyCancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the permit after attempt abort until an ignored fetch and late-response cleanup settle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    const ignoredFetch = deferred<Response>();
    const lateCancellation = deferred<void>();
    let requestAborted = false;
    let lateCancellationStarted = false;
    let firstSettled = false;
    const lateBody = new ReadableStream<Uint8Array>({
      cancel: () => {
        lateCancellationStarted = true;
        return lateCancellation.promise;
      },
    });
    const firstFetch = vi
      .fn()
      .mockImplementationOnce(
        async (_input: string, init?: RequestInit) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
            },
            { once: true },
          );
          return ignoredFetch.promise;
        },
      )
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const queuedDoi = "10.5555/ignored-fetch-queued";
    const queuedFetch = vi.fn(async () =>
      response(
        200,
        crossrefEnvelope(workWith(queuedDoi, "Queued result")),
      ),
    );
    const firstClient = verifier(firstFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 2_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });
    const queuedClient = verifier(queuedFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 3_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const firstPromise = firstClient.verify(request());
      void firstPromise.finally(() => {
        firstSettled = true;
      });
      await flushMicrotasks();
      const queuedPromise = queuedClient.verify(
        request({ doi: queuedDoi, supplied: {} }),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestAborted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(queuedFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      ignoredFetch.resolve(new Response(lateBody, { status: 200 }));
      await flushMicrotasks();
      expect(lateCancellationStarted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(queuedFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      lateCancellation.resolve();
      await expect(firstPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "timeout",
      });
      await expect(queuedPromise).resolves.toMatchObject({
        status: "partial",
        failureCode: null,
      });
      expect(queuedFetch).toHaveBeenCalledTimes(1);

      await expect(firstClient.verify(request())).resolves.toMatchObject({
        status: "verified",
        cache: { status: "miss" },
      });
      expect(firstFetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 503])(
    "bounds cancellation of a hanging HTTP %s body and leaves the permit reusable",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(CHECKED_AT));
      let bodyCancelStarted = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          bodyCancelStarted = true;
          return new Promise<void>(() => undefined);
        },
      });
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(body, { status }))
        .mockResolvedValueOnce(response(200, crossrefEnvelope()));
      const client = verifier(fetch, {
        now: () => new Date(Date.now()),
        limits: { deadlineMs: 1_000 },
        retry: { maxAttempts: 1, timeoutMs: 1_000 },
      });

      try {
        const firstPromise = client.verify(request());
        await flushMicrotasks();
        expect(bodyCancelStarted).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(firstPromise).resolves.toMatchObject({
          status: "provider_unavailable",
          failureCode: "deadline_exceeded",
          attempts: 1,
          cache: { status: "miss" },
        });
        await flushMicrotasks();

        await expect(client.verify(request())).resolves.toMatchObject({
          status: "verified",
          cache: { status: "miss" },
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds cancellation of a declared-oversized success body before reusing the permit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    let bodyCancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-length": "1001" },
        }),
      )
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000, responseBytes: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const firstPromise = client.verify(request());
      await flushMicrotasks();
      expect(bodyCancelStarted).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(firstPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        cache: { status: "miss" },
      });
      await flushMicrotasks();

      await expect(client.verify(request())).resolves.toMatchObject({
        status: "verified",
        cache: { status: "miss" },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors bounded Retry-After and never logs DOI, URL, mailto, token, headers, or bodies", async () => {
    const token = "crossref-secret-token";
    const mailto = "private@example.test";
    const events: CrossrefLogEvent[] = [];
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(429, { message: `${CROSSREF_DOI}?mailto=${mailto}` }, {
          "retry-after": "99",
          "x-private-header": token,
        }),
      )
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));

    const result = await verifier(fetch, {
      evidenceMode: "live",
      mailto,
      plusApiToken: token,
      sleep,
      log: (event) => events.push(event),
    }).verify(request());

    expect(result.status).toBe("verified");
    expect(result.attemptHistory).toEqual([
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
    expect(fetch.mock.calls[0]?.[0]).toContain(
      "mailto=private%40example.test",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "Crossref-Plus-API-Token": `Bearer ${token}`,
      },
    });
    const serialized = JSON.stringify(events);
    for (const privateValue of [
      token,
      mailto,
      CROSSREF_DOI,
      "api.crossref.org",
      "retry-after",
      "x-private-header",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    { status: 404, expectedStatus: "record_not_found", failureCode: "not_found" },
    { status: 429, expectedStatus: "rate_limited", failureCode: "rate_limited" },
    { status: 503, expectedStatus: "provider_unavailable", failureCode: "provider_unavailable" },
    { status: 400, expectedStatus: "error", failureCode: "request_rejected" },
  ])(
    "maps HTTP $status to $expectedStatus without fabricating metadata",
    async ({ status, expectedStatus, failureCode }) => {
      const result = await verifier(
        vi.fn(async () => response(status)),
        { retry: { maxAttempts: 1 } },
      ).verify(request());

      expect(result).toMatchObject({
        status: expectedStatus,
        failureCode,
        comparison: { fields: [] },
        integrityNotice: { status: "not_checked" },
      });
    },
  );

  it("maps malformed JSON, invalid envelopes, and oversized bodies to invalid_response", async () => {
    const malformed = await verifier(
      vi.fn(async () => new Response("{", { status: 200 })),
    ).verify(request());
    const invalid = await verifier(
      vi.fn(async () => response(200, { status: "ok", message: [] })),
    ).verify(request());
    const oversized = await verifier(
      vi.fn(async () =>
        new Response(JSON.stringify(crossrefEnvelope()), {
          status: 200,
          headers: { "content-length": "1000001" },
        }),
      ),
    ).verify(request());

    for (const result of [malformed, invalid, oversized]) {
      expect(result).toMatchObject({
        status: "error",
        failureCode: "invalid_response",
      });
    }
  });

  it("enforces the total deadline while consuming a successful body", async () => {
    let elapsedMs = 0;
    const slowResponse = new Response(null, { status: 200 });
    Object.defineProperty(slowResponse, "text", {
      value: vi.fn(async () => {
        elapsedMs = 2_000;
        return JSON.stringify(crossrefEnvelope());
      }),
    });

    const result = await verifier(
      vi.fn(async () => slowResponse),
      {
        now: () =>
          new Date(Date.parse(CHECKED_AT) + elapsedMs),
        limits: { deadlineMs: 1_000 },
        retry: { maxAttempts: 1, timeoutMs: 1_000 },
      },
    ).verify(request());

    expect(result).toMatchObject({
      status: "provider_unavailable",
      failureCode: "deadline_exceeded",
    });
  });

  it("keeps the abort timer active through a hanging body and cancels the stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
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
      const resultPromise = verifier(fetch, {
        now: () => new Date(Date.now()),
        limits: { deadlineMs: 1_000 },
        retry: { maxAttempts: 1, timeoutMs: 1_000 },
      }).verify(request());

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
      });
      expect(requestAborted).toBe(true);
      expect(bodyCancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized streamed response before parsing it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const result = await verifier(
      vi.fn(async () => new Response(body, { status: 200 })),
      {
        limits: { responseBytes: 1_000 },
        retry: { maxAttempts: 1 },
      },
    ).verify(request());

    expect(result).toMatchObject({
      status: "error",
      failureCode: "invalid_response",
    });
  });

  it.each([
    "streamed overflow",
    "declared oversize",
    "non-2xx",
  ] as const)(
    "retains the permit for %s cancellation through the total deadline, not the shorter attempt timeout",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(CHECKED_AT));
      let cancellationStarted = false;
      let firstSettled = false;
      const firstFetch = vi
        .fn()
        .mockResolvedValueOnce(
          hangingCancellationResponse(kind, () => {
            cancellationStarted = true;
          }),
        )
        .mockResolvedValueOnce(response(200, crossrefEnvelope()));
      const queuedDoi = `10.5555/${kind.replaceAll(" ", "-")}-queued`;
      const queuedFetch = vi.fn(async () =>
        response(
          200,
          crossrefEnvelope(workWith(queuedDoi, "Queued result")),
        ),
      );
      const firstClient = verifier(firstFetch, {
        now: () => new Date(Date.now()),
        limits: { deadlineMs: 2_000, responseBytes: 1_000 },
        retry: {
          maxAttempts: kind === "non-2xx" ? 2 : 1,
          timeoutMs: 1_000,
        },
      });
      const queuedClient = verifier(queuedFetch, {
        now: () => new Date(Date.now()),
        limits: { deadlineMs: 3_000 },
        retry: { maxAttempts: 1, timeoutMs: 1_000 },
      });

      try {
        const firstPromise = firstClient.verify(request());
        void firstPromise.finally(() => {
          firstSettled = true;
        });
        await flushMicrotasks();
        const queuedPromise = queuedClient.verify(
          request({ doi: queuedDoi, supplied: {} }),
        );
        await flushMicrotasks();

        expect(cancellationStarted).toBe(true);
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(queuedFetch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks();
        expect(firstSettled).toBe(false);
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(queuedFetch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(999);
        await flushMicrotasks();
        expect(firstSettled).toBe(false);
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(queuedFetch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(firstPromise).resolves.toMatchObject({
          status: "provider_unavailable",
          failureCode: "deadline_exceeded",
          attempts: 1,
          cache: { status: "miss" },
        });
        await expect(queuedPromise).resolves.toMatchObject({
          status: "partial",
          failureCode: null,
          cache: { status: "miss" },
        });
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(queuedFetch).toHaveBeenCalledTimes(1);

        await expect(firstClient.verify(request())).resolves.toMatchObject({
          status: "verified",
          cache: { status: "miss" },
        });
        expect(firstFetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a timed-out body read in cleanup while a shorter-budget waiter expires, then recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    let cancellationStarted = false;
    let firstSettled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancellationStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    const firstFetch = vi.fn(async () =>
      new Response(body, { status: 200 }),
    );
    const queuedDoi = "10.5555/read-timeout-queued";
    const queuedFetch = vi.fn(async () =>
      response(
        200,
        crossrefEnvelope(workWith(queuedDoi, "Queued retry")),
      ),
    );
    const firstClient = verifier(firstFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 2_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });
    const queuedClient = verifier(queuedFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_500 },
      retry: { maxAttempts: 1, timeoutMs: 500 },
    });

    try {
      const firstPromise = firstClient.verify(request());
      void firstPromise.finally(() => {
        firstSettled = true;
      });
      await flushMicrotasks();
      const queuedPromise = queuedClient.verify(
        request({ doi: queuedDoi, supplied: {} }),
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(cancellationStarted).toBe(false);
      expect(queuedFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(cancellationStarted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(queuedFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await expect(queuedPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        attempts: 0,
      });
      expect(firstSettled).toBe(false);
      expect(queuedFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await expect(firstPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        attempts: 1,
      });
      await expect(
        queuedClient.verify(
          request({ doi: queuedDoi, supplied: {} }),
        ),
      ).resolves.toMatchObject({
        status: "partial",
        failureCode: null,
        cache: { status: "miss" },
      });
      expect(queuedFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the global permit while streamed-overflow cancellation hangs, then releases every caller at its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CHECKED_AT));
    let cancellationStarted = false;
    let firstSettled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
      },
      cancel: () => {
        cancellationStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    const firstFetch = vi.fn(async () =>
      new Response(body, { status: 200 }),
    );
    const secondDoi = "10.5555/stream-overflow-follower";
    const secondFetch = vi.fn(async () =>
      response(
        200,
        crossrefEnvelope(workWith(secondDoi, "Follower retry")),
      ),
    );
    const firstClient = verifier(firstFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000, responseBytes: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });
    const secondClient = verifier(secondFetch, {
      now: () => new Date(Date.now()),
      limits: { deadlineMs: 1_000 },
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
    });

    try {
      const firstPromise = firstClient.verify(request());
      void firstPromise.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        },
      );
      await flushMicrotasks();

      const secondPromise = secondClient.verify(
        request({ doi: secondDoi, supplied: {} }),
      );
      await flushMicrotasks();
      expect(cancellationStarted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(secondFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(firstPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        cache: { status: "miss" },
      });
      await expect(secondPromise).resolves.toMatchObject({
        status: "provider_unavailable",
        failureCode: "deadline_exceeded",
        attempts: 0,
      });
      expect(secondFetch).not.toHaveBeenCalled();
      await flushMicrotasks();

      await expect(
        secondClient.verify(
          request({ doi: secondDoi, supplied: {} }),
        ),
      ).resolves.toMatchObject({
        status: "partial",
        failureCode: null,
        cache: { status: "miss" },
      });
      expect(secondFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains streamed-overflow cancellation rejection without an unhandled rejection or stale permit", async () => {
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown) => unhandled(reason);
    process.on("unhandledRejection", onUnhandled);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
      },
      cancel: () => Promise.reject(new Error("synthetic cancel failure")),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      limits: { responseBytes: 1_000 },
      retry: { maxAttempts: 1 },
    });

    try {
      await expect(client.verify(request())).resolves.toMatchObject({
        status: "error",
        failureCode: "invalid_response",
      });
      await expect(client.verify(request())).resolves.toMatchObject({
        status: "verified",
        cache: { status: "miss" },
      });
      await flushMicrotasks();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not retry when backoff would consume the remaining total budget", async () => {
    const fetch = vi.fn(async () =>
      response(429, null, { "retry-after": "1" }),
    );
    const sleep = vi.fn(async () => undefined);
    const result = await verifier(fetch, {
      sleep,
      limits: { deadlineMs: 1_000 },
      retry: {
        maxAttempts: 2,
        maxDelayMs: 1_000,
        timeoutMs: 1_000,
      },
    }).verify(request());

    expect(result).toMatchObject({
      status: "rate_limited",
      failureCode: "rate_limited",
      attempts: 1,
      attemptHistory: [
        expect.objectContaining({ retryDelayMs: null }),
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns timeout/network failures explicitly and never caches transient failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("timed out"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce(response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      retry: { maxAttempts: 1 },
    });

    const first = await client.verify(request());
    const second = await client.verify(request());

    expect(first).toMatchObject({
      status: "provider_unavailable",
      failureCode: "timeout",
      cache: { status: "miss" },
    });
    expect(second).toMatchObject({
      status: "verified",
      cache: { status: "miss" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a deterministic mode-separated TTL cache and preserves the original checkedAt", async () => {
    let elapsedMs = 0;
    const fetch = vi.fn(async () => response(200, crossrefEnvelope()));
    const client = verifier(fetch, {
      now: () =>
        new Date(Date.parse(CHECKED_AT) + elapsedMs),
      cache: { ttlMs: 1_000, maxEntries: 2 },
    });

    const first = await client.verify(request());
    elapsedMs = 999;
    const cached = await client.verify(request());
    elapsedMs = 1_000;
    const expired = await client.verify(request());

    expect(first.cache).toMatchObject({
      key: `crossref:fixture:${CROSSREF_DOI}`,
      status: "miss",
    });
    expect(cached).toMatchObject({
      checkedAt: CHECKED_AT,
      source: { fromCache: true },
      cache: {
        key: `crossref:fixture:${CROSSREF_DOI}`,
        status: "hit",
      },
      attempts: 0,
      attemptHistory: [],
    });
    expect(expired).toMatchObject({
      checkedAt: "2026-08-06T12:00:01.000Z",
      source: { fromCache: false },
      cache: { status: "expired" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
