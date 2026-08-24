import { expect, test } from "@playwright/test";

test("opens a focused research composer without marketing clutter", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.route("**/api/session/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, ownerDemo: false, session: { primary: { provider: "openai", model: "gpt-4.1-mini" }, reviewer: { provider: "openai", model: "gpt-4.1-mini" }, expiresAt: new Date(Date.now() + 60_000).toISOString() } }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Test a claim against the evidence/i })).toBeVisible();
  await expect(page.getByLabel("Research question")).toBeVisible();
  await expect(page.getByLabel("Decision this will inform")).toBeVisible();
  await expect(page.getByText("Add boundaries")).toBeVisible();
  await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);
  await expect(page.getByLabel("Prompt examples").getByRole("button")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("creates a private investigation instead of opening the battery fixture", async ({ page }) => {
  const runId = "ai-reliability-run";
  const question = "Does retrieval-augmented generation reduce factual hallucination in knowledge-grounded language generation compared with the same model without retrieval?";
  await page.context().addCookies([{ name: "evidenceforge_research_session", value: "browser-session", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 3100}` }]);
  await page.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", evidenceMode: "live", liveInvestigationsReady: true, reasonCodes: [] }) }));
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: { id: runId }, revision: "revision-1" }) });
  });
  await page.route(`**/api/runs/${runId}/continue`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshot: { run: { id: runId, status: "awaiting_scope_approval" }, revision: "revision-2" }, advanced: true }) }));
  await page.route(`**/api/runs/${runId}/progress`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "awaiting_scope_approval", revision: "revision-2" }) }));
  await page.route(`**/api/runs/${runId}/sources`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ draft: { sources: [] }, revision: "revision-2" }) }));
  await page.route(`**/api/runs/${runId}/timeline`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) }));
  await page.route(`**/api/runs/${runId}`, async (route) => {
    if (!route.request().url().endsWith(`/api/runs/${runId}`)) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { id: runId, status: "awaiting_scope_approval", evidenceMode: "live", intake: { originalQuestion: question, intendedApplication: "Choose an evidence-grounding architecture." }, claims: [] }, revision: "revision-2" }) });
  });
  await page.goto("/intake?example=ai-reliability");
  await expect(page.getByLabel("Research question")).toHaveValue(/retrieval-augmented generation/i);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Begin investigation/i }).click();
  await page.waitForURL(`/runs/${runId}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /retrieval-augmented generation/i })).toBeVisible();
  await expect(page.getByText(/golden fixture|72-hour environmental sensor/iu)).toHaveCount(0);
});

test("rejects run creation without a credential session", async ({ request }) => {
  const response = await request.post("/api/runs", { data: { expectedRevision: null, intake: { originalQuestion: "Does retrieval improve factual reliability?", intendedApplication: "Choose an architecture.", populationOrGeography: "Technical systems", timeHorizon: "Current evidence", availableMaterialsOrBudget: "Bounded search", desiredDepth: "Evidence packet", constraints: [], unansweredClarifications: [] } } });
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "research_session_required" } });
});
