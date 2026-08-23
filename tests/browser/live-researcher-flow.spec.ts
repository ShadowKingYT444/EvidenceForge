import { expect, test } from "@playwright/test";

test("opens a focused research composer without marketing clutter", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Test a claim against the evidence/i })).toBeVisible();
  await expect(page.getByLabel("Research question")).toBeVisible();
  await expect(page.getByLabel("Decision this will inform")).toBeVisible();
  await expect(page.getByText("Add boundaries")).toBeVisible();
  await expect(page.getByRole("button", { name: /Try the demo/i })).toBeVisible();
  await expect(page.getByLabel("Prompt examples").getByRole("button")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("creates a private investigation instead of opening the battery fixture", async ({ page }) => {
  const runId = "ai-reliability-run";
  const question = "Does retrieval-augmented generation reduce factual hallucination in knowledge-grounded language generation compared with the same model without retrieval?";
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

test("blocks run creation when live scholarly search is not configured", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/api/health", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ status: "degraded", evidenceMode: "live", liveInvestigationsReady: false, reasonCodes: ["openalex_key_missing"] }) }));
  await page.route("**/api/runs", async (route) => { createRequests += 1; await route.fulfill({ status: 500 }); });
  await page.goto("/");
  await page.getByLabel("Research question").fill("Does bounded retrieval improve factual reliability in technical assistants?");
  await page.getByLabel("Decision this will inform").fill("Choose a retrieval architecture.");
  await page.getByRole("button", { name: /Start investigation/i }).click();
  await expect(page.getByText("Live scholarly search is not configured.", { exact: true })).toBeVisible();
  expect(createRequests).toBe(0);
  await expect(page.getByRole("button", { name: /Try the demo/i })).toBeVisible();
});
