import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test.describe("claim-by-source evidence matrix", () => {
  test("renders a semantic source-of-truth matrix with labeled relationship controls", async ({ page }) => {
    await page.goto("/workbench");

    const matrix = page.getByRole("region", { name: "Claim by source evidence matrix" });
    await expect(matrix.getByRole("table", { name: "Claim by source evidence relationships" })).toBeVisible();
    await expect(matrix.getByRole("rowheader")).toHaveCount(3);
    await expect(matrix.getByRole("columnheader")).toHaveCount(8);
    await expect(matrix.getByRole("button", { name: /Contradicts.*1 evidence.*Metadata mismatch/ })).toBeVisible();
    await expect(matrix.getByRole("button", { name: /Supports.*1 evidence.*Warning/ }).first()).toBeVisible();
    await expect(matrix.getByRole("button", { name: /Unresolved.*1 evidence/ }).first()).toBeVisible();
    await expect(matrix.getByRole("button", { name: /Missing evidence.*0 evidence/ }).first()).toBeVisible();
  });

  test("uses arrow keys to select a cell, opens exact evidence, and returns focus on close", async ({ page }) => {
    await page.goto("/workbench");

    const matrix = page.getByRole("region", { name: "Claim by source evidence matrix" });
    const first = matrix.getByRole("button", { name: /Claim 1.*Source 1/ });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    const second = matrix.getByRole("button", { name: /Claim 1.*Source 2/ });
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");

    const detail = page.getByRole("dialog", { name: /Evidence verification.*Claim 1.*Source 2/ });
    await expect(detail).toHaveAttribute("aria-modal", "false");
    await expect(detail.getByRole("heading", { name: /Evidence verification.*Claim 1.*Source 2/ })).toBeFocused();
    await expect(detail.getByText("gf-evidence-02", { exact: true })).toBeVisible();
    const secondCard = goldenRunV01.evidenceCards[1]!;
    const secondChunk = goldenRunV01.chunks.find(({ id }) => id === secondCard.sourceChunkId)!;
    await expect(detail.locator("blockquote")).toHaveText(secondCard.excerpt);
    await expect(detail.locator("p").filter({ hasText: secondChunk.location })).toContainText("full text");
    await expect(detail.getByRole("heading", { name: "Source ledger" })).toBeVisible();
    await expect(detail.getByText("Identifier resolution", { exact: true })).toBeVisible();
    await expect(detail.getByText("Registration Agency", { exact: true })).toBeVisible();
    await expect(detail.getByText("Crossref", { exact: true })).toBeVisible();
    await expect(detail.getByText("Metadata comparison", { exact: true })).toBeVisible();
    await expect(detail.getByText("Integrity notices", { exact: true })).toBeVisible();
    await expect(detail.getByText("No integrity notice records in this packet.", { exact: true })).toBeVisible();
    await expect(detail.getByText("Deterministic passage check", { exact: true })).toBeVisible();
    await expect(detail.getByText("Model entailment", { exact: true })).toBeVisible();
    await expect(detail.getByText("Human review", { exact: true })).toBeVisible();
    await expect(detail.locator("p").filter({ hasText: goldenRunV01.evidenceCards[1]!.limitation })).toBeVisible();
    await expect(detail.locator("p").filter({ hasText: goldenRunV01.evidenceCards[1]!.conclusionStrengthWarning! })).toBeVisible();
    await page.getByRole("heading", { name: "Claim × source matrix" }).click();
    await expect(detail).toBeVisible();
    await detail.getByRole("heading", { name: /Evidence verification.*Claim 1.*Source 2/ }).focus();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(second).toBeFocused();

    await page.keyboard.press("ArrowRight");
    const third = matrix.getByRole("button", { name: /Claim 1.*Source 3/ });
    await expect(third).toBeFocused();
    await page.keyboard.press(" ");
    const thirdDetail = page.getByRole("dialog", { name: /Evidence verification.*Claim 1.*Source 3/ });
    await expect(thirdDetail.getByRole("heading", { name: /Evidence verification.*Claim 1.*Source 3/ })).toBeFocused();
    await expect(thirdDetail.getByText("gf-evidence-03", { exact: true })).toBeVisible();
    await thirdDetail.getByRole("button", { name: "Close evidence drawer" }).press("Enter");
    await expect(third).toBeFocused();
  });

  test("keeps denied excerpts hidden and explains the rights boundary", async ({ page }, testInfo) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("http://127.0.0.1:3100/")) externalRequests.push(request.url());
    });
    await page.goto("/workbench?packet=denied");
    const matrix = page.getByRole("region", { name: "Claim by source evidence matrix" });
    const denied = matrix.getByRole("button", { name: /Claim 1.*Source 1/ });
    await denied.click();
    const detail = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(detail.getByText("Display permission is denied; source text is not rendered.")).toBeVisible();
    await expect(detail.locator("blockquote")).toHaveCount(0);
    await expect(detail.getByText("Source ledger details are hidden by the same display-rights boundary.", { exact: true })).toBeVisible();
    await expect(detail.getByRole("link")).toHaveCount(0);
    const deniedCard = goldenRunV01.evidenceCards[0]!;
    const deniedSource = goldenRunV01.sources[0]!;
    const forbidden = [
      deniedCard.excerpt,
      deniedCard.extractedResult,
      deniedCard.limitation,
      deniedCard.conclusionStrengthWarning!,
      deniedCard.modelAssessment.rationale,
      deniedCard.humanReview.reason!,
      deniedSource.bibliographicMetadata.title,
      deniedSource.canonicalDoi!,
      deniedSource.doiResolution.registrationAgency!,
      deniedSource.metadataVerification.fieldDiffs[0]!.observed!,
    ];
    const matrixText = await matrix.innerText();
    const matrixDocument = await matrix.evaluate((element) => element.outerHTML);
    const accessibilityText = `${await matrix.ariaSnapshot()}\n${await detail.ariaSnapshot()}`;
    for (const value of forbidden) {
      expect(matrixText).not.toContain(value);
      expect(accessibilityText).not.toContain(value);
      const alsoBelongsToAllowedCard = goldenRunV01.evidenceCards
        .slice(1)
        .some((card) => JSON.stringify(card).includes(value));
      if (!alsoBelongsToAllowedCard) {
        expect(matrixDocument).not.toContain(value);
      }
    }
    expect(externalRequests).toEqual([]);
    await detail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("interim-evidence-drawer-denied.png") });
  });

  test("keeps multiple cards, mixed relationships, failures, and metadata mismatch as separate ledger records", async ({ page }) => {
    await page.goto("/workbench?matrix=duplicate");
    const duplicateCell = page.getByRole("button", { name: /2 evidence.*Multiple evidence records/ });
    await duplicateCell.click();
    const duplicateDrawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(duplicateDrawer.getByRole("heading", { name: "Source ledger" })).toHaveCount(1);
    await expect(duplicateDrawer.locator("article")).toHaveCount(2);

    await page.goto("/workbench?matrix=failure");
    const failureCell = page.getByRole("button", {
      name: /Contradicts.*Verification failure.*Metadata mismatch/,
    });
    await failureCell.click();
    const failureDrawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(failureDrawer.getByText("Deterministic passage check", { exact: true })).toBeVisible();
    await expect(failureDrawer.getByText("Status: failed", { exact: true })).toBeVisible();
    await expect(failureDrawer.getByText("Metadata comparison", { exact: true })).toBeVisible();
    await expect(failureDrawer.getByText("Metadata mismatch", { exact: true })).toBeVisible();
    const notice = failureDrawer.getByRole("link", { name: "Open notice" });
    await expect(failureDrawer.getByText("Integrity notices", { exact: true })).toBeVisible();
    await expect(notice).toHaveAttribute("href", "https://example.test/integrity-update");
    await expect(notice).toHaveAttribute("rel", /noreferrer/);
  });

  test("announces simultaneous failure and mismatch warnings without replacing the relationship", async ({ page }) => {
    await page.goto("/workbench?matrix=failure");
    const cell = page.getByRole("button", {
      name: /Contradicts.*Verification failure · Metadata mismatch/,
    });
    await expect(cell).toBeVisible();
    await expect(cell.locator('[data-warning="failure"]')).toContainText("Verification failure");
    await expect(cell.locator('[data-warning="mismatch"]')).toContainText("Metadata mismatch");
  });

  test("renders explicit loading, empty, error, duplicate, long-content, failure, and missing states", async ({ page }) => {
    const documentStates = [
      ["loading", "Loading evidence matrix"],
      ["empty", "No claim or source relationships"],
      ["error", "Evidence matrix unavailable"],
      ["long-content", "Long-content matrix preview"],
    ] as const;

    for (const [scenario, label] of documentStates) {
      await page.goto(`/workbench?matrix=${scenario}`);
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    await page.goto("/workbench?matrix=duplicate");
    await expect(page.getByRole("button", { name: /2 evidence.*Multiple evidence records/ })).toBeVisible();
    await page.goto("/workbench?matrix=failure");
    await expect(page.getByRole("button", { name: /Verification failure/ })).toBeVisible();
    await page.goto("/workbench?matrix=missing-evidence");
    await expect(page.getByRole("button", { name: /Missing evidence.*0 evidence/ }).first()).toBeVisible();

    await page.goto("/workbench?matrix=long-content");
    const longCell = page.getByRole("button", { name: /Claim 1.*Source 1/ });
    await longCell.click();
    const drawer = page.getByRole("dialog", { name: /Evidence verification/ });
    const untrusted = '</script><img data-evf-untrusted src="x" onerror="alert(1)">';
    await expect(drawer.locator("p").filter({ hasText: untrusted })).toBeVisible();
    await expect(page.locator("[data-evf-untrusted]")).toHaveCount(0);
  });

  test("is usable at desktop, 200% effective zoom, mobile, and reduced motion without page overflow", async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => failedRequests.push(request.url()));

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/workbench");
    await page.getByRole("region", { name: "Claim by source evidence matrix" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: /Claim 1.*Source 1/ }).click();
    const desktopDrawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(desktopDrawer).toBeVisible();
    expect(await hasPageOverflow(page)).toBe(false);
    await desktopDrawer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("interim-evidence-drawer-1280x720.png") });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await page.setViewportSize({ width: 640, height: 360 });
    expect(await hasPageOverflow(page)).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?matrix=failure");
    await page.getByRole("button", { name: /Claim 1.*Source 1/ }).click();
    await expect(page.getByRole("dialog", { name: /Evidence verification/ })).toBeVisible();
    expect(await hasPageOverflow(page)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("interim-evidence-drawer-mobile-failure.png"), fullPage: true });

    await page.addScriptTag({ path: axeScriptPath });
    const serious = await page.evaluate(async () => {
      const result = await (window as unknown as { axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run();
      return result.violations.filter(({ impact }) => impact === "critical" || impact === "serious");
    });
    expect(serious).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});

async function hasPageOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
