import { describe, expect, it } from "vitest";

import { classifyConnectionCategory, classifyDiagnosticHttpStatus } from "../../src/server/diagnostics/live";

describe("live diagnostic classification", () => {
  it.each([[200, "ok"], [401, "credential_rejected"], [403, "credential_rejected"], [429, "rate_limited"], [500, "upstream_unavailable"], [418, "http_error"]])
    ("classifies HTTP %i", (status, code) => expect(classifyDiagnosticHttpStatus(status)).toBe(code));

  it.each([["success", "ok"], ["configuration", "configuration_invalid"], ["timeout", "timeout"], ["invalid_response", "invalid_response"], ["network_error", "network_error"], ["http_5xx", "upstream_unavailable"], ["http_4xx", "credential_rejected"]] as const)
    ("classifies provider result %s", (category, code) => expect(classifyConnectionCategory(category)).toBe(code));
});
