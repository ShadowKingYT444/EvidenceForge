import { describe, expect, it } from "vitest";
import { createRunToken, digestRunToken, extractRunToken, runTokenCookie, tokenMatchesDigest } from "../../src/server/auth/run-token";

describe("private run tokens", () => {
  it("creates 256-bit tokens and verifies HMAC digests", () => {
    const token = createRunToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const digest = digestRunToken(token, "test-secret");
    expect(tokenMatchesDigest(token, digest, "test-secret")).toBe(true);
    expect(tokenMatchesDigest(`${token}x`, digest, "test-secret")).toBe(false);
  });

  it("extracts cookie and bearer tokens and emits private cookie attributes", () => {
    const token = "abc+123";
    const request = new Request("https://example.test", { headers: { cookie: `other=x; evidenceforge_run_token=${encodeURIComponent(token)}` } });
    expect(extractRunToken(request)).toBe(token);
    expect(extractRunToken(new Request("https://example.test", { headers: { authorization: "Bearer bearer-token" } }))).toBe("bearer-token");
    expect(runTokenCookie(token, { secure: true })).toContain("HttpOnly");
    expect(runTokenCookie(token, { secure: true })).toContain("SameSite=Lax");
    expect(runTokenCookie(token, { secure: true })).toContain("Secure");
  });
});
