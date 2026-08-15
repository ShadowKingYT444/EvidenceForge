import { expect, test } from "@playwright/test";

import { expectContainedFocus } from "./focus-boundary";

test.describe("Scientific Workstation demo journey", () => {
  test("preloads an honest editable golden scope and opens the recorded demo", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/intake?demo=golden");

    await expect(
      page.getByText("Recorded demo · editable fixture copy", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open recorded demo" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("guided-fixture-intake-1280x720.png"),
    });

    await page.getByRole("link", { name: "Open recorded demo" }).click();
    await expect(page).toHaveURL(/\/workbench#evidence$/);
  });

  test("deep-links eight stages and keeps one primary canvas active", async ({
    page,
  }, testInfo) => {
    await page.goto("/workbench#scope");

    const stages = page.getByRole("navigation", {
      name: "Research workflow stages",
    });
    const destinations = [
      ["01 Scope", "scope"],
      ["02 Packet", "packet"],
      ["03 Evidence", "evidence"],
      ["04 Findings", "findings"],
      ["05 Experiment", "experiment"],
      ["06 Review", "review"],
      ["07 Audit", "audit"],
      ["08 Decision", "decision"],
    ] as const;

    for (const [name, hash] of destinations) {
      const stageLink = stages.getByRole("link", { name });
      await expect(stageLink).toHaveAttribute("href", `#${hash}`);
      await stageLink.click();
      await expect(page).toHaveURL(new RegExp(`#${hash}$`));
      await expect(page.locator('[data-stage-panel]:not([hidden])')).toHaveCount(1);
      await expect(
        page.locator(`[data-stage-panel="${hash}"]`),
      ).toBeVisible();
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/workbench#evidence");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.screenshot({
      path: testInfo.outputPath("scientific-workstation-evidence-1280x720.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench#evidence");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("scientific-workstation-evidence-mobile.png"),
      fullPage: true,
    });
  });

  test("uses a deterministic command palette and returns focus from evidence inspection", async ({
    page,
  }) => {
    await page.goto("/workbench#evidence");

    const viewTrigger = page.getByRole("button", { name: "View" });
    await viewTrigger.click();
    await page.getByRole("menuitem", { name: "Matrix" }).click();
    await expect.soft(viewTrigger).toBeFocused();
    await expect(
      page.getByRole("table", { name: "Claim by source evidence relationships" }),
    ).toBeVisible();
    await viewTrigger.click();
    await page.getByRole("menuitem", { name: "Ledger" }).click();
    await expect.soft(viewTrigger).toBeFocused();

    const relationship = page
      .getByRole("button", { name: /Inspect .* relationship/ })
      .first();
    await relationship.click();
    const inspector = page.getByRole("dialog", { name: "Evidence details" });
    await expect(inspector).toBeVisible();
    for (const section of [
      "Summary", "Passage", "Mechanical checks",
    ]) {
      await expect(inspector.getByRole("heading", { name: section })).toBeVisible();
    }
    const evidenceTab = inspector.getByRole("tab", { name: "Evidence" });
    await evidenceTab.focus();
    await page.keyboard.press("Control+k");
    const nestedPalette = page.getByRole("dialog", {
      name: "Workbench command palette",
    });
    await expect(nestedPalette).toBeVisible();
    await expect(
      nestedPalette.getByPlaceholder("Search records or run a command"),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(nestedPalette).toHaveCount(0);
    await expect(inspector).toBeVisible();
    await expect(evidenceTab).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(relationship).toBeFocused();

    const commandTrigger = page.getByRole("button", { name: "Open command palette" });
    await commandTrigger.click();
    const escapePalette = page.getByRole("dialog", {
      name: "Workbench command palette",
    });
    await expectContainedFocus({
      page,
      boundary: escapePalette,
      initialFocus: escapePalette.getByPlaceholder("Search records or run a command"),
      trigger: commandTrigger,
    });

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", {
      name: "Workbench command palette",
    });
    await expect(palette).toBeVisible();
    const commandInput = palette.getByPlaceholder(
      "Search records or run a command",
    );
    await commandInput.fill("audit");
    await palette.getByRole("button", { name: "Go to Audit" }).click();
    await expect(page).toHaveURL(/#audit$/);
    await expect(page.locator('[data-stage-panel="audit"]')).toBeVisible();

    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder("Search records or run a command")
      .fill("demo states");
    await page.getByRole("button", { name: "Open Demo States" }).click();
    await expect(page.locator("details").filter({ hasText: "Simulated demo state" })).toHaveAttribute("open", "");

    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder("Search records or run a command")
      .fill("select contradictory");
    await page.getByRole("button", { name: "Select contradictory evidence" }).click();
    await expect(
      page.getByRole("dialog", { name: "Evidence details" }),
    ).toContainText("Contradicts");

    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder("Search records or run a command")
      .fill("filter evidence");
    await page.getByRole("button", { name: "Filter evidence to contradictions" }).click();
    await expect(page.getByText("Filtered to contradictions", { exact: true })).toBeVisible();

    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder("Search records or run a command")
      .fill("explain model");
    await page.getByRole("button", { name: "Explain model assessment" }).click();
    await expect(
      page.getByLabel("Workbench glossary explanation"),
    ).toContainText("never replaces the mechanical passage check");
  });

  test("dismisses evidence detail before command navigation changes stage", async ({
    page,
  }) => {
    await page.goto("/workbench#evidence");
    await page
      .getByRole("button", { name: /Inspect .* relationship/ })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: "Evidence details" })).toBeVisible();

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", {
      name: "Workbench command palette",
    });
    await palette
      .getByPlaceholder("Search records or run a command")
      .fill("audit");
    await palette.getByRole("button", { name: "Go to Audit" }).click();

    await expect(page).toHaveURL(/#audit$/);
    await expect(page.getByRole("dialog", { name: "Evidence details" })).toHaveCount(0);
    const auditPanel = page.locator('[data-stage-panel="audit"]');
    await expect(auditPanel).toBeVisible();
    const auditDisclosure = auditPanel.locator("summary").first();
    await auditDisclosure.focus();
    await expect(auditDisclosure).toBeFocused();
  });
});
