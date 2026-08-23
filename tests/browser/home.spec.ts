import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireFromA11yPlugin = createRequire(require.resolve("eslint-plugin-jsx-a11y/package.json"));
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test("opens live bounded research on the normal route with a deterministic fallback", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Test a claim against the evidence/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start investigation/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Try the demo/ })).toBeVisible();
  await expect(page.getByText(/searches scholarly literature, verifies exact passages/i)).toBeVisible();
  await expect(page.getByRole("list", { name: "Investigation workflow" })).toContainText("Scope");
});

test("starts a private live run from the default workspace entry", async ({ page }) => {
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: { id: "live-browser-run" }, revision: "revision-1" }),
    });
  });
  await page.route("**/api/runs/live-browser-run/continue", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ snapshot: { run: { id: "live-browser-run", status: "awaiting_scope_approval" }, revision: "revision-2" }, advanced: true }),
    });
  });
  await page.goto("/");
  await page.getByLabel("Research question").fill("Does a sodium-ion battery improve cold-weather storage reliability?");
  await page.getByLabel("Decision this will inform").fill("Choose a storage chemistry for a remote sensor design.");
  await page.getByRole("button", { name: /Start investigation/ }).click();
  await expect(page).toHaveURL(/\/runs\/live-browser-run$/);
});

test("keeps the CI workspace responsive, keyboard-visible, and accessible", async ({ page }, testInfo) => {
  for (const viewport of [{ width: 1280, height: 720, name: "desktop" }, { width: 375, height: 812, name: "mobile" }, { width: 640, height: 360, name: "compact" }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`live-epistemic-ci-${viewport.name}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.addScriptTag({ path: axeScriptPath });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run();
    return result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  });
  expect(violations).toEqual([]);
});
