import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireFromA11yPlugin = createRequire(require.resolve("eslint-plugin-jsx-a11y/package.json"));
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test("opens the sparse provider workspace with a truthful fixture escape hatch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Connect a model provider" })).toBeVisible();
  await expect(page.getByRole("button", { name: /OpenAI \/ Codex/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Featherless/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Use recorded fixture/ })).toHaveAttribute("href", "/intake?demo=golden");
});

test("keeps onboarding responsive, keyboard-visible, and accessible", async ({ page }, testInfo) => {
  for (const viewport of [{ width: 1280, height: 720, name: "desktop" }, { width: 390, height: 844, name: "mobile" }, { width: 640, height: 360, name: "compact" }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`provider-onboarding-${viewport.name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.addScriptTag({ path: axeScriptPath });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run();
    return result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  });
  expect(violations).toEqual([]);
});
