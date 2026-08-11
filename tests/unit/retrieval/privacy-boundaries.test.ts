import { describe, expect, it, vi } from "vitest";

import {
  createCrossrefMetadataVerifier,
  type CrossrefLogEvent,
} from "../../../src/server/retrieval/crossref";
import {
  createDoiInspector,
  type DoiLogEvent,
  type RegistrationAgencyResult,
} from "../../../src/server/retrieval/doi";
import {
  createOpenAlexDiscoveryClient,
  type OpenAlexLogEvent,
} from "../../../src/server/retrieval/openalex";
import {
  createUntrustedEvidencePacket,
  EvidenceBoundaryError,
} from "../../../src/server/provenance/evidence-card-validation";
import { createSourcePacketBuilder } from "../../../src/server/provenance/source-packet";
import { CROSSREF_DOI } from "../../fixtures/retrieval/doi-service";
import {
  CROSSREF_DOI as METADATA_DOI,
  crossrefEnvelope,
} from "../../fixtures/retrieval/crossref-service";
import {
  OPENALEX_WORK_1,
  openAlexPage,
} from "../../fixtures/retrieval/openalex-service";
import {
  PACKET_CHECKED_AT,
  PACKET_FROZEN_AT,
  fixtureSource,
  packetFreezeDecision,
} from "../../fixtures/retrieval/source-packet";

const CHECKED_AT = "2026-08-08T07:00:00.000Z";
const CROSSREF_AGENCY: RegistrationAgencyResult = {
  status: "identified",
  agency: "Crossref",
  attempts: 1,
  checkedAt: CHECKED_AT,
  attemptHistory: [],
};

function canary(label: string): string {
  return `privacy-canary-${label}-${"x".repeat(24)}`;
}

function jsonResponse(
  status: number,
  body: unknown = null,
  headers: HeadersInit = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

function hostileFailure(secret: string, onName: () => void): object {
  const failure = Object.create({
    inheritedNearCollision: "authorization-guide",
  });
  Object.defineProperties(failure, {
    name: {
      enumerable: true,
      get() {
        onName();
        throw new Error(secret);
      },
    },
    message: { value: secret, enumerable: true },
    cause: {
      value: new Error(`nested-${secret}`),
      enumerable: true,
    },
  });
  return failure;
}

function expectNoCanaries(value: unknown, values: readonly string[]) {
  const serialized = JSON.stringify(value);
  for (const privateValue of values) {
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(encodeURIComponent(privateValue));
    expect(serialized).not.toContain(
      encodeURIComponent(encodeURIComponent(privateValue)),
    );
  }
}

async function settlePublicOperation<T>(operation: Promise<T>) {
  try {
    return { status: "resolved" as const, value: await operation };
  } catch {
    return { status: "rejected" as const, value: null };
  }
}

describe("scholarly-service privacy boundaries", () => {
  it("keeps DOI retries descriptor-safe and strips credentials, query, and fragment from the public redirect", async () => {
    const authorization = canary("authorization");
    const cookie = canary("cookie");
    const getterSecret = canary("error-accessor");
    const proxySecret = canary("error-proxy");
    const events: DoiLogEvent[] = [];
    let nameReads = 0;
    let proxyReads = 0;
    const hostileProxy = new Proxy(Object.create(null) as object, {
      get() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
      getOwnPropertyDescriptor() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
    });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        hostileFailure(getterSecret, () => {
          nameReads += 1;
        }),
      )
      .mockRejectedValueOnce(hostileProxy)
      .mockResolvedValueOnce(
        jsonResponse(302, null, {
          location:
            `https://user:${authorization}@publisher.example/authorization-guide` +
            `?cookie=${encodeURIComponent(cookie)}&nested=${encodeURIComponent(encodeURIComponent(authorization))}` +
            `#${authorization}`,
        }),
      );
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(CHECKED_AT),
      sleep: vi.fn(async () => undefined),
      log: (event) => events.push(event),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });

    const result = await inspector.resolve(CROSSREF_DOI);

    expect(nameReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect(result).toMatchObject({
      status: "resolved",
      finalUrl: "https://publisher.example/authorization-guide",
      attempts: 3,
    });
    expect(result.attemptHistory.map(({ outcome }) => outcome)).toEqual([
      "network_error",
      "network_error",
      "success",
    ]);
    expectNoCanaries(
      [result, events],
      [authorization, cookie, getterSecret, proxySecret],
    );
  });

  it("keeps Crossref credentials out of retry logs, cache identity, errors, and telemetry", async () => {
    const apiToken = canary("crossref-token");
    const mailLocalPart = canary("mailto");
    const telemetrySecret = canary("rate-header");
    const events: CrossrefLogEvent[] = [];
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: `Bearer ${apiToken}` }, {
          "retry-after": "0",
          "x-rate-limit-interval": telemetrySecret,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, crossrefEnvelope(), {
          "x-rate-limit-limit": "10",
          "x-rate-limit-interval": telemetrySecret,
          "x-concurrency-limit": "2",
        }),
      );
    const verifier = createCrossrefMetadataVerifier({
      evidenceMode: "mocked",
      fetch,
      now: () => new Date(CHECKED_AT),
      sleep,
      log: (event) => events.push(event),
      mailto: `${mailLocalPart}@example.test`,
      plusApiToken: apiToken,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1_000,
      },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
    });
    const request = {
      doi: METADATA_DOI,
      registrationAgency: CROSSREF_AGENCY,
      supplied: {
        title: "Evidence-first metadata verification",
        authors: ["Lovelace, Ada", "Grace Hopper"],
        year: 2024,
      },
    };

    const miss = await verifier.verify(request);
    const hit = await verifier.verify(request);

    expect(miss.status).toBe("verified");
    expect(miss.rateLimit).toEqual({
      limit: 10,
      interval: null,
      concurrencyLimit: 2,
    });
    expect(miss.cache.key).toBe(`crossref:mocked:${METADATA_DOI}`);
    expect(hit.cache.status).toBe("hit");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expectNoCanaries(
      [miss, hit, events],
      [apiToken, mailLocalPart, telemetrySecret],
    );
  });

  it("keeps OpenAlex exception accessors, API keys, and signed landing-page queries out of projections", async () => {
    const apiKey = canary("openalex-key");
    const signedQuery = `${canary("signed-location")}-\u00e9-e\u0301-\u{1f600}`;
    const getterSecret = canary("openalex-error-accessor");
    const events: OpenAlexLogEvent[] = [];
    let nameReads = 0;
    const work = structuredClone(OPENALEX_WORK_1);
    work.primary_location.landing_page_url =
      `https://publisher.example/tokenization-study?signature=${encodeURIComponent(signedQuery)}` +
      `&twice=${encodeURIComponent(encodeURIComponent(signedQuery))}#${signedQuery}`;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        hostileFailure(getterSecret, () => {
          nameReads += 1;
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, openAlexPage([work], null)));
    const result = await createOpenAlexDiscoveryClient({
      apiKey,
      evidenceMode: "mocked",
      fetch,
      now: () => new Date(CHECKED_AT),
      sleep: vi.fn(async () => undefined),
      log: (event) => events.push(event),
      limits: {
        maxResults: 1,
        pageSize: 1,
        maxPages: 1,
        deadlineMs: 2_000,
      },
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1_000,
      },
    }).discover("authorization-guide tokenization study");

    expect(nameReads).toBe(0);
    expect(result.status).toBe("completed");
    expect(
      result.candidates[0]?.openAccessSignal.primaryLocation?.landingPageUrl,
    ).toBe("https://publisher.example/tokenization-study");
    expect(
      result.pageHistory[0]?.attemptHistory.map(({ outcome }) => outcome),
    ).toEqual(["network_error", "success"]);
    expectNoCanaries([result, events], [apiKey, signedQuery, getterSecret]);
  });

  it("contains streamed provider failures for concurrent Crossref callers without leaking nested errors or headers", async () => {
    const streamSecret = canary("stream-error");
    const authorization = canary("stream-authorization");
    const cookie = canary("stream-cookie");
    const rawQuestion = canary("raw-question");
    const events: CrossrefLogEvent[] = [];
    const fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(
            new Error(streamSecret, {
              cause: new Error(`nested-${streamSecret}`),
            }),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          authorization,
          cookie,
          "x-rate-limit-interval": streamSecret,
        },
      });
    });
    const verifier = createCrossrefMetadataVerifier({
      evidenceMode: "mocked",
      fetch,
      now: () => new Date(CHECKED_AT),
      log: (event) => events.push(event),
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1_000,
      },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
    });
    const request = {
      doi: METADATA_DOI,
      registrationAgency: CROSSREF_AGENCY,
      supplied: { title: rawQuestion },
    };

    const [leader, follower] = await Promise.all([
      verifier.verify(request),
      verifier.verify(request),
    ]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(leader).toMatchObject({
      status: "provider_unavailable",
      failureCode: "network_error",
    });
    expect(follower).toMatchObject({
      status: "provider_unavailable",
      failureCode: "network_error",
      cache: { status: "coalesced" },
    });
    expectNoCanaries(
      [leader, follower, events],
      [streamSecret, authorization, cookie, rawQuestion],
    );
  });

  it("turns an actual DOI AbortSignal timeout into typed audit data without retaining the abort error stack", async () => {
    vi.useFakeTimers();
    const abortSecret = canary("abort-stack");
    const events: DoiLogEvent[] = [];
    let observedAbort = false;
    try {
      const fetch = vi.fn(
        async (_input: string, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(
                  Object.assign(
                    new Error(abortSecret, {
                      cause: new Error(`nested-${abortSecret}`),
                    }),
                    { name: "AbortError" },
                  ),
                );
              },
              { once: true },
            );
          }),
      );
      const pending = createDoiInspector({
        fetch,
        now: () => new Date(),
        log: (event) => events.push(event),
        retry: {
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          timeoutMs: 5,
        },
      }).resolve(CROSSREF_DOI);

      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;

      expect(observedAbort).toBe(true);
      expect(result).toMatchObject({
        status: "provider_unavailable",
        failureCode: "timeout",
        attemptHistory: [expect.objectContaining({ outcome: "timeout" })],
      });
      expectNoCanaries([result, events], [abortSecret]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dependency callback containment", () => {
  it("keeps Crossref evidence and cache identity stable when a swallowed log failure mutates caller dependencies", async () => {
    const mutationSecret = canary("crossref-dependency-alias");
    const events: CrossrefLogEvent[] = [];
    const replacementLog = vi.fn(() => {
      throw new Error(mutationSecret);
    });
    const dependencies: Parameters<
      typeof createCrossrefMetadataVerifier
    >[0] = {
      evidenceMode: "mocked",
      fetch: vi.fn(async () => jsonResponse(200, crossrefEnvelope())),
      now: () => new Date(CHECKED_AT),
      retry: { maxAttempts: 1 },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
    };
    dependencies.log = (event) => {
      events.push(event);
      dependencies.evidenceMode = "live";
      dependencies.log = replacementLog;
      dependencies.cache = { ttlMs: 1, maxEntries: 1 };
      throw new Error(mutationSecret, {
        cause: new Error(`nested-${mutationSecret}`),
      });
    };
    const verifier = createCrossrefMetadataVerifier(dependencies);
    const request = {
      doi: METADATA_DOI,
      registrationAgency: CROSSREF_AGENCY,
    };

    const miss = await verifier.verify(request);
    const hit = await verifier.verify(request);

    expect(miss).toMatchObject({
      evidenceMode: "mocked",
      source: { access: "mocked_transport" },
      cache: { key: `crossref:mocked:${METADATA_DOI}`, status: "miss" },
    });
    expect(hit).toMatchObject({
      evidenceMode: "mocked",
      source: { access: "mocked_transport", fromCache: true },
      cache: { key: `crossref:mocked:${METADATA_DOI}`, status: "hit" },
    });
    expect(events).toEqual([
      expect.objectContaining({ evidenceMode: "mocked" }),
    ]);
    expect(replacementLog).not.toHaveBeenCalled();
    expectNoCanaries([miss, hit, events], [mutationSecret]);
  });

  it("owns concurrent Crossref request/config snapshots before async telemetry mutation resumes", async () => {
    const mutationSecret = canary("crossref-async-alias");
    const initialTitle = "Evidence-first metadata verification";
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const dependencies: Parameters<
      typeof createCrossrefMetadataVerifier
    >[0] = {
      evidenceMode: "mocked",
      fetch,
      now: () => new Date(CHECKED_AT),
      retry: { maxAttempts: 1, timeoutMs: 1_000 },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
      cache: { ttlMs: 60_000, maxEntries: 5 },
    };
    const replacementLog = vi.fn();
    const request = {
      doi: METADATA_DOI,
      registrationAgency: CROSSREF_AGENCY,
      supplied: { title: initialTitle },
    };
    dependencies.log = async () => {
      await Promise.resolve();
      dependencies.evidenceMode = "unverified" as never;
      dependencies.retry!.maxAttempts = 9;
      dependencies.cache!.maxEntries = 1;
      dependencies.log = replacementLog;
      request.supplied.title = mutationSecret;
    };
    const verifier = createCrossrefMetadataVerifier(dependencies);

    const leaderPending = verifier.verify(request);
    const followerPending = verifier.verify(request);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    releaseFetch?.(jsonResponse(200, crossrefEnvelope()));
    const [leader, follower] = await Promise.all([
      leaderPending,
      followerPending,
    ]);

    expect(fetch).toHaveBeenCalledOnce();
    expect([leader, follower]).toEqual([
      expect.objectContaining({
        status: "partial",
        evidenceMode: "mocked",
        cache: expect.objectContaining({
          key: `crossref:mocked:${METADATA_DOI}`,
        }),
      }),
      expect.objectContaining({
        status: "partial",
        evidenceMode: "mocked",
        source: expect.objectContaining({ requestCoalesced: true }),
        cache: expect.objectContaining({
          key: `crossref:mocked:${METADATA_DOI}`,
          status: "coalesced",
        }),
      }),
    ]);
    for (const result of [leader, follower]) {
      expect(result.comparison.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "title",
            status: "match",
            supplied: initialTitle.toLowerCase(),
          }),
        ]),
      );
    }
    expect(replacementLog).not.toHaveBeenCalled();
    expectNoCanaries([leader, follower], [mutationSecret]);
  });

  it("captures DOI and OpenAlex callback identities and nested policy values before callbacks mutate their aliases", async () => {
    const mutationSecret = canary("multi-adapter-alias");
    const replacementLog = vi.fn(() => {
      throw new Error(mutationSecret);
    });
    const doiDependencies: Parameters<typeof createDoiInspector>[0] = {
      fetch: vi.fn(async () => jsonResponse(429)),
      now: () => new Date(CHECKED_AT),
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    };
    doiDependencies.log = () => {
      doiDependencies.retry!.maxAttempts = 3;
      doiDependencies.fetch = vi.fn(async () => jsonResponse(200));
      doiDependencies.log = replacementLog;
    };
    const openAlexDependencies: Parameters<
      typeof createOpenAlexDiscoveryClient
    >[0] = {
      apiKey: canary("openalex-alias-key"),
      evidenceMode: "mocked",
      fetch: vi.fn(async () => jsonResponse(404)),
      now: () => new Date(CHECKED_AT),
      retry: { maxAttempts: 1 },
      limits: {
        maxResults: 1,
        pageSize: 1,
        maxPages: 1,
        deadlineMs: 2_000,
      },
    };
    openAlexDependencies.log = async () => {
      await Promise.resolve();
      openAlexDependencies.evidenceMode = "live";
      openAlexDependencies.apiKey = mutationSecret;
      openAlexDependencies.retry!.maxAttempts = 4;
      openAlexDependencies.log = replacementLog;
    };

    const [doi, openAlex] = await Promise.all([
      createDoiInspector(doiDependencies).resolve(CROSSREF_DOI),
      createOpenAlexDiscoveryClient(openAlexDependencies).discover(
        "harmless dependency alias",
      ),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(doi).toMatchObject({
      status: "rate_limited",
      attempts: 1,
      attemptHistory: [{ attempt: 1, retryDelayMs: null }],
    });
    expect(openAlex).toMatchObject({
      status: "failed",
      failureCode: "request_rejected",
      evidenceMode: "mocked",
      pageHistory: [{ attemptHistory: [{ attempt: 1 }] }],
    });
    expect(replacementLog).not.toHaveBeenCalled();
    expectNoCanaries([doi, openAlex], [mutationSecret]);
  });

  it("rejects accessor and Proxy dependency containers without reflection traps or private diagnostics", () => {
    const accessorSecret = canary("dependency-accessor");
    const proxySecret = canary("dependency-proxy");
    let accessorReads = 0;
    let proxyReads = 0;
    const accessorDependencies = {
      fetch: vi.fn(async () => jsonResponse(404)),
    } as Record<string, unknown>;
    Object.defineProperty(accessorDependencies, "retry", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error(accessorSecret);
      },
    });
    const proxyDependencies = new Proxy(Object.create(null) as object, {
      get() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
      ownKeys() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
      getOwnPropertyDescriptor() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
    });

    const outcomes: unknown[] = [];
    for (const construct of [
      () => createDoiInspector(accessorDependencies as never),
      () => createCrossrefMetadataVerifier(proxyDependencies as never),
      () => createOpenAlexDiscoveryClient(accessorDependencies as never),
    ]) {
      try {
        construct();
      } catch (error) {
        outcomes.push(
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
        );
      }
    }

    expect(outcomes).toHaveLength(3);
    expect(accessorReads).toBe(0);
    expect(proxyReads).toBe(0);
    expectNoCanaries(outcomes, [accessorSecret, proxySecret]);
  });

  it("rejects accessor-bearing Crossref identifier packets before reading private fields", async () => {
    const identifierSecret = canary("identifier-accessor");
    let identifierReads = 0;
    const request = {
      registrationAgency: CROSSREF_AGENCY,
    } as Record<string, unknown>;
    Object.defineProperty(request, "doi", {
      enumerable: true,
      get() {
        identifierReads += 1;
        throw new Error(identifierSecret);
      },
    });
    const result = await createCrossrefMetadataVerifier({
      evidenceMode: "mocked",
      fetch: vi.fn(async () => jsonResponse(200, crossrefEnvelope())),
      now: () => new Date(CHECKED_AT),
      retry: { maxAttempts: 1 },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
    }).verify(request as never);

    expect(identifierReads).toBe(0);
    expect(result).toMatchObject({
      status: "not_applicable",
      failureCode: "invalid_doi",
      evidenceMode: "mocked",
      cache: { key: null, status: "not_applicable" },
    });
    expectNoCanaries(result, [identifierSecret]);
  });

  it("reduces DOI backoff rejection to a typed public failure", async () => {
    const callbackSecret = canary("doi-backoff");
    const events: DoiLogEvent[] = [];
    const outcome = await settlePublicOperation(
      createDoiInspector({
        fetch: vi.fn(async () => jsonResponse(429)),
        now: () => new Date(CHECKED_AT),
        sleep: vi.fn(() => {
          throw new Error(callbackSecret, {
            cause: new Error(`nested-${callbackSecret}`),
          });
        }),
        log: (event) => events.push(event),
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          timeoutMs: 1_000,
        },
      }).resolve(CROSSREF_DOI),
    );

    expect(outcome.status).toBe("resolved");
    expect(outcome.value).toMatchObject({
      status: "provider_unavailable",
      failureCode: "network_error",
      attempts: 1,
    });
    expectNoCanaries([outcome.value, events], [callbackSecret]);
  });

  it("reduces Crossref backoff rejection for coalesced callers to one sanitized provider failure", async () => {
    const callbackSecret = canary("crossref-backoff");
    const events: CrossrefLogEvent[] = [];
    const fetch = vi.fn(async () => jsonResponse(429));
    const verifier = createCrossrefMetadataVerifier({
      evidenceMode: "mocked",
      fetch,
      now: () => new Date(CHECKED_AT),
      sleep: vi.fn(async () => Promise.reject(`rejected-${callbackSecret}`)),
      log: (event) => events.push(event),
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1_000,
      },
      limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
    });
    const request = {
      doi: METADATA_DOI,
      registrationAgency: CROSSREF_AGENCY,
    };

    const outcomes = await Promise.all([
      settlePublicOperation(verifier.verify(request)),
      settlePublicOperation(verifier.verify(request)),
    ]);

    expect(outcomes.map(({ status }) => status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(outcomes.map(({ value }) => value)).toEqual([
      expect.objectContaining({
        status: "provider_unavailable",
        failureCode: "network_error",
      }),
      expect.objectContaining({
        status: "provider_unavailable",
        failureCode: "network_error",
        cache: expect.objectContaining({ status: "coalesced" }),
      }),
    ]);
    expectNoCanaries([outcomes, events], [callbackSecret]);
  });

  it("reduces OpenAlex backoff failure without exposing an accessor-bearing rejection", async () => {
    const callbackSecret = canary("openalex-backoff");
    const events: OpenAlexLogEvent[] = [];
    let nameReads = 0;
    const failure = hostileFailure(callbackSecret, () => {
      nameReads += 1;
    });
    const outcome = await settlePublicOperation(
      createOpenAlexDiscoveryClient({
        apiKey: canary("openalex-callback-key"),
        evidenceMode: "mocked",
        fetch: vi.fn(async () => jsonResponse(429)),
        now: () => new Date(CHECKED_AT),
        sleep: vi.fn(() => Promise.reject(failure)),
        log: (event) => events.push(event),
        limits: {
          maxResults: 1,
          pageSize: 1,
          maxPages: 1,
          deadlineMs: 2_000,
        },
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          timeoutMs: 1_000,
        },
      }).discover("harmless callback near collision"),
    );

    expect(outcome.status).toBe("resolved");
    expect(outcome.value).toMatchObject({
      status: "failed",
      failureCode: "provider_unavailable",
    });
    expect(nameReads).toBe(0);
    expectNoCanaries([outcome.value, events], [callbackSecret]);
  });

  it("swallows synchronous telemetry sink failures in DOI, Crossref, and OpenAlex", async () => {
    const callbackSecret = canary("telemetry-sink");
    const failingLog = () => {
      throw new Error(callbackSecret, {
        cause: new Error(`nested-${callbackSecret}`),
      });
    };
    const doi = settlePublicOperation(
      createDoiInspector({
        fetch: vi.fn(async () => jsonResponse(404)),
        now: () => new Date(CHECKED_AT),
        log: failingLog,
        retry: { maxAttempts: 1 },
      }).resolve(CROSSREF_DOI),
    );
    const crossref = settlePublicOperation(
      createCrossrefMetadataVerifier({
        evidenceMode: "mocked",
        fetch: vi.fn(async () => jsonResponse(200, crossrefEnvelope())),
        now: () => new Date(CHECKED_AT),
        log: failingLog,
        retry: { maxAttempts: 1 },
        limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
      }).verify({
        doi: METADATA_DOI,
        registrationAgency: CROSSREF_AGENCY,
      }),
    );
    const openAlex = settlePublicOperation(
      createOpenAlexDiscoveryClient({
        apiKey: canary("telemetry-key"),
        evidenceMode: "mocked",
        fetch: vi.fn(async () =>
          jsonResponse(200, openAlexPage([OPENALEX_WORK_1], null)),
        ),
        now: () => new Date(CHECKED_AT),
        log: failingLog,
        limits: {
          maxResults: 1,
          pageSize: 1,
          maxPages: 1,
          deadlineMs: 2_000,
        },
        retry: { maxAttempts: 1 },
      }).discover("harmless telemetry near collision"),
    );

    const outcomes = await Promise.all([doi, crossref, openAlex]);
    expect(outcomes.map(({ status }) => status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(outcomes.map(({ value }) => value)).toEqual([
      expect.objectContaining({
        status: "does_not_resolve",
        failureCode: "not_found",
      }),
      expect.objectContaining({
        status: "partial",
        failureCode: null,
      }),
      expect.objectContaining({
        status: "completed",
        failureCode: null,
      }),
    ]);
    expectNoCanaries(outcomes, [callbackSecret]);
  });

  it("settles async telemetry rejection strings, nested errors, and proxies without unhandled rejections", async () => {
    const nestedSecret = canary("async-log-error");
    const stringSecret = canary("async-log-string");
    const proxySecret = canary("async-log-proxy");
    const unhandled: unknown[] = [];
    let proxyReads = 0;
    const proxyFailure = new Proxy(Object.create(null) as object, {
      get() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
      getOwnPropertyDescriptor() {
        proxyReads += 1;
        throw new Error(proxySecret);
      },
    });
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const doi = createDoiInspector({
        fetch: vi.fn(async () => jsonResponse(404)),
        now: () => new Date(CHECKED_AT),
        log: (() =>
          Promise.reject(
            new Error(nestedSecret, {
              cause: new Error(`nested-${nestedSecret}`),
            }),
          )) as never,
        retry: { maxAttempts: 1 },
      }).resolve(CROSSREF_DOI);
      const crossref = createCrossrefMetadataVerifier({
        evidenceMode: "mocked",
        fetch: vi.fn(async () => jsonResponse(404)),
        now: () => new Date(CHECKED_AT),
        log: (() => Promise.reject(stringSecret)) as never,
        retry: { maxAttempts: 1 },
        limits: { deadlineMs: 2_000, responseBytes: 1_000_000 },
      }).verify({
        doi: METADATA_DOI,
        registrationAgency: CROSSREF_AGENCY,
      });
      const openAlex = createOpenAlexDiscoveryClient({
        apiKey: canary("async-log-key"),
        evidenceMode: "mocked",
        fetch: vi.fn(async () => jsonResponse(404)),
        now: () => new Date(CHECKED_AT),
        log: (() => Promise.reject(proxyFailure)) as never,
        limits: {
          maxResults: 1,
          pageSize: 1,
          maxPages: 1,
          deadlineMs: 2_000,
        },
        retry: { maxAttempts: 1 },
      }).discover("authorization guide near collision");

      const results = await Promise.all([doi, crossref, openAlex]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(results).toEqual([
        expect.objectContaining({
          status: "does_not_resolve",
          failureCode: "not_found",
        }),
        expect.objectContaining({
          status: "record_not_found",
          failureCode: "not_found",
        }),
        expect.objectContaining({
          status: "failed",
          failureCode: "request_rejected",
        }),
      ]);
      expect(proxyReads).toBe(0);
      expect(unhandled).toEqual([]);
      expectNoCanaries(results, [nestedSecret, stringSecret, proxySecret]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("rights-aware render, model, audit, and serialized-export projections", () => {
  it("never releases private stored excerpts or hostile accessor values across success and rejection paths", async () => {
    const privateExcerpt = canary("private-excerpt");
    const accessorSecret = canary("source-accessor");
    const events: unknown[] = [];
    const rejectedEvents: unknown[] = [];
    let getterReads = 0;
    const builder = createSourcePacketBuilder({
      now: () => new Date(PACKET_CHECKED_AT),
      log: (event) => events.push(event),
    });
    const hostile = fixtureSource({ id: "hostile-source" }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostile, "content", {
      enumerable: true,
      get() {
        getterReads += 1;
        return accessorSecret;
      },
    });

    await expect(builder.addSource(hostile as never)).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_metadata",
    });
    await expect(
      builder.addSource(
        fixtureSource({
          id: "private-source",
          stableId: "fixture:private-source",
          doi: "10.5555/private.26",
          url:
            "https://example.test/authorization-guide" +
            `?token=${encodeURIComponent(privateExcerpt)}`,
          content: privateExcerpt,
          rights: {
            mayStore: "allowed",
            mayDisplay: "denied",
            maySendToModel: "denied",
            permissionBasis: "storage-only synthetic fixture",
            checkedAt: PACKET_CHECKED_AT,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "stored" });

    const rejectedBuilder = createSourcePacketBuilder({
      log: (event) => rejectedEvents.push(event),
    });
    const rejected = await rejectedBuilder.addSource(
      fixtureSource({
        id: "rights-rejected-source",
        stableId: "fixture:rights-rejected-source",
        doi: "10.5555/rejected.26",
        content: privateExcerpt,
        rights: {
          mayStore: "denied",
          mayDisplay: "denied",
          maySendToModel: "denied",
          permissionBasis: "synthetic denial",
          checkedAt: PACKET_CHECKED_AT,
        },
      }),
    );

    const review = await builder.getReviewSnapshot();
    const model = await builder.getModelPayload();
    const frozen = await builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    const audit = await builder.getAuditLog();
    let boundaryError: EvidenceBoundaryError | null = null;
    try {
      createUntrustedEvidencePacket(frozen.evidenceCapability);
    } catch (error) {
      boundaryError = error as EvidenceBoundaryError;
    }

    expect(getterReads).toBe(0);
    expect(review.sources[0]?.content).toEqual({
      status: "blocked",
      reason: "display_permission_denied",
      chunks: [],
    });
    expect(model.chunks).toEqual([]);
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "storage_permission_denied",
    });
    expect((await rejectedBuilder.getReviewSnapshot()).sources).toEqual([]);
    expect(boundaryError).toMatchObject({
      name: "EvidenceBoundaryError",
      code: "model_send_denied",
    });
    expectNoCanaries(
      [
        review,
        model,
        frozen,
        audit,
        events,
        rejected,
        rejectedEvents,
        boundaryError === null
          ? null
          : {
              name: boundaryError.name,
              message: boundaryError.message,
              stack: boundaryError.stack,
              code: boundaryError.code,
            },
      ],
      [privateExcerpt, accessorSecret],
    );
  });
});
