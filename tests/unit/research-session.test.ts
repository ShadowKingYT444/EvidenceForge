import { afterEach, describe, expect, it } from "vitest";

import { createOwnerCookie, createResearchSession, deleteResearchSession, isOwnerRequest, normalizeResearchSessionInput, readResearchSession, researchSessionCookies, verifyOwnerSecret } from "../../src/server/session/research-session";

const priorSecret = process.env.RUN_TOKEN_SECRET;
const priorOwner = process.env.OWNER_DEMO_SECRET;

afterEach(() => {
  if (priorSecret === undefined) delete process.env.RUN_TOKEN_SECRET; else process.env.RUN_TOKEN_SECRET = priorSecret;
  if (priorOwner === undefined) delete process.env.OWNER_DEMO_SECRET; else process.env.OWNER_DEMO_SECRET = priorOwner;
});

describe("process-local research credential sessions", () => {
  it("stores credentials server-side and returns only safe model identity", () => {
    process.env.RUN_TOKEN_SECRET = "unit-test-run-secret";
    const config = normalizeResearchSessionInput({
      primary: { provider: "openai", model: "gpt-4.1-mini", apiKey: "private-model-key" },
      openAlexApiKey: "private-openalex-key",
      firecrawlApiKey: "private-firecrawl-key",
    });
    expect(config.reviewer).toEqual(config.primary);
    const created = createResearchSession(config);
    const cookie = created.cookie.split(";", 1)[0];
    const loaded = readResearchSession(new Request("https://app.test", { headers: { cookie } }));
    expect(loaded?.config).toEqual(config);
    expect(loaded?.safe).toMatchObject({ configured: true, primary: { provider: "openai", model: "gpt-4.1-mini" } });
    expect(JSON.stringify(loaded?.safe)).not.toMatch(/private-|apiKey/iu);
    const expired = deleteResearchSession(new Request("https://app.test", { headers: { cookie } }));
    expect(expired).toContain("Max-Age=0");
    expect(readResearchSession(new Request("https://app.test", { headers: { cookie } }))).toBeNull();
  });

  it("uses a signed HttpOnly owner cookie without exposing the passphrase", () => {
    process.env.RUN_TOKEN_SECRET = "unit-test-run-secret";
    process.env.OWNER_DEMO_SECRET = "owner-only-passphrase";
    expect(verifyOwnerSecret("owner-only-passphrase")).toBe(true);
    expect(verifyOwnerSecret("wrong")).toBe(false);
    const cookie = createOwnerCookie();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("owner-only-passphrase");
    expect(isOwnerRequest(new Request("https://app.test", { headers: { cookie: cookie.split(";", 1)[0] } }))).toBe(true);
    expect(cookie).toContain(`${researchSessionCookies.owner}=`);
  });
});
