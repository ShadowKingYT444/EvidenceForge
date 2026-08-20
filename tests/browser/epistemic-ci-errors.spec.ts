import { expect, test, type Page } from "@playwright/test";

async function reachReview(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Use deterministic battery demo instead/ }).click();
  await page.getByRole("button", { name: "Compile conclusion" }).click();
  await page.getByRole("button", { name: "Test evidence changes" }).click();
  await page.getByRole("button", { name: /Remove drying contradiction/ }).click();
  await page.getByRole("button", { name: /Add direct loaded 72-hour result/ }).click();
  await page.getByRole("button", { name: "Open Research PR" }).click();
}

function productAlert(page: Page) {
  return page.locator('section[role="alert"]');
}

test("retries a failed demo load", async ({ page }) => {
  let fail = true;
  await page.route("**/api/epistemic-ci/demo", async (route) => {
    if (!fail) return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Fixture projection unavailable." } }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Use deterministic battery demo instead/ }).click();
  await expect(productAlert(page)).toContainText("Fixture projection unavailable.");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Compile conclusion" })).toBeVisible();
});

test("fails closed on an invalid server projection", async ({ page }) => {
  await page.route("**/api/epistemic-ci/demo", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: "epistemic-ci.v1" }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Use deterministic battery demo instead/ }).click();
  await expect(productAlert(page)).toContainText("Invalid server projection");
  await expect(page.getByText(/did not match the Epistemic CI contract/i)).toBeVisible();
});

test("fails closed on a stale review hash and reloads the immutable base", async ({ page }) => {
  await reachReview(page);
  await page.route("**/api/epistemic-ci/review", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "STALE_GRAPH",
          message: "The graph changed; recompile before reviewing.",
          expectedGraphHash: "a".repeat(64),
          actualGraphHash: "b".repeat(64),
        },
      }),
    });
  });
  await page.getByRole("button", { name: /Authorize evidence update/ }).click();
  await expect(productAlert(page)).toContainText("Build is stale");
  await page.getByRole("button", { name: "Reload immutable base" }).click();
  await expect(page.getByRole("button", { name: "Compile conclusion" })).toBeVisible();
});

test("preserves the receipt when browser export fails", async ({ page }) => {
  await page.addInitScript(() => {
    URL.createObjectURL = () => {
      throw new Error("download unavailable");
    };
  });
  await reachReview(page);
  await page.getByRole("button", { name: /Authorize evidence update/ }).click();
  await expect(page.getByTestId("research-pr-receipt")).toBeVisible();
  await page.getByRole("button", { name: "Download Research PR receipt" }).click();
  await expect(productAlert(page)).toContainText("Export failed");
  await expect(page.getByTestId("research-pr-receipt")).toBeVisible();
});
