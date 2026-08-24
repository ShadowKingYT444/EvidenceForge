import { searchScholarlyWorks } from "@/server/sources/openalex";
import { searchFirecrawl } from "@/server/sources/firecrawl";
import { createResearchSession, deleteResearchSession, isOwnerRequest, normalizeResearchSessionInput, readResearchSession } from "@/server/session/research-session";
import { verifyProviderConnection, type ProviderId } from "@/server/providers/connection";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16 * 1024;

function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  const expected = forwardedHost && forwardedProto ? `${forwardedProto}://${forwardedHost}` : new URL(request.url).origin;
  try { return new URL(origin).origin === new URL(expected).origin; } catch { return false; }
}

function providerId(provider: string): ProviderId {
  return provider as ProviderId;
}

function reply(body: unknown, status = 200, cookie?: string): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store", ...(cookie ? { "set-cookie": cookie } : {}) } });
}

export async function GET(request: Request): Promise<Response> {
  const session = readResearchSession(request);
  return reply({ configured: Boolean(session), session: session?.safe ?? null, ownerDemo: isOwnerRequest(request) });
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return reply({ ok: false, error: { code: "invalid_origin", message: "Configuration must come from this application." } }, 403);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return reply({ ok: false, error: { code: "invalid_request", message: "Configuration request is too large." } }, 413);
  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return reply({ ok: false, error: { code: "invalid_request", message: "Configuration request is too large." } }, 413);
  let config;
  try { config = normalizeResearchSessionInput(JSON.parse(raw)); }
  catch { return reply({ ok: false, error: { code: "invalid_request", message: "Check provider, model, and credential fields." } }, 400); }

  const primaryPromise = verifyProviderConnection({ ...config.primary, provider: providerId(config.primary.provider) }, { rateKey: `session:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}` });
  const sameReviewer = JSON.stringify(config.reviewer) === JSON.stringify(config.primary);
  const reviewerPromise = sameReviewer
    ? primaryPromise
    : verifyProviderConnection({ ...config.reviewer, provider: providerId(config.reviewer.provider) }, { rateKey: `reviewer:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}` });
  const [primary, reviewer, openalex, firecrawl] = await Promise.all([
    primaryPromise,
    reviewerPromise,
    searchScholarlyWorks("evidence synthesis", { apiKey: config.openAlexApiKey, limits: { maxResults: 1, pageSize: 1, maxPages: 1, deadlineMs: 8_000 } }),
    searchFirecrawl("evidence synthesis", { apiKey: config.firecrawlApiKey, maxResults: 1, deadlineMs: 8_000 }),
  ]);
  const diagnostics = {
    primary: primary.ok ? { ok: true, provider: config.primary.provider, model: config.primary.model, latencyMs: primary.latencyMs } : { ok: false, code: primary.error.code },
    reviewer: reviewer.ok ? { ok: true, provider: config.reviewer.provider, model: config.reviewer.model, latencyMs: reviewer.latencyMs } : { ok: false, code: reviewer.error.code },
    openalex: { ok: openalex.raw.failureCode === null, code: openalex.raw.failureCode },
    firecrawl: { ok: firecrawl.raw.failureCode === null, code: firecrawl.raw.failureCode },
  };
  if (!diagnostics.primary.ok || !diagnostics.reviewer.ok || !diagnostics.openalex.ok || !diagnostics.firecrawl.ok) {
    return reply({ ok: false, diagnostics, error: { code: "credential_check_failed", message: "One or more providers rejected the bounded connection check." } }, 502);
  }
  const created = createResearchSession(config);
  return reply({ ok: true, session: created.safe, diagnostics }, 201, created.cookie);
}

export async function DELETE(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return reply({ ok: false }, 403);
  return reply({ ok: true }, 200, deleteResearchSession(request));
}
