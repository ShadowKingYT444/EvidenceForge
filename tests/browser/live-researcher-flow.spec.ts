import { expect, test } from "@playwright/test";

test("welcomes researchers and explains the real workflow", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Make claims you can stand behind/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Start an investigation/i })).toBeVisible();
  await expect(page.getByText("Shape the claim")).toBeVisible();
  await expect(page.getByText("Build the packet")).toBeVisible();
  await expect(page.getByText("Make the call")).toBeVisible();
  expect(errors).toEqual([]);
});

test("creates a private investigation instead of opening the battery fixture", async ({ page }) => {
  await page.goto("/intake?example=ai-reliability");
  await expect(page.getByLabel("Research question")).toHaveValue(/retrieval-augmented generation/i);
  await page.getByRole("button", { name: /Begin investigation/i }).click();
  await page.waitForURL(/\/runs\/run-/u, { timeout: 20_000 });
  await expect(page.getByText("Private run")).toBeVisible();
  await expect(page.getByRole("heading", { name: /retrieval-augmented generation/i })).toBeVisible();
  await expect(page.getByText(/golden fixture|72-hour environmental sensor/iu)).toHaveCount(0);
});
