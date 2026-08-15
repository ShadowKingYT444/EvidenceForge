import { expect, test } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";

test.describe("conclusions and selected-gap inspector", () => {
  test("traces categorical conclusions and the recorded gap decision to evidence", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()}`);
    });

    await page.goto("/workbench#findings");

    const inspector = page.getByRole("region", {
      name: "Conclusions and selected research gap",
    });
    await expect(inspector).toBeVisible();
    await expect(
      inspector.getByRole("heading", { name: "Conclusions & gaps" }),
    ).toBeVisible();
    await expect(inspector.getByText("Conflicting", { exact: true })).toBeVisible();
    await expect(
      inspector.getByText("Insufficient evidence · abstain", { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.conclusions[0]!.disagreementSummary!),
    ).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.conclusions[0]!.limitations[0]!),
    ).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.conclusions[0]!.changeEvidence[0]!),
    ).toBeVisible();
    await expect(inspector.getByText(/confidence|probability/i)).toHaveCount(0);
    await expect(inspector.getByText(/\d+%/)).toHaveCount(0);

    const selectionRecord = inspector.getByLabel("Human selection record");
    await expect(
      selectionRecord.getByRole("heading", { name: "Human selection record" }),
    ).toBeVisible();
    await expect(
      selectionRecord.getByText("Gap 01 · selected", { exact: true }),
    ).toBeVisible();
    await expect(
      selectionRecord.getByText(
        goldenRunV01.researchGaps[0]!.impactRationale,
        { exact: true },
      ),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("interim-conclusions-gap-desktop.png"),
      fullPage: true,
    });
    await expect(
      selectionRecord.getByText(
        goldenRunV01.researchGaps[0]!.tractabilityRationale,
        { exact: true },
      ),
    ).toBeVisible();

    const evidenceLink = inspector.getByRole("link", {
      name: /Open evidence gf-evidence-01/,
    }).first();
    await evidenceLink.focus();
    await expect(evidenceLink).toBeFocused();
    await evidenceLink.click();
    await expect(page).toHaveURL(/evidence=gf-evidence-01/);
    const drawer = page.getByRole("dialog", { name: "Evidence details" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("tab", { name: "Audit" }).click();
    await expect(drawer.getByText(/gf-evidence-01/)).toBeVisible();
    await page.waitForLoadState("networkidle");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench#findings");
    await expect(inspector).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("interim-conclusions-gap-mobile.png"),
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
