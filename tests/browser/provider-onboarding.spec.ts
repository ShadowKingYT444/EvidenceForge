import { expect, test } from "@playwright/test";

test("shows the credential gate before the application and exposes no public demo", async ({ page }) => {
  await page.route("**/api/session/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false, session: null, ownerDemo: false }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Connect evidence to a model you trust/i })).toBeVisible();
  await expect(page.getByLabel("Research provider").locator("option")).toHaveCount(8);
  await expect(page.getByLabel("Research provider API key")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("OpenAlex API key")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Firecrawl API key")).toHaveAttribute("type", "password");
  await expect(page.getByText(/recorded fixture|try the demo|owner demo/iu)).toHaveCount(0);
});

test("verifies all credentials, clears browser secrets, and enters the composer", async ({ page }) => {
  const secrets = { model: "sk-model-secret", openalex: "openalex-secret", firecrawl: "fc-secret-value" };
  let configured = false;
  await page.route("**/api/session/research", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured, ownerDemo: false, session: configured ? { primary: { provider: "openai", model: "gpt-4.1-mini" }, reviewer: { provider: "openai", model: "gpt-4.1-mini" }, expiresAt: new Date(Date.now() + 60_000).toISOString() } : null }) });
    }
    const body = route.request().postDataJSON() as { primary: { apiKey: string }; openAlexApiKey: string; firecrawlApiKey: string };
    expect(body.primary.apiKey).toBe(secrets.model);
    expect(body.openAlexApiKey).toBe(secrets.openalex);
    expect(body.firecrawlApiKey).toBe(secrets.firecrawl);
    configured = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, diagnostics: { primary: { ok: true, latencyMs: 20 }, reviewer: { ok: true, latencyMs: 20 }, openalex: { ok: true }, firecrawl: { ok: true } } }) });
  });
  await page.goto("/");
  await page.getByLabel("Research provider API key").fill(secrets.model);
  await page.getByLabel("OpenAlex API key").fill(secrets.openalex);
  await page.getByLabel("Firecrawl API key").fill(secrets.firecrawl);
  await page.getByRole("button", { name: /Verify and enter EvidenceForge/i }).click();
  await expect(page.getByRole("heading", { name: /Test a claim against the evidence/i })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  for (const secret of Object.values(secrets)) await expect(page.locator("body")).not.toContainText(secret);
});

test("supports a separate reviewer and renders sanitized provider failures", async ({ page }) => {
  await page.route("**/api/session/research", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false, session: null, ownerDemo: false }) });
    const body = route.request().postDataJSON() as { reviewer?: { provider: string; model: string } };
    expect(body.reviewer).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
    return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, diagnostics: { primary: { ok: true }, reviewer: { ok: false, code: "provider_failure" }, openalex: { ok: true }, firecrawl: { ok: true } }, error: { message: "One or more providers rejected the bounded connection check." } }) });
  });
  await page.goto("/");
  await page.getByLabel(/Use a separate model/i).check();
  await page.getByLabel("Reviewer provider", { exact: true }).selectOption("gemini");
  await page.getByLabel("Research provider API key").fill("primary-secret");
  await page.getByLabel("Reviewer provider API key").fill("reviewer-secret");
  await page.getByLabel("OpenAlex API key").fill("openalex-secret");
  await page.getByLabel("Firecrawl API key").fill("firecrawl-secret");
  await page.getByRole("button", { name: /Verify and enter EvidenceForge/i }).click();
  await expect(page.locator(".credential-error")).toContainText("One or more providers rejected");
  await expect(page.getByLabel("Credential diagnostics")).toContainText("reviewer provider_failure");
});

test("renders deterministic demo controls only for an owner session", async ({ page }) => {
  await page.route("**/api/session/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, ownerDemo: false, session: { primary: { provider: "openai", model: "gpt-4.1-mini" }, reviewer: { provider: "openai", model: "gpt-4.1-mini" }, expiresAt: new Date(Date.now() + 60_000).toISOString() } }) }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Owner demo/i })).toHaveCount(0);
  await page.unroute("**/api/session/research");
  await page.route("**/api/session/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, ownerDemo: true, session: { primary: { provider: "openai", model: "gpt-4.1-mini" }, reviewer: { provider: "anthropic", model: "claude-sonnet-4-20250514" }, expiresAt: new Date(Date.now() + 60_000).toISOString() } }) }));
  await page.reload();
  await expect(page.getByRole("button", { name: /Owner demo/i })).toBeVisible();
});
