import {
  completeBackoff,
  emitOptionalTelemetry,
  publicExternalUrl,
  requestExceptionOutcome,
  snapshotPassiveValue,
  validatedOptionalCallback,
} from "./privacy";

const DOI_RESOLVER_ORIGIN = "https://doi.org";
const DOI_RESOLVER_HOSTS = new Set(["doi.org", "www.doi.org", "dx.doi.org"]);
const DOI_PREFIX_SYNTAX = /^10(?:\.\d+)+$/u;
const DOI_GRAPHIC_SUFFIX = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$/u;
const DOI_URL_SAFE_ASCII = /^[A-Za-z0-9\-._~!$&'()*+;=:@]$/;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const REDIRECT_HTTP_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_AGENCY_RESPONSE_BYTES = 64_000;

export type DoiNormalizationResult =
  | {
      status: "valid";
      originalInput: string;
      canonicalDoi: string;
      canonicalUrl: string;
    }
  | {
      status: "invalid";
      originalInput: string;
      canonicalDoi: null;
      canonicalUrl: null;
      reason: "invalid_syntax" | "invalid_url" | "unsupported_url";
    }
  | {
      status: "not_provided";
      originalInput: null;
      canonicalDoi: null;
      canonicalUrl: null;
    };

export type DoiAttemptOutcome =
  | "success"
  | "not_found"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "network_error"
  | "error";

export type DoiAttempt = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  outcome: DoiAttemptOutcome;
  httpStatus: number | null;
  retryDelayMs: number | null;
};

type DoiCheckBase = {
  attempts: number;
  checkedAt: string;
  attemptHistory: DoiAttempt[];
};

export type DoiResolutionResult =
  | (DoiCheckBase & {
      status: "resolved";
      finalUrl: string;
      failureCode: null;
    })
  | (DoiCheckBase & {
      status:
        | "does_not_resolve"
        | "rate_limited"
        | "provider_unavailable"
        | "error";
      finalUrl: null;
      failureCode:
        | "not_found"
        | "rate_limited"
        | "timeout"
        | "network_error"
        | "unexpected_response"
        | "invalid_redirect";
    })
  | {
      status: "not_checked";
      finalUrl: null;
      failureCode: "invalid_syntax" | "not_provided";
      attempts: 0;
      checkedAt: null;
      attemptHistory: [];
    };

export type RegistrationAgencyResult =
  | (DoiCheckBase & {
      status: "identified";
      agency: string;
      failureCode?: null;
    })
  | (DoiCheckBase & {
      status:
        | "does_not_exist"
        | "unknown"
        | "rate_limited"
        | "provider_unavailable"
        | "error";
      agency: null;
      failureCode?:
        | "not_found"
        | "unknown_agency"
        | "rate_limited"
        | "timeout"
        | "network_error"
        | "unexpected_response"
        | "malformed_response";
    })
  | {
      status: "not_checked";
      agency: null;
      failureCode: "invalid_syntax" | "not_provided";
      attempts: 0;
      checkedAt: null;
      attemptHistory: [];
    };

export type MetadataProviderRoute =
  | {
      status: "routed";
      provider: "crossref" | "datacite";
      metadataStatus: "not_checked";
    }
  | {
      status: "unsupported_agency";
      provider: null;
      registrationAgency: string;
      metadataStatus: "not_checked";
    }
  | {
      status: "not_applicable";
      provider: null;
      reason: "registration_agency_not_identified";
      metadataStatus: "not_checked";
    };

export type DoiInspectionResult = {
  syntax: DoiNormalizationResult;
  resolution: DoiResolutionResult;
  registrationAgency: RegistrationAgencyResult;
  metadataRoute: MetadataProviderRoute;
};

export type DoiLogEvent = {
  service: "doi_proxy" | "doi_registration_agency";
  operation: "resolve" | "identify_registration_agency";
  attempt: number;
  outcome: DoiAttemptOutcome;
  httpStatus: number | null;
  retryScheduled: boolean;
};

export type DoiInspectorDependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (event: DoiLogEvent) => void;
  retry?: Partial<{
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    timeoutMs: number;
  }>;
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
      attempts: number;
      checkedAt: string;
      attemptHistory: DoiAttempt[];
    }
  | {
      kind: "failure";
      failureCode: "timeout" | "network_error";
      attempts: number;
      checkedAt: string;
      attemptHistory: DoiAttempt[];
    };

function invalidDoi(
  originalInput: string,
  reason: "invalid_syntax" | "invalid_url" | "unsupported_url",
): DoiNormalizationResult {
  return {
    status: "invalid",
    originalInput,
    canonicalDoi: null,
    canonicalUrl: null,
    reason,
  };
}

function decodeDoiPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function encodeDoiPath(doi: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(doi)) {
    const character = String.fromCharCode(byte);
    encoded += DOI_URL_SAFE_ASCII.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function canonicalDoiUrl(doi: string): string {
  return `${DOI_RESOLVER_ORIGIN}/${encodeDoiPath(doi)}`;
}

export function normalizeDoi(
  input: string | null | undefined,
): DoiNormalizationResult {
  if (input === null || input === undefined) {
    return {
      status: "not_provided",
      originalInput: null,
      canonicalDoi: null,
      canonicalUrl: null,
    };
  }

  const originalInput = input;
  let candidate = input.trim();

  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return invalidDoi(originalInput, "invalid_url");
    }

    if (
      !DOI_RESOLVER_HOSTS.has(url.hostname.toLowerCase()) ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      return invalidDoi(originalInput, "unsupported_url");
    }

    if (
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return invalidDoi(originalInput, "invalid_url");
    }

    const decodedPath = decodeDoiPath(url.pathname);
    if (decodedPath === null) {
      return invalidDoi(originalInput, "invalid_url");
    }
    candidate = decodedPath;
  } else {
    candidate = candidate.replace(/^doi\s*:\s*/i, "");
  }

  const structuralSlash = candidate.indexOf("/");
  const prefix = candidate.slice(0, structuralSlash);
  const suffix = candidate.slice(structuralSlash + 1);
  if (
    structuralSlash < 0 ||
    !DOI_PREFIX_SYNTAX.test(prefix) ||
    !DOI_GRAPHIC_SUFFIX.test(suffix)
  ) {
    return invalidDoi(originalInput, "invalid_syntax");
  }

  const canonicalDoi = candidate.toLowerCase();
  return {
    status: "valid",
    originalInput,
    canonicalDoi,
    canonicalUrl: canonicalDoiUrl(canonicalDoi),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`retry configuration must be an integer ${minimum}-${maximum}`);
  }
  return value;
}

function retryConfiguration(
  input: DoiInspectorDependencies["retry"],
): RetryConfiguration {
  const baseDelayMs = boundedInteger(input?.baseDelayMs, 250, 0, 10_000);
  const maxDelayMs = boundedInteger(input?.maxDelayMs, 2_000, 0, 30_000);

  if (maxDelayMs < baseDelayMs) {
    throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");
  }

  return {
    maxAttempts: boundedInteger(input?.maxAttempts, 2, 1, 3),
    baseDelayMs,
    maxDelayMs,
    timeoutMs: boundedInteger(input?.timeoutMs, 5_000, 1, 30_000),
  };
}

function responseOutcome(status: number): DoiAttemptOutcome {
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  if (status >= 200 && status < 400) {
    return "success";
  }
  return "error";
}

function retryDelay(
  response: Response | null,
  attempt: number,
  configuration: RetryConfiguration,
  now: Date,
): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
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

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function emptyResolution(
  failureCode: "invalid_syntax" | "not_provided",
): DoiResolutionResult {
  return {
    status: "not_checked",
    finalUrl: null,
    failureCode,
    attempts: 0,
    checkedAt: null,
    attemptHistory: [],
  };
}

function emptyAgency(
  failureCode: "invalid_syntax" | "not_provided",
): RegistrationAgencyResult {
  return {
    status: "not_checked",
    agency: null,
    failureCode,
    attempts: 0,
    checkedAt: null,
    attemptHistory: [],
  };
}

export function routeMetadataProvider(
  agency: RegistrationAgencyResult,
): MetadataProviderRoute {
  if (agency.status !== "identified") {
    return {
      status: "not_applicable",
      provider: null,
      reason: "registration_agency_not_identified",
      metadataStatus: "not_checked",
    };
  }

  const normalizedAgency = agency.agency.trim().toLowerCase();
  if (normalizedAgency === "crossref") {
    return {
      status: "routed",
      provider: "crossref",
      metadataStatus: "not_checked",
    };
  }
  if (normalizedAgency === "datacite") {
    return {
      status: "routed",
      provider: "datacite",
      metadataStatus: "not_checked",
    };
  }
  return {
    status: "unsupported_agency",
    provider: null,
    registrationAgency: agency.agency,
    metadataStatus: "not_checked",
  };
}

export function createDoiInspector(dependencies: DoiInspectorDependencies = {}) {
  const configuration = snapshotPassiveValue(dependencies);
  const fetchRequest =
    validatedOptionalCallback(configuration.fetch) ??
    ((input: string, init?: RequestInit) => fetch(input, init));
  const now = validatedOptionalCallback(configuration.now) ?? (() => new Date());
  const sleep =
    validatedOptionalCallback(configuration.sleep) ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const log = validatedOptionalCallback(configuration.log);
  const retry = retryConfiguration(configuration.retry);

  async function request(
    url: string,
    operation: DoiLogEvent["operation"],
    service: DoiLogEvent["service"],
    accept: string,
  ): Promise<RequestResult> {
    const attemptHistory: DoiAttempt[] = [];

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const startedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), retry.timeoutMs);
      let response: Response | null = null;
      let exception: unknown = null;

      try {
        response = await fetchRequest(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept,
          },
          signal: controller.signal,
        });
      } catch (error) {
        exception = error;
      } finally {
        clearTimeout(timer);
      }

      const endedAt = now();
      const outcome =
        response === null
          ? requestExceptionOutcome(exception, controller.signal.aborted)
          : responseOutcome(response.status);
      const shouldRetry =
        attempt < retry.maxAttempts &&
        (response === null || isRetryableStatus(response.status));
      const delay = shouldRetry
        ? retryDelay(response, attempt, retry, endedAt)
        : null;
      const attemptRecord: DoiAttempt = {
        attempt,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        outcome,
        httpStatus: response?.status ?? null,
        retryDelayMs: delay,
      };
      attemptHistory.push(attemptRecord);
      emitOptionalTelemetry(log, {
        service,
        operation,
        attempt,
        outcome,
        httpStatus: response?.status ?? null,
        retryScheduled: shouldRetry,
      });

      if (shouldRetry && delay !== null) {
        if (!(await completeBackoff(sleep, delay))) {
          return {
            kind: "failure",
            failureCode: "network_error",
            attempts: attempt,
            checkedAt: endedAt.toISOString(),
            attemptHistory,
          };
        }
        continue;
      }

      const checkedAt = endedAt.toISOString();
      if (response !== null) {
        return {
          kind: "response",
          response,
          attempts: attempt,
          checkedAt,
          attemptHistory,
        };
      }
      return {
        kind: "failure",
        failureCode: outcome === "timeout" ? "timeout" : "network_error",
        attempts: attempt,
        checkedAt,
        attemptHistory,
      };
    }

    throw new Error("bounded DOI request loop exhausted unexpectedly");
  }

  async function resolve(input: string): Promise<DoiResolutionResult> {
    const normalized = normalizeDoi(input);
    if (normalized.status !== "valid") {
      return emptyResolution(
        normalized.status === "not_provided"
          ? "not_provided"
          : "invalid_syntax",
      );
    }

    const requestResult = await request(
      normalized.canonicalUrl,
      "resolve",
      "doi_proxy",
      "text/html",
    );
    if (requestResult.kind === "failure") {
      return {
        status: "provider_unavailable",
        finalUrl: null,
        failureCode: requestResult.failureCode,
        attempts: requestResult.attempts,
        checkedAt: requestResult.checkedAt,
        attemptHistory: requestResult.attemptHistory,
      };
    }

    const base = {
      attempts: requestResult.attempts,
      checkedAt: requestResult.checkedAt,
      attemptHistory: requestResult.attemptHistory,
    };
    const { response } = requestResult;

    if (REDIRECT_HTTP_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ...base,
          status: "error",
          finalUrl: null,
          failureCode: "invalid_redirect",
        };
      }
      try {
        const finalUrl = publicExternalUrl(
          new URL(location, DOI_RESOLVER_ORIGIN).toString(),
        );
        if (finalUrl === null) {
          throw new Error("unsupported redirect URL");
        }
        return {
          ...base,
          status: "resolved",
          finalUrl,
          failureCode: null,
        };
      } catch {
        return {
          ...base,
          status: "error",
          finalUrl: null,
          failureCode: "invalid_redirect",
        };
      }
    }
    if (response.status === 404) {
      return {
        ...base,
        status: "does_not_resolve",
        finalUrl: null,
        failureCode: "not_found",
      };
    }
    if (response.status === 429) {
      return {
        ...base,
        status: "rate_limited",
        finalUrl: null,
        failureCode: "rate_limited",
      };
    }
    if (response.status >= 500) {
      return {
        ...base,
        status: "provider_unavailable",
        finalUrl: null,
        failureCode: "unexpected_response",
      };
    }
    return {
      ...base,
      status: "error",
      finalUrl: null,
      failureCode: "unexpected_response",
    };
  }

  async function identifyRegistrationAgency(
    input: string,
  ): Promise<RegistrationAgencyResult> {
    const normalized = normalizeDoi(input);
    if (normalized.status !== "valid") {
      return emptyAgency(
        normalized.status === "not_provided"
          ? "not_provided"
          : "invalid_syntax",
      );
    }

    const requestResult = await request(
      `${DOI_RESOLVER_ORIGIN}/doiRA/${encodeDoiPath(normalized.canonicalDoi)}`,
      "identify_registration_agency",
      "doi_registration_agency",
      "application/json",
    );
    if (requestResult.kind === "failure") {
      return {
        status: "provider_unavailable",
        agency: null,
        failureCode: requestResult.failureCode,
        attempts: requestResult.attempts,
        checkedAt: requestResult.checkedAt,
        attemptHistory: requestResult.attemptHistory,
      };
    }

    const base = {
      attempts: requestResult.attempts,
      checkedAt: requestResult.checkedAt,
      attemptHistory: requestResult.attemptHistory,
    };
    const { response } = requestResult;

    if (response.status === 404) {
      return {
        ...base,
        status: "does_not_exist",
        agency: null,
        failureCode: "not_found",
      };
    }
    if (response.status === 429) {
      return {
        ...base,
        status: "rate_limited",
        agency: null,
        failureCode: "rate_limited",
      };
    }
    if (response.status >= 500) {
      return {
        ...base,
        status: "provider_unavailable",
        agency: null,
        failureCode: "unexpected_response",
      };
    }
    if (!response.ok) {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "unexpected_response",
      };
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_AGENCY_RESPONSE_BYTES
    ) {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "malformed_response",
      };
    }

    let payload: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_AGENCY_RESPONSE_BYTES) {
        throw new Error("agency response exceeds size bound");
      }
      payload = JSON.parse(text);
    } catch {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "malformed_response",
      };
    }

    if (!Array.isArray(payload) || payload.length !== 1) {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "malformed_response",
      };
    }
    const record = payload[0];
    if (
      typeof record !== "object" ||
      record === null ||
      !("DOI" in record) ||
      typeof record.DOI !== "string" ||
      record.DOI.toLowerCase() !== normalized.canonicalDoi
    ) {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "malformed_response",
      };
    }

    const agency =
      "RA" in record && typeof record.RA === "string"
        ? record.RA.trim()
        : "";
    const normalizedAgency = agency.toLowerCase();
    if (normalizedAgency.includes("does not exist")) {
      return {
        ...base,
        status: "does_not_exist",
        agency: null,
        failureCode: "not_found",
      };
    }
    if (normalizedAgency === "unknown") {
      return {
        ...base,
        status: "unknown",
        agency: null,
        failureCode: "unknown_agency",
      };
    }
    if (agency === "") {
      return {
        ...base,
        status: "error",
        agency: null,
        failureCode: "malformed_response",
      };
    }
    return {
      ...base,
      status: "identified",
      agency,
      failureCode: null,
    };
  }

  async function inspect(
    syntax: DoiNormalizationResult,
  ): Promise<DoiInspectionResult> {
    if (syntax.status !== "valid") {
      const failureCode =
        syntax.status === "not_provided" ? "not_provided" : "invalid_syntax";
      const registrationAgency = emptyAgency(failureCode);
      return {
        syntax,
        resolution: emptyResolution(failureCode),
        registrationAgency,
        metadataRoute: routeMetadataProvider(registrationAgency),
      };
    }

    const resolution = await resolve(syntax.canonicalDoi);
    const registrationAgency = await identifyRegistrationAgency(
      syntax.canonicalDoi,
    );
    return {
      syntax,
      resolution,
      registrationAgency,
      metadataRoute: routeMetadataProvider(registrationAgency),
    };
  }

  return {
    resolve,
    identifyRegistrationAgency,
    inspect,
  };
}
