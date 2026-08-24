import { expect, test } from "@playwright/test";

test("replays the prerecorded RAG investigation through the normal evidence flow", async ({ page }) => {
  const consoleErrors: string[] = [];
  const runRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => { if (request.url().includes("/api/runs")) runRequests.push(request.url()); });

  await page.goto("/");
  await page.getByRole("button", { name: /Retrieval vs. hallucination · recorded demo/i }).click();
  await expect(page).toHaveURL(/\/demo\/rag$/);
  await expect(page.getByText("Recorded demo", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Does retrieval-augmented generation reduce factual hallucination/i })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/Loading|Replaying|Screening|Importing|Hashing|Applying|review|ready/i);
  await expect(page.getByRole("button", { name: "Narrate replay" })).toBeVisible();
  await page.getByRole("button", { name: "Skip replay" }).click();
  await expect(page.getByRole("status")).toContainText("Evidence packet ready");

  await expect(page.getByRole("table", { name: "Frozen scholarly source packet" }).locator("tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: /Evidence/ }).click();
  await expect(page.getByText("Exact passages with distinct verification layers")).toBeVisible();
  await expect(page.locator("button").filter({ hasText: "Text + provenance" })).toHaveCount(10);

  await page.getByRole("button", { name: /Review/ }).click();
  await expect(page.getByText("What could change the conclusion")).toBeVisible();
  await expect(page.getByText(/Unresolved · retained in decision record/)).toBeVisible();

  await page.getByRole("button", { name: /Decision/ }).click();
  await expect(page.getByText("Adopt RAG with evidence-quality gates")).toBeVisible();
  await expect(page.getByText(/Retrieval augmentation can reduce hallucination and improve factuality/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(runRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
