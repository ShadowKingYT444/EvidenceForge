import { connectionLimits, verifyProviderConnection } from "../../../../server/providers/connection";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

type HeaderValue = { present: false; value: null } | { present: true; value: string } | { present: true; value: null };

function readSingleHeader(request: Request, name: string): HeaderValue {
  const raw = request.headers.get(name);
  if (raw === null) return { present: false, value: null };
  const value = raw.trim();
  return value && raw === value && !raw.includes(",") ? { present: true, value } : { present: true, value: null };
}

function forwardedOrigin(request: Request): string | null | undefined {
  const forwardedHost = readSingleHeader(request, "x-forwarded-host");
  const forwardedProto = readSingleHeader(request, "x-forwarded-proto");
  if (!forwardedHost.present && !forwardedProto.present) {
    try {
      const url = new URL(request.url);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
    } catch {
      return undefined;
    }
  }
  if (!forwardedHost.present || !forwardedProto.present || !forwardedHost.value || !forwardedProto.value) return undefined;
  const proto = forwardedProto.value.toLowerCase();
  const host = forwardedHost.value;
  if ((proto !== "http" && proto !== "https") || /[\s/@\\]/.test(host)) return undefined;
  try {
    const url = new URL(`${proto}://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.host.toLowerCase() !== host.toLowerCase()) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const expected = forwardedOrigin(request);
    if (!expected) return false;
    const actual = new URL(origin);
    return actual.origin === expected && actual.pathname === "/" && !actual.search && !actual.hash;
  } catch {
    return false;
  }
}

async function readBoundedRequest(request: Request): Promise<{ raw: string; tooLarge: boolean }> {
  if (!request.body) return { raw: await request.text(), tooLarge: false };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > connectionLimits.MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { raw: "", tooLarge: true };
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { raw: chunks.join(""), tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return reply({ ok: false, error: { code: "invalid_request", message: "This request must come from the app." } }, 403);
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > connectionLimits.MAX_REQUEST_BYTES) return reply({ ok: false, error: { code: "invalid_request", message: "The request is too large." } }, 413);
  let raw: string;
  try {
    const bounded = await readBoundedRequest(request);
    if (bounded.tooLarge) return reply({ ok: false, error: { code: "invalid_request", message: "The request is too large." } }, 413);
    raw = bounded.raw;
  } catch {
    return reply({ ok: false, error: { code: "invalid_request", message: "The request could not be read." } }, 400);
  }
  if (new TextEncoder().encode(raw).byteLength > connectionLimits.MAX_REQUEST_BYTES) return reply({ ok: false, error: { code: "invalid_request", message: "The request is too large." } }, 413);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reply({ ok: false, error: { code: "invalid_request", message: "Send a valid JSON request." } }, 400);
  }
  const result = await verifyProviderConnection(value, { rateKey: clientKey(request) });
  const status = result.ok ? 200 : result.error.code === "rate_limited" ? 429 : result.error.code === "invalid_request" ? 400 : 502;
  return reply(result, status);
}
