import { expect, test } from "@playwright/test";

const runId = "visual-source-run";

function source(index: number) {
  return {
    source: {
      id: `source-${index}`,
      bibliographicMetadata: { title: `Research source ${index}` },
      access: { provider: "OpenAlex" },
    },
    chunks: [{ id: `chunk-${index}` }, { id: `chunk-${index}-b` }],
  };
}

function verification(count: number) {
  return {
    status: count === 10 ? "ready" : "shortfall",
    targetPassages: 10,
    passages: Array.from({ length: count }, (_, index) => ({
      id: `passage-${index + 1}`,
      sourceId: `source-${(index % 5) + 1}`,
      subclaimId: "claim-1",
      excerpt: `Literal verified reward-hacking passage ${index + 1} tied to the approved claim.`,
    })),
    claimsMissing: count === 10 ? [] : ["claim-1"],
    rejectionCounts: { offTopic: 8, rightsIneligible: 2, primaryRejected: 3, reviewerRejected: 1, providerFailure: 0 },
  };
}

async function mockSourceWorkspace(page: import("@playwright/test").Page) {
  const run = {
    id: runId,
    status: "collecting_sources",
    evidenceMode: "live",
    intake: {
      originalQuestion: "Can reward hacking be prevented when another model judges sparse-data responses?",
      intendedApplication: "Choose a robust evaluator design for model training.",
      constraints: ["Sparse human labels", "Model-graded responses"],
    },
    claims: [{ id: "claim-1", statement: "Reward hacking can be detected by an independent evaluator.", operationalDefinition: "Evaluator identifies proxy optimization." }],
  };
  let draft = { sources: [1, 2, 3, 4].map(source), verification: verification(4) };
  await page.route(`**/api/runs/${runId}/progress`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "collecting_sources", revision: "revision-1" }) }));
  await page.route(`**/api/runs/${runId}/sources`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ draft, revision: "revision-1" }) }));
  await page.route(`**/api/runs/${runId}/sources/auto`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ expectedRevision: "revision-1", mode: "deeper" });
    draft = { sources: [1, 2, 3, 4, 5].map(source), verification: verification(10) };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ draft, revision: "revision-1", collection: { ...draft.verification, verifiedPassages: 10, blocked: false } }) });
  });
  await page.route(`**/api/runs/${runId}/timeline`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [{ id: "event-1", at: "12:00", label: "Scope approved", stage: "scope" }] }) }));
  await page.route(`**/api/runs/${runId}`, async (route) => {
    if (!route.request().url().endsWith(`/api/runs/${runId}`)) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run, revision: "revision-1" }) });
  });
}

test("keeps source collection focused and moves secondary tools into drawers", async ({ page }, testInfo) => {
  await mockSourceWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole("heading", { name: /reward hacking/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collect the signal" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Dual-model verified passages" })).toHaveAttribute("aria-valuenow", "4");
  await expect(page.getByRole("button", { name: "Search deeper" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Freeze/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("source-workspace-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Add a source" }).click();
  const sourceDrawer = page.getByRole("dialog", { name: "Add a source" });
  await expect(sourceDrawer).toBeVisible();
  await expect(sourceDrawer.getByRole("tab", { name: "search" })).toHaveAttribute("aria-selected", "true");
  await sourceDrawer.getByRole("button", { name: "Close Add a source" }).click();

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("dialog", { name: "Activity and provenance" })).toContainText("Scope approved");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Search deeper" }).click();
  await expect(page.getByRole("progressbar", { name: "Dual-model verified passages" })).toHaveAttribute("aria-valuenow", "10");
  await expect(page.getByRole("button", { name: "Freeze 10 verified passages" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Investigation stages" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("source-workspace-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
