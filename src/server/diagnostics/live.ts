import type { ConnectionCategory } from "../providers/connection";

export type DiagnosticFailureCode = "ok" | "configuration_invalid" | "credential_rejected" | "rate_limited" | "upstream_unavailable" | "http_error" | "timeout" | "invalid_response" | "network_error";

export function classifyDiagnosticHttpStatus(status: number): DiagnosticFailureCode {
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return status >= 200 && status < 300 ? "ok" : "http_error";
}

export function classifyConnectionCategory(category: ConnectionCategory): DiagnosticFailureCode {
  if (category === "success") return "ok";
  if (category === "configuration") return "configuration_invalid";
  if (category === "rate_limited") return "rate_limited";
  if (category === "timeout") return "timeout";
  if (category === "invalid_response") return "invalid_response";
  if (category === "network_error") return "network_error";
  return category === "http_5xx" ? "upstream_unavailable" : "credential_rejected";
}
