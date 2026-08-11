import { describe, expect, it, vi } from "vitest";

import {
  createDoiInspector,
  normalizeDoi,
  routeMetadataProvider,
} from "../../../src/server/retrieval/doi";
import { prepareSourceImport } from "../../../src/server/provenance/source-import";
import {
  CROSSREF_DOI,
  DATACITE_DOI,
  crossrefAgencyResponse,
  dataCiteAgencyResponse,
} from "../../fixtures/retrieval/doi-service";

const checkedAt = "2026-08-06T23:00:00.000Z";
const crossrefDoiPath = "10.1038%2Fs41598-022-15900-5";
const dataCiteDoiPath = "10.25394%2Fpgs.23496710.v1";

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

describe("DOI normalization", () => {
  it.each([
    [` https://doi.org/${CROSSREF_DOI.toUpperCase()} `, CROSSREF_DOI],
    [`http://dx.doi.org/${CROSSREF_DOI}`, CROSSREF_DOI],
    [` DOI: ${CROSSREF_DOI.toUpperCase()} `, CROSSREF_DOI],
    [`  ${CROSSREF_DOI.toUpperCase()}  `, CROSSREF_DOI],
  ])("normalizes URL, prefix, case, and outer whitespace: %s", (input, doi) => {
    expect(normalizeDoi(input)).toEqual({
      status: "valid",
      originalInput: input,
      canonicalDoi: doi,
      canonicalUrl: `https://doi.org/${crossrefDoiPath}`,
    });
  });

  it.each([
    [
      "10.500.100/example",
      "10.500.100/example",
      "https://doi.org/10.500.100%2Fexample",
    ],
    [
      "10.1234/example/part",
      "10.1234/example/part",
      "https://doi.org/10.1234%2Fexample%2Fpart",
    ],
    [
      "https://doi.org/10.1234%2Fexample%2Fpart",
      "10.1234/example/part",
      "https://doi.org/10.1234%2Fexample%2Fpart",
    ],
    [
      "https://doi.org/10.1234%2F100%2525",
      "10.1234/100%25",
      "https://doi.org/10.1234%2F100%2525",
    ],
    [
      "10.1234/例子",
      "10.1234/例子",
      "https://doi.org/10.1234%2F%E4%BE%8B%E5%AD%90",
    ],
    [
      "10.1234/has whitespace",
      "10.1234/has whitespace",
      "https://doi.org/10.1234%2Fhas%20whitespace",
    ],
    [
      "10.1234/example#fragment?query=value",
      "10.1234/example#fragment?query=value",
      "https://doi.org/10.1234%2Fexample%23fragment%3Fquery=value",
    ],
  ])(
    "accepts Handbook syntax and encodes the canonical DOI once: %s",
    (input, canonicalDoi, canonicalUrl) => {
      expect(normalizeDoi(input)).toEqual({
        status: "valid",
        originalInput: input,
        canonicalDoi,
        canonicalUrl,
      });
    },
  );

  it.each([
    "not-a-doi",
    "11.1234/example",
    "10.1234",
    "10.1234/has\tcontrol",
    "https://example.com/10.1234/private",
    "https://doi.org/",
    "https://doi.org/10.1234/example?token=secret",
  ])("keeps syntactic invalidity explicit for %s", (input) => {
    const result = normalizeDoi(input);

    expect(result.status).toBe("invalid");
    expect(result.canonicalDoi).toBeNull();
    expect(result.canonicalUrl).toBeNull();
  });

  it("keeps a source without a DOI distinct from an invalid DOI", () => {
    expect(normalizeDoi(null)).toEqual({
      status: "not_provided",
      originalInput: null,
      canonicalDoi: null,
      canonicalUrl: null,
    });
  });

  it("does no network work for a source without a DOI", async () => {
    const fetch = vi.fn();
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result = await inspector.inspect(normalizeDoi(null));

    expect(result).toMatchObject({
      syntax: { status: "not_provided" },
      resolution: { status: "not_checked", attempts: 0 },
      registrationAgency: { status: "not_checked", attempts: 0 },
      metadataRoute: {
        status: "not_applicable",
        metadataStatus: "not_checked",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("DOI resolution and Registration Agency routing", () => {
  it("records a redirect without following or fetching the destination", async () => {
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return response(302, null, {
        location: "https://publisher.example/article/123",
      });
    });
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result = await inspector.resolve(CROSSREF_DOI);

    expect(result).toMatchObject({
      status: "resolved",
      finalUrl: "https://publisher.example/article/123",
      checkedAt,
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://doi.org/${crossrefDoiPath}`,
    );
  });

  it("keeps non-resolution separate from syntactic validity", async () => {
    const inspector = createDoiInspector({
      fetch: vi.fn(async () => response(404)),
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result = await inspector.resolve(CROSSREF_DOI);

    expect(result).toMatchObject({
      status: "does_not_resolve",
      finalUrl: null,
      checkedAt,
      attempts: 1,
    });
  });

  it("identifies Crossref and routes metadata without querying it", async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      return response(200, crossrefAgencyResponse);
    });
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const agency = await inspector.identifyRegistrationAgency(CROSSREF_DOI);
    const route = routeMetadataProvider(agency);

    expect(agency).toMatchObject({
      status: "identified",
      agency: "Crossref",
      attempts: 1,
      checkedAt,
    });
    expect(route).toEqual({
      status: "routed",
      provider: "crossref",
      metadataStatus: "not_checked",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://doi.org/doiRA/${crossrefDoiPath}`,
    );
  });

  it("routes a DataCite DOI away from Crossref and leaves metadata unchecked", async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      return response(200, dataCiteAgencyResponse);
    });
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const agency = await inspector.identifyRegistrationAgency(DATACITE_DOI);

    expect(routeMetadataProvider(agency)).toEqual({
      status: "routed",
      provider: "datacite",
      metadataStatus: "not_checked",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://doi.org/doiRA/${dataCiteDoiPath}`,
    );
  });

  it("uses one encoded path segment for proxy and doiRA requests", async () => {
    const doi = "10.1234/example/part";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(302, null, { location: "https://publisher.example/article" }),
      )
      .mockResolvedValueOnce(
        response(200, [
          {
            DOI: doi,
            RA: "Crossref",
          },
        ]),
      );
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result = await inspector.inspect(normalizeDoi(doi));

    expect(result.resolution.status).toBe("resolved");
    expect(result.registrationAgency.status).toBe("identified");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://doi.org/10.1234%2Fexample%2Fpart",
      "https://doi.org/doiRA/10.1234%2Fexample%2Fpart",
    ]);
  });

  it("fails the current doiRA status error envelope closed", async () => {
    const inspector = createDoiInspector({
      fetch: vi.fn(async () => response(200, [{ status: "Invalid DOI" }])),
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result =
      await inspector.identifyRegistrationAgency("10.1234/example");

    expect(result).toMatchObject({
      status: "error",
      agency: null,
      failureCode: "malformed_response",
    });
  });

  it("returns unsupported_agency without a Crossref fallback", () => {
    expect(
      routeMetadataProvider({
        status: "identified",
        agency: "EIDR",
        attempts: 1,
        checkedAt,
        attemptHistory: [],
      }),
    ).toEqual({
      status: "unsupported_agency",
      provider: null,
      registrationAgency: "EIDR",
      metadataStatus: "not_checked",
    });
  });

  it("keeps a DOI.org existence failure out of metadata routing", () => {
    expect(
      routeMetadataProvider({
        status: "does_not_exist",
        agency: null,
        attempts: 1,
        checkedAt,
        attemptHistory: [],
      }),
    ).toEqual({
      status: "not_applicable",
      provider: null,
      reason: "registration_agency_not_identified",
      metadataStatus: "not_checked",
    });
  });
});

describe("bounded failure and retry semantics", () => {
  it("retries a rate limit once, honors bounded Retry-After, and preserves history", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429, null, { "retry-after": "99" }))
      .mockResolvedValueOnce(response(200, crossrefAgencyResponse));
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 500,
      },
    });

    const result = await inspector.identifyRegistrationAgency(CROSSREF_DOI);

    expect(result.status).toBe("identified");
    expect(result.attempts).toBe(2);
    expect(result.attemptHistory).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "rate_limited",
        httpStatus: 429,
        retryDelayMs: 500,
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: "success",
        httpStatus: 200,
        retryDelayMs: null,
      }),
    ]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after the configured bound when every attempt times out", async () => {
    const timeout = Object.assign(new Error("private?token=secret"), {
      name: "AbortError",
    });
    const fetch = vi.fn(async () => {
      throw timeout;
    });
    const sleep = vi.fn(async () => undefined);
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 10,
      },
    });

    const result = await inspector.resolve(CROSSREF_DOI);

    expect(result).toMatchObject({
      status: "provider_unavailable",
      failureCode: "timeout",
      attempts: 2,
    });
    expect(result.attemptHistory).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("token=secret");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns a final rate_limited state rather than not-found or unresolved", async () => {
    const inspector = createDoiInspector({
      fetch: vi.fn(async () => response(429)),
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
      retry: {
        maxAttempts: 1,
        baseDelayMs: 10,
        maxDelayMs: 10,
      },
    });

    const result = await inspector.identifyRegistrationAgency(CROSSREF_DOI);

    expect(result.status).toBe("rate_limited");
    expect(result.agency).toBeNull();
  });
});

describe("source import SSRF boundary and redaction", () => {
  it("never server-fetches an arbitrary imported URL", () => {
    const imported = prepareSourceImport({
      doi: null,
      url: "http://169.254.169.254/latest/meta-data?token=secret#fragment",
    });

    expect(imported).toEqual({
      originalDoiInput: null,
      originalUrlInput:
        "http://169.254.169.254/latest/meta-data?token=secret#fragment",
      doi: {
        status: "not_provided",
        originalInput: null,
        canonicalDoi: null,
        canonicalUrl: null,
      },
      canonicalUrl:
        "http://169.254.169.254/latest/meta-data?token=secret",
      serverFetch: "forbidden",
      contentPolicy: "pasted_content_only",
    });
  });

  it("does not turn an invalid external DOI URL into a network request", async () => {
    const fetch = vi.fn();
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
    });

    const result = await inspector.inspect(
      normalizeDoi("http://127.0.0.1:3000/10.1234/private?token=secret"),
    );

    expect(result.syntax.status).toBe("invalid");
    expect(result.resolution.status).toBe("not_checked");
    expect(result.registrationAgency.status).toBe("not_checked");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives DOI service requests only from a DOI.org URL and redacts logs", async () => {
    const events: unknown[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(302, null, { location: "https://publisher.example/article" }),
      )
      .mockResolvedValueOnce(response(200, crossrefAgencyResponse));
    const inspector = createDoiInspector({
      fetch,
      now: () => new Date(checkedAt),
      sleep: vi.fn(),
      log: (event) => events.push(event),
    });

    const imported = prepareSourceImport({
      doi: null,
      url: `https://doi.org/${CROSSREF_DOI}`,
    });
    const result = await inspector.inspect(imported.doi);

    expect(result.syntax.status).toBe("valid");
    expect(result.resolution.status).toBe("resolved");
    expect(result.registrationAgency.status).toBe("identified");
    expect(result.metadataRoute.metadataStatus).toBe("not_checked");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://doi.org/${crossrefDoiPath}`,
      `https://doi.org/doiRA/${crossrefDoiPath}`,
    ]);
    expect(JSON.stringify(events)).not.toContain(CROSSREF_DOI);
    expect(JSON.stringify(events)).not.toContain("publisher.example");
    expect(JSON.stringify(events)).not.toContain("token");
  });
});
