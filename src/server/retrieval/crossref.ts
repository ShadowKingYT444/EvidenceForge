import { normalizeDoi, type RegistrationAgencyResult } from "./doi";
import {
  completeBackoff,
  emitOptionalTelemetry,
  requestExceptionOutcome,
  safeRateLimitInterval,
  snapshotPassiveValue,
  validatedOptionalCallback,
} from "./privacy";

const CROSSREF_API_ORIGIN = "https://api.crossref.org";
const CROSSREF_API_VERSION = "v1";
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RESPONSE_BYTES = 1_000_000;
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const CHECKED_RELATION_FIELDS = [
  "message.update-to",
  "message.relation.update-to",
  "message.relation.updated-by",
] as const;
const YEAR_PRECEDENCE = [
  "published-print",
  "published-online",
  "published",
  "issued",
] as const;
const DOES_NOT_ESTABLISH = [
  "authority",
  "completeness",
  "entailment",
  "content_rights",
  "integrity_clearance",
] as const;
const TYPOGRAPHIC_EQUIVALENTS = new Map<string, string>([
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201A", "'"],
  ["\u201C", "\""],
  ["\u201D", "\""],
  ["\u201E", "\""],
  ["\u2026", "..."],
]);

type CrossrefPermitWaiter = {
  deadlineAt: number;
  now: () => Date;
  resolve: (release: (() => void) | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let crossrefTransportActive = false;
const crossrefPermitWaiters: CrossrefPermitWaiter[] = [];

function releaseCrossrefPermit() {
  while (crossrefPermitWaiters.length > 0) {
    const waiter = crossrefPermitWaiters.shift();
    if (waiter === undefined) {
      break;
    }
    clearTimeout(waiter.timer);
    if (waiter.now().getTime() >= waiter.deadlineAt) {
      waiter.resolve(null);
      continue;
    }
    waiter.resolve(singleUseRelease());
    return;
  }
  crossrefTransportActive = false;
}

function singleUseRelease(): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseCrossrefPermit();
  };
}

function acquireCrossrefPermit(
  deadlineAt: number,
  now: () => Date,
): Promise<(() => void) | null> {
  const remainingMs = deadlineAt - now().getTime();
  if (remainingMs <= 0) {
    return Promise.resolve(null);
  }
  if (!crossrefTransportActive) {
    crossrefTransportActive = true;
    return Promise.resolve(singleUseRelease());
  }
  return new Promise((resolve) => {
    const waiter: CrossrefPermitWaiter = {
      deadlineAt,
      now,
      resolve,
      timer: setTimeout(() => {
        const index = crossrefPermitWaiters.indexOf(waiter);
        if (index >= 0) {
          crossrefPermitWaiters.splice(index, 1);
        }
        resolve(null);
      }, remainingMs),
    };
    crossrefPermitWaiters.push(waiter);
  });
}

export type CrossrefEvidenceMode = "fixture" | "mocked" | "live";
export type CrossrefVerificationStatus =
  | "verified"
  | "partial"
  | "mismatch"
  | "record_not_found"
  | "unsupported_agency"
  | "provider_unavailable"
  | "rate_limited"
  | "error"
  | "not_applicable";
export type CrossrefFailureCode =
  | "invalid_doi"
  | "registration_agency_not_identified"
  | "unsupported_agency"
  | "not_found"
  | "deadline_exceeded"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "request_rejected"
  | "invalid_response"
  | null;
export type CrossrefAttemptOutcome =
  | "success"
  | "not_found"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "network_error"
  | "error";
export type CrossrefAttempt = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  outcome: CrossrefAttemptOutcome;
  httpStatus: number | null;
  retryDelayMs: number | null;
};
export type CrossrefLogEvent = {
  service: "crossref";
  operation: "verify_metadata";
  evidenceMode: CrossrefEvidenceMode;
  attempt: number;
  outcome: CrossrefAttemptOutcome;
  httpStatus: number | null;
  retryScheduled: boolean;
};
export type CrossrefRateLimitSnapshot = {
  limit: number | null;
  interval: string | null;
  concurrencyLimit: number | null;
};
export type CrossrefFieldDiff = {
  field: "doi" | "title" | "authors" | "year";
  status: "match" | "mismatch" | "not_supplied" | "provider_missing";
  supplied: string | string[] | number | null;
  provider: string | string[] | number | null;
  reason:
    | "canonical_doi_equal"
    | "canonical_doi_differs"
    | "normalized_title_equal"
    | "normalized_title_differs"
    | "ordered_normalized_authors_equal"
    | "author_order_differs"
    | "author_names_differ"
    | "publication_year_equal"
    | "publication_year_differs"
    | "not_supplied"
    | "provider_missing";
  providerSource?: (typeof YEAR_PRECEDENCE)[number] | null;
};
export type CrossrefIntegrityRelation = {
  direction: "update-to" | "updated-by";
  identifier: string;
  canonicalIdentifier: string | null;
  identifierType: string | null;
  updateType: string | null;
  assertedBy: string | null;
  source: string | null;
  label: string | null;
  updatedAt: string | null;
  location: string;
};
export type CrossrefRelationIssue = {
  code:
    | "duplicate_relation"
    | "conflicting_relation"
    | "malformed_relation";
  location: string;
  detail:
    | "relation container must be an array"
    | "relation entry must be an object"
    | "relation identifier must be a non-empty string"
    | "relation identifier type must be a string"
    | "duplicate relation evidence preserved"
    | "conflicting relation evidence preserved";
};
export type CrossrefIntegrityNotice =
  | {
      status: "not_checked";
      summary: "Crossref relation fields were not checked";
      checkedFields: [];
      relations: [];
      issues: [];
    }
  | {
      status:
        | "notice_relations_found"
        | "notice_relations_found_with_issues"
        | "no_notice_found_in_checked_sources"
        | "relation_check_incomplete";
      summary:
        | "notice relation evidence found in checked Crossref fields"
        | "no notice found in checked sources"
        | "relation evidence could not be fully inspected";
      checkedFields: readonly (typeof CHECKED_RELATION_FIELDS)[number][];
      relations: CrossrefIntegrityRelation[];
      issues: CrossrefRelationIssue[];
    };
export type CrossrefVerificationRequest = {
  doi: string;
  registrationAgency: RegistrationAgencyResult;
  supplied?: {
    title?: string | null;
    authors?: string[] | null;
    year?: number | null;
  };
};
export type CrossrefVerificationResult = {
  status: CrossrefVerificationStatus;
  failureCode: CrossrefFailureCode;
  provider: "crossref";
  evidenceMode: CrossrefEvidenceMode;
  canonicalDoi: string | null;
  checkedAt: string | null;
  source: {
    apiVersion: typeof CROSSREF_API_VERSION;
    recordUrl: string | null;
    access: "fixture_transport" | "mocked_transport" | "live_transport";
    fromCache: boolean;
    requestCoalesced: boolean;
  };
  cache: {
    key: string | null;
    status:
      | "not_applicable"
      | "miss"
      | "hit"
      | "expired"
      | "coalesced";
    expiresAt: string | null;
  };
  comparison: {
    rubricVersion: "crossref-v0";
    fields: CrossrefFieldDiff[];
    providerYearCandidates: {
      source: (typeof YEAR_PRECEDENCE)[number];
      year: number;
    }[];
  };
  integrityNotice: CrossrefIntegrityNotice;
  attempts: number;
  attemptHistory: CrossrefAttempt[];
  rateLimit: CrossrefRateLimitSnapshot | null;
  doesNotEstablish: readonly (typeof DOES_NOT_ESTABLISH)[number][];
};
export type CrossrefMetadataVerifierDependencies = {
  evidenceMode: CrossrefEvidenceMode;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (event: CrossrefLogEvent) => void;
  mailto?: string;
  plusApiToken?: string;
  userAgent?: string;
  limits?: Partial<{
    deadlineMs: number;
    responseBytes: number;
  }>;
  retry?: Partial<{
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    timeoutMs: number;
  }>;
  cache?: Partial<{
    ttlMs: number;
    maxEntries: number;
  }>;
};

type CrossrefMessage = Record<string, unknown>;
type RetryConfiguration = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
};
type Limits = {
  deadlineMs: number;
  responseBytes: number;
};
type CacheConfiguration = {
  ttlMs: number;
  maxEntries: number;
};
type ProviderSnapshot = {
  message: CrossrefMessage;
  checkedAt: string;
  rateLimit: CrossrefRateLimitSnapshot | null;
};
type CacheEntry = ProviderSnapshot & {
  expiresAtMs: number;
};
type ProviderLoadResult =
  | {
      kind: "success";
      snapshot: ProviderSnapshot;
      attemptHistory: CrossrefAttempt[];
      expiresAt: string;
    }
  | {
      kind: "failure";
      failureCode: Exclude<
        CrossrefFailureCode,
        | "invalid_doi"
        | "registration_agency_not_identified"
        | "unsupported_agency"
        | null
      >;
      checkedAt: string;
      attemptHistory: CrossrefAttempt[];
      rateLimit: CrossrefRateLimitSnapshot | null;
    };
type RequestResult =
  | {
      kind: "response";
      response: Response;
      bodyText: string;
      checkedAt: string;
      attemptHistory: CrossrefAttempt[];
      rateLimit: CrossrefRateLimitSnapshot | null;
    }
  | {
      kind: "failure";
      failureCode: Exclude<
        CrossrefFailureCode,
        "invalid_doi" | "registration_agency_not_identified" | "unsupported_agency" | null
      >;
      checkedAt: string;
      attemptHistory: CrossrefAttempt[];
      rateLimit: CrossrefRateLimitSnapshot | null;
    };

class CrossrefBodyLimitError extends Error {
  constructor() {
    super("Crossref response body exceeds its byte limit");
    this.name = "CrossrefBodyLimitError";
  }
}

function abortError(): Error {
  return Object.assign(new Error("Crossref response body aborted"), {
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

async function settleWithinDeadline(
  operation: Promise<unknown>,
  deadlineAt: number,
  now: () => Date,
): Promise<boolean> {
  const remainingMs = deadlineAt - now().getTime();
  if (remainingMs <= 0) {
    void operation.catch(() => undefined);
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), remainingMs);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

async function cancelWithinDeadline(
  cancel: () => Promise<void>,
  deadlineAt: number,
  now: () => Date,
): Promise<void> {
  let cancellation: Promise<void>;
  try {
    cancellation = cancel();
  } catch {
    return;
  }
  if (!(await settleWithinDeadline(cancellation, deadlineAt, now))) {
    throw abortError();
  }
}

async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
  now: () => Date,
  deadlineAt: number,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    if (response.body !== null) {
      await cancelWithinDeadline(
        () => response.body!.cancel(),
        deadlineAt,
        now,
      );
    }
    throw new CrossrefBodyLimitError();
  }

  if (response.body === null) {
    const text = await withAbort(response.text(), signal);
    if (now().getTime() >= deadlineAt) {
      throw abortError();
    }
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new CrossrefBodyLimitError();
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
      if (bytesRead > maximumBytes) {
        throw new CrossrefBodyLimitError();
      }
      chunks.push(chunk.value);
    }
    reader.releaseLock();
  } catch (error) {
    await cancelWithinDeadline(() => reader.cancel(), deadlineAt, now);
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

function readRetry(
  input: CrossrefMetadataVerifierDependencies["retry"],
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

function readLimits(
  input: CrossrefMetadataVerifierDependencies["limits"],
): Limits {
  return {
    deadlineMs: boundedInteger(
      input?.deadlineMs,
      15_000,
      100,
      60_000,
      "deadlineMs",
    ),
    responseBytes: boundedInteger(
      input?.responseBytes,
      DEFAULT_RESPONSE_BYTES,
      1_000,
      5_000_000,
      "responseBytes",
    ),
  };
}

function readCache(
  input: CrossrefMetadataVerifierDependencies["cache"],
): CacheConfiguration {
  return {
    ttlMs: boundedInteger(
      input?.ttlMs,
      300_000,
      1,
      86_400_000,
      "ttlMs",
    ),
    maxEntries: boundedInteger(
      input?.maxEntries,
      100,
      1,
      1_000,
      "maxEntries",
    ),
  };
}

function validateOptionalSecret(
  value: string | undefined,
  name: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maximumLength ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return trimmed;
}

function responseOutcome(status: number): CrossrefAttemptOutcome {
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
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

function rateLimitSnapshot(
  headers: Headers,
): CrossrefRateLimitSnapshot | null {
  const interval = safeRateLimitInterval(
    headers.get("x-rate-limit-interval"),
  );
  const snapshot = {
    limit: numericHeader(headers, "x-rate-limit-limit"),
    interval,
    concurrencyLimit: numericHeader(headers, "x-concurrency-limit"),
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

function accessLabel(
  evidenceMode: CrossrefEvidenceMode,
): CrossrefVerificationResult["source"]["access"] {
  return `${evidenceMode}_transport`;
}

function recordUrl(canonicalDoi: string): string {
  return `${CROSSREF_API_ORIGIN}/${CROSSREF_API_VERSION}/works/${encodeURIComponent(canonicalDoi)}`;
}

function notCheckedIntegrity(): CrossrefIntegrityNotice {
  return {
    status: "not_checked",
    summary: "Crossref relation fields were not checked",
    checkedFields: [],
    relations: [],
    issues: [],
  };
}

function emptyResult(
  evidenceMode: CrossrefEvidenceMode,
  input: {
    status: CrossrefVerificationStatus;
    failureCode: CrossrefFailureCode;
    canonicalDoi: string | null;
    checkedAt?: string | null;
    url?: string | null;
    cacheKey?: string | null;
    cacheStatus?: CrossrefVerificationResult["cache"]["status"];
    requestCoalesced?: boolean;
    attemptHistory?: CrossrefAttempt[];
    rateLimit?: CrossrefRateLimitSnapshot | null;
  },
): CrossrefVerificationResult {
  const attemptHistory = input.attemptHistory ?? [];
  return {
    status: input.status,
    failureCode: input.failureCode,
    provider: "crossref",
    evidenceMode,
    canonicalDoi: input.canonicalDoi,
    checkedAt: input.checkedAt ?? null,
    source: {
      apiVersion: CROSSREF_API_VERSION,
      recordUrl: input.url ?? null,
      access: accessLabel(evidenceMode),
      fromCache: false,
      requestCoalesced: input.requestCoalesced ?? false,
    },
    cache: {
      key: input.cacheKey ?? null,
      status: input.cacheStatus ?? "not_applicable",
      expiresAt: null,
    },
    comparison: {
      rubricVersion: "crossref-v0",
      fields: [],
      providerYearCandidates: [],
    },
    integrityNotice: notCheckedIntegrity(),
    attempts: attemptHistory.length,
    attemptHistory: attemptHistory.map((attempt) => ({ ...attempt })),
    rateLimit:
      input.rateLimit === null || input.rateLimit === undefined
        ? null
        : { ...input.rateLimit },
    doesNotEstablish: [...DOES_NOT_ESTABLISH],
  };
}

function objectRecord(value: unknown): CrossrefMessage | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as CrossrefMessage)
    : null;
}

function parseEnvelope(bodyText: string): CrossrefMessage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const envelope = objectRecord(payload);
  if (
    envelope === null ||
    envelope.status !== "ok" ||
    envelope["message-type"] !== "work" ||
    typeof envelope["message-version"] !== "string"
  ) {
    return null;
  }
  return objectRecord(envelope.message);
}

function normalizedText(value: string): string {
  return [...value.normalize("NFC").toLocaleLowerCase("en-US")]
    .map((character) => TYPOGRAPHIC_EQUIVALENTS.get(character) ?? character)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeSuppliedAuthor(value: string): string {
  const [family, given, ...rest] = value.split(",");
  if (
    family !== undefined &&
    given !== undefined &&
    rest.length === 0 &&
    family.trim() !== "" &&
    given.trim() !== ""
  ) {
    return normalizedText(`${given} ${family}`);
  }
  return normalizedText(value);
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") {
      return item;
    }
  }
  return null;
}

function providerAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const authors: string[] = [];
  for (const item of value) {
    const author = objectRecord(item);
    if (author === null) {
      continue;
    }
    if (typeof author.name === "string" && author.name.trim() !== "") {
      authors.push(normalizedText(author.name));
      continue;
    }
    const given = typeof author.given === "string" ? author.given : "";
    const family = typeof author.family === "string" ? author.family : "";
    const normalized = normalizedText(`${given} ${family}`);
    if (normalized !== "") {
      authors.push(normalized);
    }
  }
  return authors;
}

function extractYear(value: unknown): number | null {
  const date = objectRecord(value);
  const parts = date?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) {
    return null;
  }
  const year = parts[0][0];
  return Number.isInteger(year) && year >= 1000 && year <= 9999
    ? year
    : null;
}

function compareMetadata(
  targetDoi: string,
  message: CrossrefMessage,
  supplied: CrossrefVerificationRequest["supplied"],
): CrossrefVerificationResult["comparison"] {
  const fields: CrossrefFieldDiff[] = [];
  const providerDoiInput =
    typeof message.DOI === "string" ? message.DOI : null;
  const providerDoi =
    providerDoiInput === null
      ? null
      : normalizeDoi(providerDoiInput).canonicalDoi;
  fields.push(
    providerDoi === null
      ? {
          field: "doi",
          status: "provider_missing",
          supplied: targetDoi,
          provider: null,
          reason: "provider_missing",
        }
      : providerDoi === targetDoi
        ? {
            field: "doi",
            status: "match",
            supplied: targetDoi,
            provider: providerDoi,
            reason: "canonical_doi_equal",
          }
        : {
            field: "doi",
            status: "mismatch",
            supplied: targetDoi,
            provider: providerDoi,
            reason: "canonical_doi_differs",
          },
  );

  const providerTitleInput = firstString(message.title);
  const providerTitle =
    providerTitleInput === null ? null : normalizedText(providerTitleInput);
  const suppliedTitleInput = supplied?.title?.trim() || null;
  const suppliedTitle =
    suppliedTitleInput === null ? null : normalizedText(suppliedTitleInput);
  fields.push(
    suppliedTitle === null
      ? {
          field: "title",
          status: "not_supplied",
          supplied: null,
          provider: providerTitle,
          reason: "not_supplied",
        }
      : providerTitle === null || providerTitle === ""
        ? {
            field: "title",
            status: "provider_missing",
            supplied: suppliedTitle,
            provider: null,
            reason: "provider_missing",
          }
        : suppliedTitle === providerTitle
          ? {
              field: "title",
              status: "match",
              supplied: suppliedTitle,
              provider: providerTitle,
              reason: "normalized_title_equal",
            }
          : {
              field: "title",
              status: "mismatch",
              supplied: suppliedTitle,
              provider: providerTitle,
              reason: "normalized_title_differs",
            },
  );

  const suppliedAuthors =
    supplied?.authors === null || supplied?.authors === undefined
      ? null
      : supplied.authors.map(normalizeSuppliedAuthor).filter(Boolean);
  const providerAuthorList = providerAuthors(message.author);
  let authorDiff: CrossrefFieldDiff;
  if (suppliedAuthors === null || suppliedAuthors.length === 0) {
    authorDiff = {
      field: "authors",
      status: "not_supplied",
      supplied: null,
      provider: providerAuthorList,
      reason: "not_supplied",
    };
  } else if (providerAuthorList.length === 0) {
    authorDiff = {
      field: "authors",
      status: "provider_missing",
      supplied: suppliedAuthors,
      provider: null,
      reason: "provider_missing",
    };
  } else if (
    JSON.stringify(suppliedAuthors) === JSON.stringify(providerAuthorList)
  ) {
    authorDiff = {
      field: "authors",
      status: "match",
      supplied: suppliedAuthors,
      provider: providerAuthorList,
      reason: "ordered_normalized_authors_equal",
    };
  } else {
    const sameNames =
      suppliedAuthors.length === providerAuthorList.length &&
      JSON.stringify([...suppliedAuthors].sort()) ===
        JSON.stringify([...providerAuthorList].sort());
    authorDiff = {
      field: "authors",
      status: "mismatch",
      supplied: suppliedAuthors,
      provider: providerAuthorList,
      reason: sameNames ? "author_order_differs" : "author_names_differ",
    };
  }
  fields.push(authorDiff);

  const providerYearCandidates = YEAR_PRECEDENCE.flatMap((source) => {
    const year = extractYear(message[source]);
    return year === null ? [] : [{ source, year }];
  });
  const chosenYear = providerYearCandidates[0] ?? null;
  const suppliedYear =
    Number.isInteger(supplied?.year) &&
    (supplied?.year ?? 0) >= 1000 &&
    (supplied?.year ?? 0) <= 9999
      ? (supplied?.year ?? null)
      : null;
  fields.push(
    suppliedYear === null
      ? {
          field: "year",
          status: "not_supplied",
          supplied: null,
          provider: chosenYear?.year ?? null,
          reason: "not_supplied",
          providerSource: chosenYear?.source ?? null,
        }
      : chosenYear === null
        ? {
            field: "year",
            status: "provider_missing",
            supplied: suppliedYear,
            provider: null,
            reason: "provider_missing",
            providerSource: null,
          }
        : suppliedYear === chosenYear.year
          ? {
              field: "year",
              status: "match",
              supplied: suppliedYear,
              provider: chosenYear.year,
              reason: "publication_year_equal",
              providerSource: chosenYear.source,
            }
          : {
              field: "year",
              status: "mismatch",
              supplied: suppliedYear,
              provider: chosenYear.year,
              reason: "publication_year_differs",
              providerSource: chosenYear.source,
            },
  );

  return {
    rubricVersion: "crossref-v0",
    fields,
    providerYearCandidates,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : null;
}

function updatedAt(value: unknown): string | null {
  const updated = objectRecord(value);
  return nullableString(updated?.["date-time"]);
}

function relationSignature(relation: CrossrefIntegrityRelation): string {
  return JSON.stringify([
    relation.direction,
    relation.canonicalIdentifier ?? relation.identifier,
    relation.identifierType,
    relation.updateType,
    relation.assertedBy,
    relation.source,
    relation.label,
    relation.updatedAt,
  ]);
}

function relationIdentity(relation: CrossrefIntegrityRelation): string {
  return JSON.stringify([
    relation.direction,
    relation.canonicalIdentifier ?? relation.identifier,
  ]);
}

function inspectRelations(message: CrossrefMessage): CrossrefIntegrityNotice {
  const relations: CrossrefIntegrityRelation[] = [];
  const issues: CrossrefRelationIssue[] = [];

  function readRelationArray(
    value: unknown,
    fieldLocation: string,
    direction: CrossrefIntegrityRelation["direction"],
    shape: "update" | "relation",
  ) {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value)) {
      issues.push({
        code: "malformed_relation",
        location: fieldLocation,
        detail: "relation container must be an array",
      });
      return;
    }
    value.forEach((item, index) => {
      const location = `${fieldLocation}[${index}]`;
      const entry = objectRecord(item);
      if (entry === null) {
        issues.push({
          code: "malformed_relation",
          location,
          detail: "relation entry must be an object",
        });
        return;
      }
      const identifierValue = shape === "update" ? entry.DOI : entry.id;
      if (
        typeof identifierValue !== "string" ||
        identifierValue.trim() === ""
      ) {
        issues.push({
          code: "malformed_relation",
          location,
          detail: "relation identifier must be a non-empty string",
        });
        return;
      }
      const identifierTypeValue =
        shape === "update" ? "doi" : entry["id-type"];
      if (
        identifierTypeValue !== undefined &&
        typeof identifierTypeValue !== "string"
      ) {
        issues.push({
          code: "malformed_relation",
          location,
          detail: "relation identifier type must be a string",
        });
        return;
      }
      const identifier = identifierValue.trim();
      const identifierType =
        typeof identifierTypeValue === "string"
          ? identifierTypeValue
          : null;
      const canonicalIdentifier =
        identifierType?.toLowerCase() === "doi"
          ? normalizeDoi(identifier).canonicalDoi
          : null;
      relations.push({
        direction,
        identifier,
        canonicalIdentifier,
        identifierType,
        updateType: nullableString(
          shape === "update" ? entry.type : entry["update-type"],
        ),
        assertedBy: nullableString(entry["asserted-by"]),
        source: nullableString(entry.source),
        label: nullableString(entry.label),
        updatedAt: updatedAt(entry.updated),
        location,
      });
    });
  }

  readRelationArray(
    message["update-to"],
    "message.update-to",
    "update-to",
    "update",
  );
  const relationObject = objectRecord(message.relation);
  if (message.relation !== undefined && relationObject === null) {
    issues.push({
      code: "malformed_relation",
      location: "message.relation",
      detail: "relation entry must be an object",
    });
  }
  if (relationObject !== null) {
    readRelationArray(
      relationObject["update-to"],
      "message.relation.update-to",
      "update-to",
      "relation",
    );
    readRelationArray(
      relationObject["updated-by"],
      "message.relation.updated-by",
      "updated-by",
      "relation",
    );
  }

  const signatures = new Map<string, string>();
  const identities = new Map<string, string>();
  for (const relation of relations) {
    const signature = relationSignature(relation);
    const identity = relationIdentity(relation);
    const priorLocation = signatures.get(signature);
    if (priorLocation !== undefined) {
      issues.push({
        code: "duplicate_relation",
        location: relation.location,
        detail: "duplicate relation evidence preserved",
      });
    } else {
      signatures.set(signature, relation.location);
    }
    const priorSignature = identities.get(identity);
    if (priorSignature !== undefined && priorSignature !== signature) {
      issues.push({
        code: "conflicting_relation",
        location: relation.location,
        detail: "conflicting relation evidence preserved",
      });
    } else if (priorSignature === undefined) {
      identities.set(identity, signature);
    }
  }

  if (relations.length > 0) {
    return {
      status:
        issues.length === 0
          ? "notice_relations_found"
          : "notice_relations_found_with_issues",
      summary: "notice relation evidence found in checked Crossref fields",
      checkedFields: [...CHECKED_RELATION_FIELDS],
      relations,
      issues,
    };
  }
  if (issues.length > 0) {
    return {
      status: "relation_check_incomplete",
      summary: "relation evidence could not be fully inspected",
      checkedFields: [...CHECKED_RELATION_FIELDS],
      relations,
      issues,
    };
  }
  return {
    status: "no_notice_found_in_checked_sources",
    summary: "no notice found in checked sources",
    checkedFields: [...CHECKED_RELATION_FIELDS],
    relations,
    issues,
  };
}

function overallStatus(
  fields: CrossrefFieldDiff[],
): "verified" | "partial" | "mismatch" {
  if (fields.some(({ status }) => status === "mismatch")) {
    return "mismatch";
  }
  return fields.every(({ status }) => status === "match")
    ? "verified"
    : "partial";
}

export function createCrossrefMetadataVerifier(
  dependencies: CrossrefMetadataVerifierDependencies,
) {
  const configuration = snapshotPassiveValue(dependencies);
  const evidenceMode = configuration.evidenceMode;
  if (!(["fixture", "mocked", "live"] as const).includes(evidenceMode)) {
    throw new TypeError("retrieval configuration contains unsupported values");
  }
  const retry = readRetry(configuration.retry);
  const limits = readLimits(configuration.limits);
  const cacheConfiguration = readCache(configuration.cache);
  const fetchRequest =
    validatedOptionalCallback(configuration.fetch) ??
    ((input: string, init?: RequestInit) => fetch(input, init));
  const now = validatedOptionalCallback(configuration.now) ?? (() => new Date());
  const sleep =
    validatedOptionalCallback(configuration.sleep) ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const log = validatedOptionalCallback(configuration.log);
  const mailto = validateOptionalSecret(configuration.mailto, "mailto", 320);
  const plusApiToken = validateOptionalSecret(
    configuration.plusApiToken,
    "plusApiToken",
    2_048,
  );
  const userAgent =
    validateOptionalSecret(
      configuration.userAgent ?? "EvidenceForge-Hackathon/0.1",
      "userAgent",
      512,
    ) ?? "EvidenceForge-Hackathon/0.1";
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ProviderLoadResult>>();

  async function request(
    url: string,
    deadlineAt: number,
  ): Promise<RequestResult> {
    const attemptHistory: CrossrefAttempt[] = [];
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const queuedAt = now();
      if (deadlineAt - queuedAt.getTime() <= 0) {
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          checkedAt: queuedAt.toISOString(),
          attemptHistory,
          rateLimit: null,
        };
      }

      const releasePermit = await acquireCrossrefPermit(deadlineAt, now);
      if (releasePermit === null) {
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          checkedAt: now().toISOString(),
          attemptHistory,
          rateLimit: null,
        };
      }
      const startedAt = now();
      const remainingAtStart = deadlineAt - startedAt.getTime();
      if (remainingAtStart <= 0) {
        releasePermit();
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          checkedAt: startedAt.toISOString(),
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
      let fetchCleanup: Promise<void> | null = null;
      try {
        const headers: Record<string, string> = {
          accept: "application/json",
          "User-Agent": userAgent,
        };
        if (plusApiToken !== undefined) {
          headers["Crossref-Plus-API-Token"] = `Bearer ${plusApiToken}`;
        }
        const fetchOperation = fetchRequest(url, {
          method: "GET",
          redirect: "error",
          headers,
          signal: controller.signal,
        });
        fetchCleanup = fetchOperation.then(
          async (lateResponse) => {
            if (controller.signal.aborted && lateResponse.body !== null) {
              try {
                await lateResponse.body.cancel();
              } catch {
                // The attempt is already bounded; cancellation is best effort.
              }
            }
          },
          () => undefined,
        );
        void fetchCleanup.catch(() => undefined);
        response = await withAbort(fetchOperation, controller.signal);
        if (response.ok) {
          bodyText = await readBoundedResponseBody(
            response,
            controller.signal,
            now,
            deadlineAt,
            limits.responseBytes,
          );
        } else if (response.body !== null) {
          await cancelWithinDeadline(
            () => response!.body!.cancel(),
            deadlineAt,
            now,
          );
        }
      } catch (error) {
        exception = error;
      } finally {
        clearTimeout(timer);
        if (
          controller.signal.aborted &&
          response === null &&
          fetchCleanup !== null
        ) {
          await settleWithinDeadline(fetchCleanup, deadlineAt, now);
        }
        releasePermit();
      }

      const endedAt = now();
      const deadlineExpired = endedAt.getTime() >= deadlineAt;
      const bodyLimitExceeded = exception instanceof CrossrefBodyLimitError;
      const outcome: CrossrefAttemptOutcome = deadlineExpired
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
      attemptHistory.push({
        attempt,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        outcome,
        httpStatus: response?.status ?? null,
        retryDelayMs: canRetry ? proposedDelay : null,
      });
      emitOptionalTelemetry(log, {
        service: "crossref",
        operation: "verify_metadata",
        evidenceMode,
        attempt,
        outcome,
        httpStatus: response?.status ?? null,
        retryScheduled: canRetry,
      });

      if (canRetry && proposedDelay !== null) {
        if (!(await completeBackoff(sleep, proposedDelay))) {
          return {
            kind: "failure",
            failureCode: "network_error",
            checkedAt: endedAt.toISOString(),
            attemptHistory,
            rateLimit:
              response === null ? null : rateLimitSnapshot(response.headers),
          };
        }
        continue;
      }

      const checkedAt = endedAt.toISOString();
      const rateLimit =
        response === null ? null : rateLimitSnapshot(response.headers);
      if (deadlineExpired) {
        return {
          kind: "failure",
          failureCode: "deadline_exceeded",
          checkedAt,
          attemptHistory,
          rateLimit,
        };
      }
      if (bodyLimitExceeded) {
        return {
          kind: "failure",
          failureCode: "invalid_response",
          checkedAt,
          attemptHistory,
          rateLimit,
        };
      }
      if (exception !== null || response === null) {
        return {
          kind: "failure",
          failureCode:
            requestExceptionOutcome(exception, controller.signal.aborted) ===
            "timeout"
              ? "timeout"
              : "network_error",
          checkedAt,
          attemptHistory,
          rateLimit,
        };
      }
      if (!response.ok) {
        return {
          kind: "failure",
          failureCode:
            response.status === 404
              ? "not_found"
              : response.status === 429
                ? "rate_limited"
                : response.status >= 500
                  ? "provider_unavailable"
                  : "request_rejected",
          checkedAt,
          attemptHistory,
          rateLimit,
        };
      }
      if (bodyText === null) {
        return {
          kind: "failure",
          failureCode: "invalid_response",
          checkedAt,
          attemptHistory,
          rateLimit,
        };
      }
      return {
        kind: "response",
        response,
        bodyText,
        checkedAt,
        attemptHistory,
        rateLimit,
      };
    }
    throw new Error("bounded Crossref request loop exhausted unexpectedly");
  }

  function storeCache(key: string, snapshot: ProviderSnapshot) {
    if (cache.size >= cacheConfiguration.maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey === "string") {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, {
      ...snapshot,
      expiresAtMs:
        new Date(snapshot.checkedAt).getTime() + cacheConfiguration.ttlMs,
    });
  }

  async function loadProvider(
    url: string,
    cacheKey: string,
    deadlineAt: number,
  ): Promise<ProviderLoadResult> {
    const requested = await request(url, deadlineAt);
    if (requested.kind === "failure") {
      return requested;
    }
    const message = parseEnvelope(requested.bodyText);
    if (message === null) {
      return {
        kind: "failure",
        failureCode: "invalid_response",
        checkedAt: requested.checkedAt,
        attemptHistory: requested.attemptHistory,
        rateLimit: requested.rateLimit,
      };
    }
    const snapshot: ProviderSnapshot = {
      message,
      checkedAt: requested.checkedAt,
      rateLimit:
        requested.rateLimit === null ? null : { ...requested.rateLimit },
    };
    storeCache(cacheKey, snapshot);
    return {
      kind: "success",
      snapshot,
      attemptHistory: requested.attemptHistory.map((attempt) => ({
        ...attempt,
      })),
      expiresAt: new Date(
        new Date(snapshot.checkedAt).getTime() + cacheConfiguration.ttlMs,
      ).toISOString(),
    };
  }

  function startProviderLoad(
    url: string,
    cacheKey: string,
    deadlineAt: number,
  ): Promise<ProviderLoadResult> {
    const load = loadProvider(url, cacheKey, deadlineAt).catch(
      (): ProviderLoadResult => ({
        kind: "failure",
        failureCode: "network_error",
        checkedAt: now().toISOString(),
        attemptHistory: [],
        rateLimit: null,
      }),
    );
    inFlight.set(cacheKey, load);
    const cleanup = () => {
      if (inFlight.get(cacheKey) === load) {
        inFlight.delete(cacheKey);
      }
    };
    void load.then(cleanup, cleanup);
    return load;
  }

  function waitForProviderLoad(
    load: Promise<ProviderLoadResult>,
    deadlineAt: number,
  ): Promise<ProviderLoadResult | null> {
    const remainingMs = deadlineAt - now().getTime();
    if (remainingMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ProviderLoadResult | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), remainingMs);
      void load.then(
        (value) => finish(now().getTime() >= deadlineAt ? null : value),
        () => finish({
          kind: "failure",
          failureCode: "network_error",
          checkedAt: now().toISOString(),
          attemptHistory: [],
          rateLimit: null,
        }),
      );
    });
  }

  async function verify(
    input: CrossrefVerificationRequest,
  ): Promise<CrossrefVerificationResult> {
    let requestInput: CrossrefVerificationRequest;
    try {
      requestInput = snapshotPassiveValue(input);
    } catch {
      return emptyResult(evidenceMode, {
        status: "not_applicable",
        failureCode: "invalid_doi",
        canonicalDoi: null,
      });
    }
    const normalized = normalizeDoi(requestInput.doi);
    if (normalized.status !== "valid") {
      return emptyResult(evidenceMode, {
        status: "not_applicable",
        failureCode: "invalid_doi",
        canonicalDoi: null,
      });
    }
    if (requestInput.registrationAgency.status !== "identified") {
      return emptyResult(evidenceMode, {
        status: "not_applicable",
        failureCode: "registration_agency_not_identified",
        canonicalDoi: normalized.canonicalDoi,
      });
    }
    if (
      requestInput.registrationAgency.agency.trim().toLowerCase() !==
      "crossref"
    ) {
      return emptyResult(evidenceMode, {
        status: "unsupported_agency",
        failureCode: "unsupported_agency",
        canonicalDoi: normalized.canonicalDoi,
      });
    }

    const baseUrl = recordUrl(normalized.canonicalDoi);
    const url = new URL(baseUrl);
    if (mailto !== undefined) {
      url.searchParams.set("mailto", mailto);
    }
    const cacheKey = `crossref:${evidenceMode}:${normalized.canonicalDoi}`;
    const deadlineAt = now().getTime() + limits.deadlineMs;
    let cacheStatus: CrossrefVerificationResult["cache"]["status"] = "miss";
    const cached = cache.get(cacheKey);
    let snapshot: ProviderSnapshot;
    let attemptHistory: CrossrefAttempt[] = [];
    let sourceFromCache = false;
    let requestCoalesced = false;
    let expiresAt: string | null = null;

    if (cached !== undefined && now().getTime() < cached.expiresAtMs) {
      cacheStatus = "hit";
      sourceFromCache = true;
      snapshot = cached;
      expiresAt = new Date(cached.expiresAtMs).toISOString();
    } else {
      if (cached !== undefined) {
        cacheStatus = "expired";
        cache.delete(cacheKey);
      }
      let load = inFlight.get(cacheKey);
      let startedLoad = false;
      if (load === undefined) {
        load = startProviderLoad(url.toString(), cacheKey, deadlineAt);
        startedLoad = true;
      } else {
        requestCoalesced = true;
        cacheStatus = "coalesced";
      }
      const loaded = startedLoad
        ? await load
        : await waitForProviderLoad(load, deadlineAt);
      if (loaded === null) {
        return emptyResult(evidenceMode, {
          status: "provider_unavailable",
          failureCode: "deadline_exceeded",
          canonicalDoi: normalized.canonicalDoi,
          checkedAt: now().toISOString(),
          url: baseUrl,
          cacheKey,
          cacheStatus,
          requestCoalesced,
        });
      }
      if (loaded.kind === "failure") {
        const status: CrossrefVerificationStatus =
          loaded.failureCode === "not_found"
            ? "record_not_found"
            : loaded.failureCode === "rate_limited"
              ? "rate_limited"
              : loaded.failureCode === "request_rejected" ||
                  loaded.failureCode === "invalid_response"
                ? "error"
                : "provider_unavailable";
        return emptyResult(evidenceMode, {
          status,
          failureCode: loaded.failureCode,
          canonicalDoi: normalized.canonicalDoi,
          checkedAt: loaded.checkedAt,
          url: baseUrl,
          cacheKey,
          cacheStatus,
          requestCoalesced,
          attemptHistory: loaded.attemptHistory,
          rateLimit: loaded.rateLimit,
        });
      }
      snapshot = loaded.snapshot;
      attemptHistory = loaded.attemptHistory.map((attempt) => ({
        ...attempt,
      }));
      expiresAt = loaded.expiresAt;
    }

    const comparison = compareMetadata(
      normalized.canonicalDoi,
      snapshot.message,
      requestInput.supplied,
    );
    return {
      status: overallStatus(comparison.fields),
      failureCode: null,
      provider: "crossref",
      evidenceMode,
      canonicalDoi: normalized.canonicalDoi,
      checkedAt: snapshot.checkedAt,
      source: {
        apiVersion: CROSSREF_API_VERSION,
        recordUrl: baseUrl,
        access: accessLabel(evidenceMode),
        fromCache: sourceFromCache,
        requestCoalesced,
      },
      cache: {
        key: cacheKey,
        status: cacheStatus,
        expiresAt,
      },
      comparison,
      integrityNotice: inspectRelations(snapshot.message),
      attempts: attemptHistory.length,
      attemptHistory: attemptHistory.map((attempt) => ({ ...attempt })),
      rateLimit:
        snapshot.rateLimit === null ? null : { ...snapshot.rateLimit },
      doesNotEstablish: [...DOES_NOT_ESTABLISH],
    };
  }

  return { verify };
}
