import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EnvironmentValidationError } from "../../src/server/environment";
import { InvalidRequestError, ProviderRateLimitError, UpstreamProviderError, WorkflowStateConflictError, liveRouteError } from "../../src/server/workflow/live-http";
import { RevisionConflictError, RunNotFoundError } from "../../src/server/workflow/store";
import { ResearchSessionRequiredError } from "../../src/server/session/research-session";

describe("live route error classification", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [new RunNotFoundError("private-run"), 404, "run_not_found"],
    [new z.ZodError([]), 400, "invalid_request"],
    [new InvalidRequestError("bad body"), 400, "invalid_request"],
    [new RevisionConflictError("private-run"), 409, "revision_conflict"],
    [new WorkflowStateConflictError("wrong phase"), 409, "workflow_state_conflict"],
    [new EnvironmentValidationError(["OPENALEX_API_KEY"]), 503, "runtime_configuration_invalid"],
    [new ResearchSessionRequiredError(), 401, "research_session_required"],
    [new ProviderRateLimitError(), 429, "provider_rate_limited"],
    [new UpstreamProviderError(), 502, "upstream_provider_failure"],
    [new Error("secret response body"), 500, "internal_error"],
  ])("maps %s to a safe response", async (error, status, code) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = liveRouteError(error, { request: new Request("https://app.test/api/runs/private-run/continue", { headers: { "x-request-id": "request-12345" } }), operation: "test", durationMs: 7 });
    expect(response.status).toBe(status);
    expect(response.headers.get("x-correlation-id")).toBe("request-12345");
    const body = await response.json();
    expect(body.error).toMatchObject({ code, correlationId: "request-12345" });
    expect(JSON.stringify(body)).not.toContain("secret response body");
    expect(logged).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(logged.mock.calls[0][0]));
    expect(entry).toMatchObject({ correlationId: "request-12345", operation: "test", httpStatus: status, durationMs: 7 });
    expect(JSON.stringify(entry)).not.toContain("private-run");
    expect(JSON.stringify(entry)).not.toContain("secret response body");
  });
});
