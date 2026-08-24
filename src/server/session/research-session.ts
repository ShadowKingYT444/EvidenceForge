import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { digestRunToken, readRunTokenSecret } from "../auth/run-token";

export const researchProviderIds = ["openai", "anthropic", "gemini", "groq", "grok", "deepseek", "nvidia_nim", "featherless"] as const;
export const ResearchProviderSchema = z.enum(researchProviderIds);
export type ResearchProvider = z.infer<typeof ResearchProviderSchema>;

const modelCredentialSchema = z.object({
  provider: ResearchProviderSchema,
  model: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  apiKey: z.string().trim().min(8).max(2048),
}).strict();

export const ResearchSessionInputSchema = z.object({
  primary: modelCredentialSchema,
  reviewer: modelCredentialSchema.optional(),
  openAlexApiKey: z.string().trim().min(8).max(2048),
  firecrawlApiKey: z.string().trim().min(8).max(2048),
}).strict();

export type ModelCredential = z.infer<typeof modelCredentialSchema>;
export type ResearchRuntimeConfig = {
  primary: ModelCredential;
  reviewer: ModelCredential;
  openAlexApiKey: string;
  firecrawlApiKey: string;
};

export type SafeResearchSession = {
  configured: true;
  primary: { provider: ResearchProvider; model: string };
  reviewer: { provider: ResearchProvider; model: string };
  expiresAt: string;
};

export class ResearchSessionRequiredError extends Error {
  readonly code = "research_session_required";
  constructor() {
    super("Connect model and retrieval credentials before starting an investigation.");
    this.name = "ResearchSessionRequiredError";
  }
}

const RESEARCH_COOKIE = "evidenceforge_research_session";
const OWNER_COOKIE = "evidenceforge_owner_demo";
const records = new Map<string, { config: ResearchRuntimeConfig; expiresAt: number }>();

function ttlMs(): number {
  const minutes = Number(process.env.RESEARCH_SESSION_TTL_MINUTES ?? 120);
  return Math.max(5, Number.isFinite(minutes) ? minutes : 120) * 60_000;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [candidate, ...value] = part.trim().split("=");
    if (candidate === name && value.length) {
      try { return decodeURIComponent(value.join("=")); } catch { return null; }
    }
  }
  return null;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function sessionDigest(token: string): string {
  return digestRunToken(token, readRunTokenSecret());
}

function sweep(now = Date.now()): void {
  for (const [key, record] of records) if (record.expiresAt <= now) records.delete(key);
}

export function normalizeResearchSessionInput(value: unknown): ResearchRuntimeConfig {
  const parsed = ResearchSessionInputSchema.parse(value);
  return {
    primary: { ...parsed.primary },
    reviewer: { ...(parsed.reviewer ?? parsed.primary) },
    openAlexApiKey: parsed.openAlexApiKey,
    firecrawlApiKey: parsed.firecrawlApiKey,
  };
}

export function createResearchSession(config: ResearchRuntimeConfig): { cookie: string; safe: SafeResearchSession } {
  sweep();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ttlMs();
  records.set(sessionDigest(token), { config: structuredClone(config), expiresAt });
  return {
    cookie: secureCookie(RESEARCH_COOKIE, token, Math.floor(ttlMs() / 1000)),
    safe: safeSession(config, expiresAt),
  };
}

function safeSession(config: ResearchRuntimeConfig, expiresAt: number): SafeResearchSession {
  return {
    configured: true,
    primary: { provider: config.primary.provider, model: config.primary.model },
    reviewer: { provider: config.reviewer.provider, model: config.reviewer.model },
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function readResearchSession(request: Request): { config: ResearchRuntimeConfig; safe: SafeResearchSession } | null {
  const token = cookieValue(request, RESEARCH_COOKIE);
  return readResearchSessionCookieValue(token ?? undefined);
}

export function readResearchSessionCookieValue(token: string | undefined): { config: ResearchRuntimeConfig; safe: SafeResearchSession } | null {
  sweep();
  if (!token) return null;
  const record = records.get(sessionDigest(token));
  if (!record || record.expiresAt <= Date.now()) return null;
  return { config: structuredClone(record.config), safe: safeSession(record.config, record.expiresAt) };
}

export function requireResearchSession(request: Request) {
  const session = readResearchSession(request);
  if (!session) throw new ResearchSessionRequiredError();
  return session;
}

export function deleteResearchSession(request: Request): string {
  const token = cookieValue(request, RESEARCH_COOKIE);
  if (token) records.delete(sessionDigest(token));
  return secureCookie(RESEARCH_COOKIE, "", 0);
}

function secretHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyOwnerSecret(candidate: string): boolean {
  const configured = process.env.OWNER_DEMO_SECRET?.trim();
  if (!configured || !candidate.trim()) return false;
  return timingSafeEqual(secretHash(candidate.trim()), secretHash(configured));
}

function expectedOwnerCookie(): string | null {
  const ownerSecret = process.env.OWNER_DEMO_SECRET?.trim();
  if (!ownerSecret) return null;
  return createHmac("sha256", readRunTokenSecret()).update(`owner-demo:${ownerSecret}`, "utf8").digest("base64url");
}

export function createOwnerCookie(): string {
  return secureCookie(OWNER_COOKIE, expectedOwnerCookie()!, 30 * 24 * 60 * 60);
}

export function isOwnerRequest(request: Request): boolean {
  const expected = expectedOwnerCookie();
  const actual = cookieValue(request, OWNER_COOKIE);
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isOwnerCookieValue(value: string | undefined): boolean {
  const expected = expectedOwnerCookie();
  if (!expected || !value) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(value);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const researchSessionCookies = { research: RESEARCH_COOKIE, owner: OWNER_COOKIE } as const;
