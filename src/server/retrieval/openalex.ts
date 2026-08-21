import { createHash } from "node:crypto";

import { z } from "zod";

import {
  completeBackoff,
  emitOptionalTelemetry,
  publicExternalUrl,
  requestExceptionOutcome,
  snapshotPassiveValue,
  validatedOptionalCallback,
} from "./privacy";

import { normalizeDoi } from "./doi";

const OPENALEX_API_ORIGIN = "https://api.openalex.org";
const OPENALEX_WORKS_PATH = "/works";
const MAX_QUERY_CODE_POINTS = 500;
const MAX_QUERY_BYTES = 2_000;
const MAX_ORIGINAL_QUERY_BYTES = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const OPENALEX_WORK_ID = /^https:\/\/openalex\.org\/(W\d+)$/u;
const OPENALEX_AUTHOR_ID = /^https:\/\/openalex\.org\/(A\d+)$/u;
const OPENALEX_SOURCE_ID = /^https:\/\/openalex\.org\/(S\d+)$/u;
const SELECT_FIELDS = [
  "id",
  "doi",
  "title",
  "publication_year",
  "relevance_score",
  "cited_by_count",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "abstract_inverted_index",
].join(",");

const sourceSchema = z
  .object({
    id: z.string(),
    display_name: z.string().nullable(),
  })
  .passthrough();

const locationSchema = z
  .object({
    landing_page_url: z.string().nullable(),
    is_oa: z.boolean().nullable().optional(),
    license: z.string().nullable(),
    version: z.string().nullable(),
    source: sourceSchema.nullable(),
  })
  .passthrough();

const workSchema = z
  .object({
    id: z.string(),
    doi: z.string().nullable(),
    title: z.string().nullable(),
    publication_year: z.number().int().nullable(),
    relevance_score: z.number().nonnegative().nullable().optional(),
    cited_by_count: z.number().int().nonnegative(),
    authorships: z.array(
      z
        .object({
          author: z
            .object({
              id: z.string().nullable(),
              display_name: z.string().nullable(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    primary_location: locationSchema.nullable(),
    best_oa_location: locationSchema.nullable(),
    open_access: z
      .object({
        is_oa: z.boolean(),
        oa_status: z.string().nullable(),
        any_repository_has_fulltext: z.boolean().nullable(),
      })
      .passthrough(),
    abstract_inverted_index: z
      .record(z.string(), z.array(z.number().int().nonnegative()))
      .nullable(),
  })
  .passthrough();

const responseSchema = z
  .object({
    meta: z
      .object({
        count: z.number().int().nonnegative(),
        next_cursor: z.string().nullable().optional(),
        cost_usd: z.number().nonnegative().optional(),
      })
      .passthrough(),
    results: z.array(workSchema),
  })
  .passthrough();

export type OpenAlexEvidenceMode = "fixture" | "live" | "mocked";

export type OpenAlexQueryNormalization =
  | {
      status: "valid";
      originalQuery: string;
      normalizedQuery: string;
    }
  | {
      status: "invalid";
      originalQuery: string;
      normalizedQuery: null;
      reason: "empty" | "control_character" | "too_long";
    };

export type OpenAlexCandidate = {
  openAlexId: string;
  openAlexUrl: string;
  title: string | null;
  authors: {
    openAlexId: string;
    displayName: string;
  }[];
  publicationYear: number | null;
  providerRelevanceScore?: number | null;
  providerDoi: string | null;
  canonicalDoi: string | null;
  source: {
    openAlexId: string;
    displayName: string | null;
  } | null;
  abstractSignal: {
    providerReportedAvailable: boolean;
    contentFetched: boolean;
    text?: string | null;
  };
  openAccessSignal: {
    isOpenAccess: boolean;
    status: string | null;
    repositoryFullTextReported: boolean;
    primaryLocation: {
      landingPageUrl: string | null;
      licenseSignal: string | null;
      version: string | null;
    } | null;
    bestLocation: {
      landingPageUrl: string | null;
      licenseSignal: string | null;
      version: string | null;
    } | null;
    rightsAssessment: "not_assessed";
  };
  citations: {
    count: number;
    providerApiUrl: string;
  };
};

export type OpenAlexAttemptOutcome =
  | "success"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "network_error"
  | "error";

export type OpenAlexAttempt = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  outcome: OpenAlexAttemptOutcome;
  httpStatus: number | null;
  retryDelayMs: number | null;
};

export type OpenAlexRateLimitSnapshot = {
  limit: number | null;
  remaining: number | null;
  creditsUsed: number | null;
  resetSeconds: number | null;
};

export type OpenAlexPageHistory = {
  pageNumber: number;
  cursorHash: string;
  resultsReceived: number;
  providerReportedCostUsd: number | null;
  rateLimit: OpenAlexRateLimitSnapshot | null;
  attemptHistory: OpenAlexAttempt[];
};

export type OpenAlexDiscoveryFailureCode =
  | "invalid_query"
  | "deadline_exceeded"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "request_rejected"
  | "cursor_loop";

export type OpenAlexDiscoveryResult = {
  status: "completed" | "partial" | "failed" | "invalid_request";
  failureCode: OpenAlexDiscoveryFailureCode | null;
  evidenceMode: OpenAlexEvidenceMode;
  provider: "openalex";
  originalQuery: string;
  normalizedQuery: string | null;
  startedAt: string;
  completedAt: string;
  snapshotId: string | null;
  candidates: OpenAlexCandidate[];
  pagination: {
    maxResults: number;
    pageSize: number;
    maxPages: number;
    pagesFetched: number;
    providerResultCount: number | null;
    nextCursorAvailable: boolean;
    truncated: boolean;
    truncatedReason:
      | "max_results"
      | "max_pages"
      | "failure"
      | null;
  };
  providerUsage: {
    reportedCostUsd: number;
    rateLimit: OpenAlexRateLimitSnapshot | null;
  };
  pageHistory: OpenAlexPageHistory[];
  selectionRequired: true;
  doesNotEstablish: readonly [
    "authority",
    "completeness",
    "entailment",
    "content_availability",
    "content_rights",
  ];
};

export type OpenAlexLogEvent = {
  service: "openalex";
  operation: "search_works";
  evidenceMode: OpenAlexEvidenceMode;
  pageNumber: number;
  attempt: number;
  outcome: OpenAlexAttemptOutcome;
  httpStatus: number | null;
  retryScheduled: boolean;
};

export type OpenAlexDiscoveryDependencies = {
  apiKey?: string;
  evidenceMode: OpenAlexEvidenceMode;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (event: OpenAlexLogEvent) => void;
  limits?: Partial<{
    maxResults: number;
    pageSize: number;
    maxPages: number;
    deadlineMs: number;
  }>;
  retry?: Partial<{
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    timeoutMs: number;
  }>;
};

type Limits = {
  maxResults: number;
  pageSize: number;
  maxPages: number;
  deadlineMs: number;
};

type RetryConfiguration = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
};

type RequestResult =
  | {
      kind: "response";
      response: Response;
      bodyText: string;
      attemptHistory: OpenAlexAttempt[];
    }
  | {
      kind: "failure";
      failureCode:
        | "deadline_exceeded"
        | "invalid_response"
        | "rate_limited"
        | "provider_unavailable"
        | "request_rejected";
      attemptHistory: OpenAlexAttempt[];
      rateLimit: OpenAlexRateLimitSnapshot | null;
    };

const DOES_NOT_ESTABLISH = [
  "authority",
  "completeness",
  "entailment",
  "content_availability",
  "content_rights",
] as const;

class OpenAlexBodyLimitError extends Error {
  constructor() {
    super("OpenAlex response body exceeds its byte limit");
    this.name = "OpenAlexBodyLimitError";
  }
}

function abortError(): Error {
  return Object.assign(new Error("OpenAlex response body aborted"), {
    name: "AbortError",
  });
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortError();
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
  now: () => Date,
  deadlineAt: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new OpenAlexBodyLimitError();
  }

  if (response.body === null) {
    const text = await withAbort(response.text(), signal);
    if (now().getTime() >= deadlineAt) {
      throw abortError();
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new OpenAlexBodyLimitError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (now().getTime() >= deadlineAt) {
        throw abortError();
      }
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        throw new OpenAlexBodyLimitError();
      }
      chunks.push(chunk.value);
    }
    reader.releaseLock();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer ${minimum}-${maximum}`);
  }
  return value;
}

function readLimits(input: OpenAlexDiscoveryDependencies["limits"]): Limits {
  const maxResults = boundedInteger(
    input?.maxResults,
    20,
    1,
    100,
    "maxResults",
  );
  return {
    maxResults,
    pageSize: Math.min(
      maxResults,
      boundedInteger(input?.pageSize, 20, 1, 100, "pageSize"),
    ),
    maxPages: boundedInteger(input?.maxPages, 5, 1, 10, "maxPages"),
    deadlineMs: boundedInteger(
      input?.deadlineMs,
      15_000,
      100,
      60_000,
      "deadlineMs",
    ),
  };
}

function readRetry(
  input: OpenAlexDiscoveryDependencies["retry"],
): RetryConfiguration {
  const baseDelayMs = boundedInteger(
    input?.baseDelayMs,
    250,
    0,
    10_000,
    "baseDelayMs",
  );
  const maxDelayMs = boundedInteger(
    input?.maxDelayMs,
    2_000,
    0,
    30_000,
    "maxDelayMs",
  );
  if (maxDelayMs < baseDelayMs) {
    throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");
  }
  return {
    maxAttempts: boundedInteger(
      input?.maxAttempts,
      2,
      1,
      3,
      "maxAttempts",
    ),
    baseDelayMs,
    maxDelayMs,
    timeoutMs: boundedInteger(
      input?.timeoutMs,
      5_000,
      1,
      30_000,
      "timeoutMs",
    ),
  };
}

export function normalizeOpenAlexQuery(
  originalQuery: string,
): OpenAlexQueryNormalization {
  const normalizedQuery = originalQuery
    .normalize("NFC")
    .replace(/[?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalizedQuery.length === 0) {
    return {
      status: "invalid",
      originalQuery,
      normalizedQuery: null,
      reason: "empty",
    };
  }
  if (CONTROL_CHARACTERS.test(originalQuery)) {
    return {
      status: "invalid",
      originalQuery,
      normalizedQuery: null,
      reason: "control_character",
    };
  }
  if (
    [...normalizedQuery].length > MAX_QUERY_CODE_POINTS ||
    new TextEncoder().encode(normalizedQuery).byteLength > MAX_QUERY_BYTES ||
    new TextEncoder().encode(originalQuery).byteLength >
      MAX_ORIGINAL_QUERY_BYTES
  ) {
    return {
      status: "invalid",
      originalQuery,
      normalizedQuery: null,
      reason: "too_long",
    };
  }
  return {
    status: "valid",
    originalQuery,
    normalizedQuery,
  };
}

function responseOutcome(status: number): OpenAlexAttemptOutcome {
  if (status === 403 || status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  if (status >= 200 && status < 300) {
    return "success";
  }
  return "error";
}

function numericHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rateLimitSnapshot(headers: Headers): OpenAlexRateLimitSnapshot | null {
  const snapshot = {
    limit: numericHeader(headers, "x-ratelimit-limit"),
    remaining: numericHeader(headers, "x-ratelimit-remaining"),
    creditsUsed: numericHeader(headers, "x-ratelimit-credits-used"),
    resetSeconds: numericHeader(headers, "x-ratelimit-reset"),
  };
  return Object.values(snapshot).every((value) => value === null)
    ? null
    : snapshot;
}

function retryDelay(
  response: Response | null,
  attempt: number,
  configuration: RetryConfiguration,
  now: Date,
): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1_000), configuration.maxDelayMs);
    }
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.min(
        Math.max(0, retryAt - now.getTime()),
        configuration.maxDelayMs,
      );
    }
  }
  return Math.min(
    configuration.baseDelayMs * 2 ** Math.max(0, attempt - 1),
    configuration.maxDelayMs,
  );
}

function extractStableId(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  if (!match?.[1]) {
    throw new Error("invalid stable OpenAlex ID");
  }
  return match[1];
}

function projectLocation(
  location: z.infer<typeof locationSchema> | null,
): OpenAlexCandidate["openAccessSignal"]["bestLocation"] {
  if (location === null) {
    return null;
  }
  return {
    landingPageUrl: publicExternalUrl(location.landing_page_url),
    licenseSignal: location.license,
    version: location.version,
  };
}

function abstractText(index: Record<string, number[]> | null): string | null {
  if (index === null || Object.keys(index).length === 0) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text || null;
}

function projectCandidate(
  work: z.infer<typeof workSchema>,
): OpenAlexCandidate {
  const openAlexId = extractStableId(work.id, OPENALEX_WORK_ID);
  const canonicalDoi =
    work.doi === null ? null : normalizeDoi(work.doi).canonicalDoi;
  const source =
    work.primary_location?.source === null ||
    work.primary_location?.source === undefined
      ? null
      : {
          openAlexId: extractStableId(
            work.primary_location.source.id,
            OPENALEX_SOURCE_ID,
          ),
          displayName: work.primary_location.source.display_name,
        };

  return {
    openAlexId,
    openAlexUrl: `https://openalex.org/${openAlexId}`,
    title: work.title,
    authors: work.authorships.flatMap(({ author }) =>
      author.id && author.display_name
        ? [{
            openAlexId: extractStableId(author.id, OPENALEX_AUTHOR_ID),
            displayName: author.display_name,
          }]
        : [],
    ),
    publicationYear: work.publication_year,
    providerRelevanceScore: work.relevance_score ?? null,
    providerDoi: work.doi,
    canonicalDoi,
    source,
    abstractSignal: {
      providerReportedAvailable:
        work.abstract_inverted_index !== null &&
        Object.keys(work.abstract_inverted_index).length > 0,
      contentFetched: true,
      text: abstractText(work.abstract_inverted_index),
    },
    openAccessSignal: {
      isOpenAccess: work.open_access.is_oa,
      status: work.open_access.oa_status,
      repositoryFullTextReported:
        work.open_access.any_repository_has_fulltext ?? false,
      primaryLocation: projectLocation(work.primary_location),
      bestLocation: projectLocation(work.best_oa_location),
      rightsAssessment: "not_assessed",
    },
    citations: {
      count: work.cited_by_count,
      providerApiUrl: `${OPENALEX_API_ORIGIN}${OPENALEX_WORKS_PATH}?filter=${encodeURIComponent(`cites:${openAlexId}`)}`,
    },
  };
}

function emptyPagination(limits: Limits) {
  return {
    maxResults: limits.maxResults,
    pageSize: limits.pageSize,
    maxPages: limits.maxPages,
    pagesFetched: 0,
    providerResultCount: null as number | null,
    nextCursorAvailable: false,
    truncated: false,
    truncatedReason: null as
      | "max_results"
      | "max_pages"
      | "failure"
      | null,
  };
}

function snapshotId(
  originalQuery: string,
  normalizedQuery: string,
  candidates: OpenAlexCandidate[],
): string {
  return `oa-snapshot-${sha256(
    JSON.stringify({
      provider: "openalex",
      originalQuery,
      normalizedQuery,
      candidates,
    }),
  )}`;
}

export function createOpenAlexDiscoveryClient(
  dependencies: OpenAlexDiscoveryDependencies,
) {
  const configuration = snapshotPassiveValue(dependencies);
  const apiKey = typeof configuration.apiKey === "string"
    ? configuration.apiKey.trim()
    : "";
  const evidenceMode = configuration.evidenceMode;
  if (!(["fixture", "mocked", "live"] as const).includes(evidenceMode)) {
    throw new TypeError("retrieval configuration contains unsupported values");
  }
  const limits = readLimits(configuration.limits);
  const retry = readRetry(configuration.retry);
  const fetchRequest =
    validatedOptionalCallback(configuration.fetch) ??
    ((input: string, init?: RequestInit) => fetch(input, init));
  const now = validatedOptionalCallback(configuration.now) ?? (() => new Date());
  const sleep =
    validatedOptionalCallback(configuration.sleep) ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const log = validatedOptionalCallback(configuration.log);

  async function request(
    url: string,
    pageNumber: number,
    deadlineAt: number,
  ): Promise<RequestResult> {
    const attemptHistory: OpenAlexAttempt[] = [];

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const startedAt = now();
      const remainingAtStart = deadlineAt - startedAt.getTime();
      if (remainingAtStart <= 0) {
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          attemptHistory,
          rateLimit: null,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(retry.timeoutMs, remainingAtStart),
      );
      let response: Response | null = null;
      let bodyText: string | null = null;
      let exception: unknown = null;

      try {
        response = await fetchRequest(url, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/json",
          },
          signal: controller.signal,
        });
        if (response.ok) {
          bodyText = await readBoundedResponseBody(
            response,
            controller.signal,
            now,
            deadlineAt,
          );
        }
      } catch (error) {
        exception = error;
      } finally {
        clearTimeout(timer);
      }

      const endedAt = now();
      const deadlineExpired = endedAt.getTime() >= deadlineAt;
      const bodyLimitExceeded = exception instanceof OpenAlexBodyLimitError;
      const outcome =
        deadlineExpired
          ? "timeout"
          : bodyLimitExceeded
            ? "error"
            : exception !== null
              ? requestExceptionOutcome(exception, controller.signal.aborted)
              : response === null
                ? "network_error"
                : responseOutcome(response.status);
      const retryable =
        !deadlineExpired &&
        !bodyLimitExceeded &&
        (exception !== null ||
          response === null ||
          RETRYABLE_HTTP_STATUSES.has(response.status));
      const proposedDelay =
        attempt < retry.maxAttempts && retryable
          ? retryDelay(response, attempt, retry, endedAt)
          : null;
      const canRetry =
        proposedDelay !== null &&
        endedAt.getTime() + proposedDelay < deadlineAt;
      const attemptRecord: OpenAlexAttempt = {
        attempt,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        outcome,
        httpStatus: response?.status ?? null,
        retryDelayMs: canRetry ? proposedDelay : null,
      };
      attemptHistory.push(attemptRecord);
      emitOptionalTelemetry(log, {
        service: "openalex",
        operation: "search_works",
        evidenceMode,
        pageNumber,
        attempt,
        outcome,
        httpStatus: response?.status ?? null,
        retryScheduled: canRetry,
      });

      if (canRetry && proposedDelay !== null) {
        if (!(await completeBackoff(sleep, proposedDelay))) {
          return {
            kind: "failure",
            failureCode: "provider_unavailable",
            attemptHistory,
            rateLimit:
              response === null ? null : rateLimitSnapshot(response.headers),
          };
        }
        continue;
      }

      if (deadlineExpired) {
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          attemptHistory,
          rateLimit:
            response === null ? null : rateLimitSnapshot(response.headers),
        };
      }

      if (bodyLimitExceeded) {
        return {
          kind: "failure",
          failureCode: "invalid_response",
          attemptHistory,
          rateLimit:
            response === null ? null : rateLimitSnapshot(response.headers),
        };
      }

      if (exception !== null) {
        return {
          kind: "failure",
          failureCode: "provider_unavailable",
          attemptHistory,
          rateLimit:
            response === null ? null : rateLimitSnapshot(response.headers),
        };
      }

      if (response !== null) {
        if (response.ok) {
          if (bodyText === null) {
            throw new Error("successful OpenAlex response has no body text");
          }
          return {
            kind: "response",
            response,
            bodyText,
            attemptHistory,
          };
        }
        return {
          kind: "failure",
          failureCode:
            response.status === 403 || response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "provider_unavailable"
                : "request_rejected",
          attemptHistory,
          rateLimit: rateLimitSnapshot(response.headers),
        };
      }

      return {
        kind: "failure",
        failureCode:
          endedAt.getTime() >= deadlineAt
            ? "deadline_exceeded"
            : "provider_unavailable",
        attemptHistory,
        rateLimit: null,
      };
    }

    throw new Error("bounded OpenAlex request loop exhausted unexpectedly");
  }

  async function discover(
    originalQuery: string,
  ): Promise<OpenAlexDiscoveryResult> {
    const started = now();
    const normalization = normalizeOpenAlexQuery(originalQuery);
    const pagination = emptyPagination(limits);
    const common = {
      evidenceMode,
      provider: "openalex" as const,
      originalQuery,
      startedAt: started.toISOString(),
      pageHistory: [] as OpenAlexPageHistory[],
      selectionRequired: true as const,
      doesNotEstablish: DOES_NOT_ESTABLISH,
    };

    if (normalization.status === "invalid") {
      return {
        ...common,
        status: "invalid_request",
        failureCode: "invalid_query",
        normalizedQuery: null,
        completedAt: now().toISOString(),
        snapshotId: null,
        candidates: [],
        pagination,
        providerUsage: {
          reportedCostUsd: 0,
          rateLimit: null,
        },
      };
    }

    const candidates: OpenAlexCandidate[] = [];
    const normalizedQuery = normalization.normalizedQuery;
    const candidateIds = new Set<string>();
    const seenCursors = new Set<string>(["*"]);
    let cursor = "*";
    let reportedCostUsd = 0;
    let lastRateLimit: OpenAlexRateLimitSnapshot | null = null;
    let providerResultCount: number | null = null;
    let nextCursorAvailable = false;
    let successfulPages = 0;
    const deadlineAt = started.getTime() + limits.deadlineMs;

    function finish(
      status: OpenAlexDiscoveryResult["status"],
      failureCode: OpenAlexDiscoveryFailureCode | null,
      truncatedReason: OpenAlexDiscoveryResult["pagination"]["truncatedReason"],
    ): OpenAlexDiscoveryResult {
      const isTruncated = truncatedReason !== null;
      return {
        ...common,
        status,
        failureCode,
        normalizedQuery,
        completedAt: now().toISOString(),
        snapshotId:
          status !== "completed" && candidates.length === 0
            ? null
            : snapshotId(
                originalQuery,
                normalizedQuery,
                candidates,
              ),
        candidates,
        pagination: {
          ...pagination,
          pagesFetched: successfulPages,
          providerResultCount,
          nextCursorAvailable,
          truncated: isTruncated,
          truncatedReason,
        },
        providerUsage: {
          reportedCostUsd,
          rateLimit: lastRateLimit,
        },
      };
    }

    for (let pageNumber = 1; pageNumber <= limits.maxPages; pageNumber += 1) {
      const url = new URL(OPENALEX_WORKS_PATH, OPENALEX_API_ORIGIN);
      if (apiKey) url.searchParams.set("api_key", apiKey);
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("per_page", String(limits.pageSize));
      url.searchParams.set("search", normalizedQuery);
      url.searchParams.set("select", SELECT_FIELDS);

      const requested = await request(url.toString(), pageNumber, deadlineAt);
      if (requested.kind === "failure") {
        common.pageHistory.push({
          pageNumber,
          cursorHash: sha256(cursor),
          resultsReceived: 0,
          providerReportedCostUsd: null,
          rateLimit: requested.rateLimit,
          attemptHistory: requested.attemptHistory,
        });
        lastRateLimit = requested.rateLimit ?? lastRateLimit;
        const status = candidates.length === 0 ? "failed" : "partial";
        return finish(status, requested.failureCode, "failure");
      }

      lastRateLimit =
        rateLimitSnapshot(requested.response.headers) ?? lastRateLimit;
      let parsed: z.infer<typeof responseSchema>;
      try {
        if (now().getTime() >= deadlineAt) {
          throw abortError();
        }
        parsed = responseSchema.parse(JSON.parse(requested.bodyText));
        if (now().getTime() >= deadlineAt) {
          throw abortError();
        }
      } catch (error) {
        common.pageHistory.push({
          pageNumber,
          cursorHash: sha256(cursor),
          resultsReceived: 0,
          providerReportedCostUsd: null,
          rateLimit: lastRateLimit,
          attemptHistory: requested.attemptHistory,
        });
        return finish(
          candidates.length === 0 ? "failed" : "partial",
          requestExceptionOutcome(error) === "timeout"
            ? "deadline_exceeded"
            : "invalid_response",
          "failure",
        );
      }

      providerResultCount = Math.max(
        providerResultCount ?? 0,
        parsed.meta.count,
      );
      const pageCost = parsed.meta.cost_usd ?? null;
      if (pageCost !== null) {
        reportedCostUsd += pageCost;
      }

      let projected: OpenAlexCandidate[];
      try {
        projected = parsed.results.map(projectCandidate);
        for (const candidate of projected) {
          if (candidateIds.has(candidate.openAlexId)) {
            throw new Error("duplicate stable OpenAlex ID");
          }
          candidateIds.add(candidate.openAlexId);
        }
        if (now().getTime() >= deadlineAt) {
          throw abortError();
        }
      } catch (error) {
        common.pageHistory.push({
          pageNumber,
          cursorHash: sha256(cursor),
          resultsReceived: 0,
          providerReportedCostUsd: pageCost,
          rateLimit: lastRateLimit,
          attemptHistory: requested.attemptHistory,
        });
        return finish(
          candidates.length === 0 ? "failed" : "partial",
          requestExceptionOutcome(error) === "timeout"
            ? "deadline_exceeded"
            : "invalid_response",
          "failure",
        );
      }

      const remaining = limits.maxResults - candidates.length;
      candidates.push(...projected.slice(0, remaining));
      const nextCursor = parsed.meta.next_cursor ?? null;
      nextCursorAvailable = nextCursor !== null;
      common.pageHistory.push({
        pageNumber,
        cursorHash: sha256(cursor),
        resultsReceived: parsed.results.length,
        providerReportedCostUsd: pageCost,
        rateLimit: lastRateLimit,
        attemptHistory: requested.attemptHistory,
      });
      successfulPages += 1;

      if (candidates.length >= limits.maxResults) {
        return finish(
          "completed",
          null,
          nextCursorAvailable || (providerResultCount ?? 0) > candidates.length
            ? "max_results"
            : null,
        );
      }
      if (nextCursor === null) {
        return finish("completed", null, null);
      }
      if (lastRateLimit?.remaining === 0) {
        return finish("partial", "rate_limited", "failure");
      }
      if (seenCursors.has(nextCursor)) {
        return finish("partial", "cursor_loop", "failure");
      }
      if (pageNumber >= limits.maxPages) {
        return finish("completed", null, "max_pages");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return finish("completed", null, nextCursorAvailable ? "max_pages" : null);
  }

  return {
    discover,
  };
}

export type OpenAlexSelectionDecision = {
  openAlexId: string;
  decision: "selected" | "rejected";
  decidedAt: string;
  reason?: string;
};

export type OpenAlexSelectionAudit = {
  auditId: string;
  selectionAuthority: "human";
  discoverySnapshotId: string;
  discoveryStatus: OpenAlexDiscoveryResult["status"];
  discoveryFailureCode: OpenAlexDiscoveryFailureCode | null;
  discoveryTruncated: boolean;
  originalQuery: string;
  normalizedQuery: string;
  candidateOpenAlexIds: string[];
  selectedOpenAlexIds: string[];
  rejectedOpenAlexIds: string[];
  decisions: {
    openAlexId: string;
    decision: "selected" | "rejected";
    decidedAt: string;
    reason: string | null;
  }[];
};

export type OpenAlexSelectionErrorCode =
  | "snapshot_unavailable"
  | "snapshot_mismatch"
  | "duplicate_candidate"
  | "unknown_candidate"
  | "missing_decision"
  | "invalid_decision";

export class OpenAlexSelectionError extends Error {
  readonly code: OpenAlexSelectionErrorCode;

  constructor(code: OpenAlexSelectionErrorCode, message: string) {
    super(message);
    this.name = "OpenAlexSelectionError";
    this.code = code;
  }
}

export function createOpenAlexSelectionAudit(
  discovery: OpenAlexDiscoveryResult,
  decisions: readonly OpenAlexSelectionDecision[],
): OpenAlexSelectionAudit {
  if (discovery.snapshotId === null || discovery.normalizedQuery === null) {
    throw new OpenAlexSelectionError(
      "snapshot_unavailable",
      "a candidate snapshot is required before selection",
    );
  }
  if (
    discovery.snapshotId !==
    snapshotId(
      discovery.originalQuery,
      discovery.normalizedQuery,
      discovery.candidates,
    )
  ) {
    throw new OpenAlexSelectionError(
      "snapshot_mismatch",
      "candidate snapshot no longer matches its preserved identifier",
    );
  }

  const candidateIds = discovery.candidates.map(
    (candidate) => candidate.openAlexId,
  );
  const candidateSet = new Set(candidateIds);
  const byCandidate = new Map<string, OpenAlexSelectionDecision>();

  for (const decision of decisions) {
    if (byCandidate.has(decision.openAlexId)) {
      throw new OpenAlexSelectionError(
        "duplicate_candidate",
        "each candidate must have exactly one decision",
      );
    }
    if (!candidateSet.has(decision.openAlexId)) {
      throw new OpenAlexSelectionError(
        "unknown_candidate",
        "selection refers to a candidate outside the preserved snapshot",
      );
    }
    if (
      (decision.decision !== "selected" &&
        decision.decision !== "rejected") ||
      !Number.isFinite(Date.parse(decision.decidedAt)) ||
      (decision.reason !== undefined &&
        (decision.reason.trim().length === 0 ||
          decision.reason.length > 1_000))
    ) {
      throw new OpenAlexSelectionError(
        "invalid_decision",
        "selection decision is malformed",
      );
    }
    byCandidate.set(decision.openAlexId, decision);
  }

  const missing = candidateIds.find((candidateId) => !byCandidate.has(candidateId));
  if (missing !== undefined) {
    throw new OpenAlexSelectionError(
      "missing_decision",
      "every preserved candidate requires an explicit selected or rejected decision",
    );
  }

  const normalizedDecisions = candidateIds.map((openAlexId) => {
    const decision = byCandidate.get(openAlexId);
    if (!decision) {
      throw new OpenAlexSelectionError(
        "missing_decision",
        "every preserved candidate requires a decision",
      );
    }
    return {
      openAlexId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      reason: decision.reason?.trim() ?? null,
    };
  });
  const selectedOpenAlexIds = normalizedDecisions
    .filter(({ decision }) => decision === "selected")
    .map(({ openAlexId }) => openAlexId);
  const rejectedOpenAlexIds = normalizedDecisions
    .filter(({ decision }) => decision === "rejected")
    .map(({ openAlexId }) => openAlexId);
  const auditMaterial = {
    selectionAuthority: "human" as const,
    discoverySnapshotId: discovery.snapshotId,
    discoveryStatus: discovery.status,
    discoveryFailureCode: discovery.failureCode,
    discoveryTruncated: discovery.pagination.truncated,
    originalQuery: discovery.originalQuery,
    normalizedQuery: discovery.normalizedQuery,
    candidateOpenAlexIds: candidateIds,
    selectedOpenAlexIds,
    rejectedOpenAlexIds,
    decisions: normalizedDecisions,
  };

  return {
    auditId: `oa-selection-${sha256(JSON.stringify(auditMaterial))}`,
    ...auditMaterial,
  };
}
