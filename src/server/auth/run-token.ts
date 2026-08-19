import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RUN_TOKEN_COOKIE = "evidenceforge_run_token";
export const RUN_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function createRunToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestRunToken(token: string, secret: string): string {
  if (!token || !secret) throw new Error("token and secret are required");
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

export function tokenMatchesDigest(token: string, digest: string, secret: string): boolean {
  if (!token || !digest || !secret) return false;
  const expected = Buffer.from(digestRunToken(token, secret), "hex");
  const actual = Buffer.from(digest, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function runTokenCookie(
  token: string,
  options: { secure?: boolean; maxAge?: number; runId?: string } = {},
): string {
  const maxAge = options.maxAge ?? RUN_TOKEN_TTL_SECONDS;
  const secure = options.secure ?? process.env.NODE_ENV === "production";
  const name = cookieName(options.runId);
  return `${name}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function cookieName(runId?: string): string {
  if (!runId) return RUN_TOKEN_COOKIE;
  return `${RUN_TOKEN_COOKIE}_${runId.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

export function extractRunToken(request: Request, runId?: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  const expectedName = cookieName(runId);
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName && value.length) {
      try { return decodeURIComponent(value.join("=")); } catch { return null; }
    }
  }
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() || null : null;
}
