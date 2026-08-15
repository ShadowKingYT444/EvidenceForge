import { expect, test } from "@playwright/test";

import { expectContainedFocus } from "./focus-boundary";

test.describe("Sparse dark workstation", () => {
  test("keeps the demo entry and scope preview compact", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Connect a model provider" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Use recorded fixture/ })).toHaveAttribute("href", "/intake?demo=golden");
    await expect(page.getByRole("link", { name: "Inspect the evidence chain" })).toHaveCount(0);

    await page.goto("/intake?demo=golden");
    await expect(page.getByRole("link", { name: "Open recorded demo" })).toBeVisible();
    const editScope = page.getByRole("button", { name: "Edit scope" });
    await expect(editScope).toBeVisible();
    await expect(page.locator("textarea")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("sparse-intake-1280x720.png") });
    await editScope.click();
    const scopeEditor = page.getByRole("dialog", { name: "Edit scope" });
    await expect(scopeEditor).toBeVisible();
    await expectContainedFocus({
      page,
      boundary: scopeEditor,
      initialFocus: scopeEditor.getByLabel("Research question"),
      trigger: editScope,
    });
  });

  test("uses on-demand evidence detail and an expert view menu", async ({ page }, testInfo) => {
    await page.goto("/workbench#evidence");
    await expect(page.getByRole("complementary", { name: "Evidence inspector" })).toHaveCount(0);
    const evidence = page.getByRole("region", { name: "Evidence" });
    await expect(evidence.locator("[data-active-claim]")).toHaveCount(1);
    await expect(evidence.getByLabel("Select claim")).toBeVisible();
    await evidence.getByLabel("Select claim").selectOption({ label: "Claim 2" });
    await expect(evidence.locator("[data-active-claim]")).toContainText("Claim 2");
    await page.screenshot({ path: testInfo.outputPath("sparse-evidence-1280x720.png") });
    const relationship = page.getByRole("button", { name: /Inspect .* relationship/ }).first();
    await relationship.click();
    const detail = page.getByRole("dialog", { name: "Evidence details" });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("tab", { name: "Evidence" })).toBeVisible();
    await expect(detail.getByRole("tab", { name: "Review" })).toBeVisible();
    await expect(detail.getByRole("tab", { name: "Audit" })).toBeVisible();
    await expectContainedFocus({
      page,
      boundary: detail,
      initialFocus: detail.getByRole("button", { name: "Close evidence details" }),
      trigger: relationship,
    });
    const viewTrigger = page.getByRole("button", { name: "View" });
    await viewTrigger.click();
    const viewMenu = page.getByRole("menu", { name: "Evidence view menu" });
    const ledgerItem = viewMenu.getByRole("menuitem", { name: "Ledger" });
    const matrixItem = viewMenu.getByRole("menuitem", { name: "Matrix" });
    await expect(ledgerItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(matrixItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(ledgerItem).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(matrixItem).toBeFocused();
    await page.keyboard.press("Home");
    await expect(ledgerItem).toBeFocused();
    await page.keyboard.press("End");
    await expect(matrixItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(viewMenu).toHaveCount(0);
    await expect(viewTrigger).toBeFocused();

    await viewTrigger.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(viewMenu).toHaveCount(0);
    await expect(viewTrigger).toBeFocused();

    await viewTrigger.click();
    await page.keyboard.press("Tab");
    await expect(viewMenu).toHaveCount(0);
    await expect(viewTrigger).not.toBeFocused();
    await expect(page.locator("body")).not.toBeFocused();

    await viewTrigger.focus();
    await viewTrigger.click();
    await page.keyboard.press("Shift+Tab");
    await expect(viewMenu).toHaveCount(0);
    await expect(viewTrigger).not.toBeFocused();
    await expect(page.locator("body")).not.toBeFocused();

    await viewTrigger.focus();
    await viewTrigger.click();
    await expect(ledgerItem).toBeFocused();
    await page.keyboard.press("Space");
    await expect(viewMenu).toHaveCount(0);
    await expect(viewTrigger).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench#evidence");
    const workSurface = page.getByRole("region", { name: "Current research stage" });
    await expect(workSurface).toBeVisible();
    await page.getByLabel("Select claim").selectOption({ label: "Claim 2" });
    const activeClaim = page.locator("[data-active-claim]");
    await expect(activeClaim).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await workSurface.evaluate((surface) => surface.scrollWidth <= surface.clientWidth)).toBe(true);
    const claimBox = await activeClaim.getByRole("heading", { level: 2 }).boundingBox();
    expect(claimBox).not.toBeNull();
    expect(claimBox!.x).toBeGreaterThanOrEqual(0);
    expect(claimBox!.x + claimBox!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("sparse-evidence-mobile.png"), fullPage: true });
  });
});
