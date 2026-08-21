import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("completes the three-minute Epistemic CI judge path", async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Try the demo/ }).click();
  const fixtureHashLabel = await page.locator("header code").first().textContent();

  await page.getByRole("button", { name: "Compile conclusion" }).click();
  await expect(page.getByRole("heading", { name: "Typed build failures" })).toBeVisible();
  await expect(page.getByText("CONFLICTING_EVIDENCE", { exact: true })).toBeVisible();
  await expect(page.getByText("None", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Test evidence changes" }).click();
  await expect(page.getByRole("heading", { name: /Change the evidence/ })).toBeVisible();
  await page.getByRole("button", { name: /Remove drying contradiction/ }).click();
  const firstTransition = page.getByText("Deleting negative evidence did not create positive evidence.").locator("..");
  await expect(firstTransition).toBeVisible();
  await expect(firstTransition.getByText("insufficient", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Add direct loaded 72-hour result/ }).click();
  const secondTransition = page.getByText("Direct loaded evidence resolves duration—not the replacement decision.").locator("..");
  await expect(secondTransition).toBeVisible();
  await expect(secondTransition.getByText("supported", { exact: true })).toBeVisible();
  await expect(page.getByText("Loaded-duration experiment is now obsolete.")).toBeVisible();
  await expect(page.getByText("failing", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Open Research PR" }).click();
  await expect(page.getByRole("heading", { name: "Semantic diff" })).toBeVisible();
  const compilerChecks = page.getByRole("heading", { name: "Compiler tests" }).locator("..").locator("..");
  await expect(compilerChecks.getByText("Comparator adequacy", { exact: true })).toBeVisible();
  await expect(compilerChecks.getByText("Degradation-product safety", { exact: true })).toBeVisible();

  await page.getByLabel("Declared actor").fill("Judge-path reviewer");
  await page.getByLabel("Authorization rationale").fill("Authorize the branch evidence update while preserving the scientific blockers.");
  await page.getByRole("button", { name: /Authorize evidence update/ }).click();
  await expect(page.getByTestId("research-pr-receipt")).toContainText("Judge-path reviewer");
  await expect(page.getByTestId("research-pr-receipt")).toContainText("Scientific decision");
  await expect(page.getByTestId("research-pr-receipt")).toContainText("Not approved");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Research PR receipt" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/research-pr\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    schemaVersion: string;
    graphHash: string;
    appliedChangeIds: string[];
  };
  expect(exported).toMatchObject({
    schemaVersion: "epistemic-ci.v1",
    appliedChangeIds: ["remove-drying-contradiction", "add-direct-loaded-72h"],
  });
  expect(exported.graphHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.locator("header code").first()).toHaveText(fixtureHashLabel!);
});

test("opens node details and redirects the legacy workbench", async ({ page }) => {
  await page.goto("/workbench");
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: /Try the demo/ }).click();
  await page.getByRole("button", { name: "Compile conclusion" }).click();
  await page.getByRole("button", { name: /gf-evidence-02/ }).click();
  const passageDialog = page.getByRole("dialog", { name: /gf-evidence-02/ });
  await expect(passageDialog.locator("blockquote")).not.toBeEmpty();
  await expect(passageDialog.getByText("Deterministic verification", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Unloaded-to-loaded equivalence/ }).click();
  const dialog = page.getByRole("dialog", { name: /Unloaded-to-loaded equivalence/ });
  await expect(dialog.getByText("Deterministic verification", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Model assessment", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Human decision", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
