import { createRequire } from "node:module";

import { expect, test, type Locator, type Page } from "@playwright/test";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

async function tabTo(page: Page, target: Locator, backwards = false) {
  for (let index = 0; index < 180; index += 1) {
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    if (await target.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute("aria-label")}`);
}

async function expectWcagAAndAa(page: Page, label: string) {
  await page.addScriptTag({ path: axeScriptPath });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.length,
      targets: nodes.flatMap(({ target }) => target),
    }));
  });
  expect(violations, label).toEqual([]);
}

async function expectUnclipped(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const result = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const centerX = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const centerY = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(centerX, centerY);
    return {
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      reachable: top === node || Boolean(top && node.contains(top)),
      topElement: top ? `${top.tagName}.${(top as HTMLElement).className}` : null,
    };
  });
  expect(result.rect.left).toBeGreaterThanOrEqual(0);
  expect(result.rect.right).toBeLessThanOrEqual(result.viewport.width + 1);
  expect(result.rect.top).toBeGreaterThanOrEqual(0);
  expect(result.rect.bottom).toBeLessThanOrEqual(result.viewport.height + 1);
  expect(result.reachable, JSON.stringify(result)).toBe(true);
}

test("announces pending objection and final-decision persistence", async ({
  page,
}) => {
  await page.route("**/api/runs/simulated-objection-dispositions/checkpoints", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
  });
  await page.goto("/workbench?dispositions=awaiting&expectedRevision=revision-7");
  const objections = page.getByRole("region", {
    name: "Objection dispositions and selective revision",
  });
  for (const objectionId of [
    "gf-objection-calibration",
    "gf-objection-degradation",
  ]) {
    await objections
      .getByTestId(`objection-${objectionId}`)
      .getByRole("textbox", { name: "Human basis" })
      .fill("A bounded human basis for accessibility verification.");
  }
  await objections.getByRole("button", { name: "Save dispositions" }).click();
  await expect(objections).toHaveAttribute("aria-busy", "true");
  await expect(objections.getByRole("status")).toContainText(
    "Saving dispositions",
  );

  await page.goto("/workbench");
  await page.getByRole("button", { name: "Start isolated final review" }).click();
  const finalRegion = page.locator(
    'section[aria-labelledby="final-decision-title"]',
  );
  await finalRegion.getByRole("radio", { name: "Approve" }).check();
  await finalRegion.getByLabel("Declared actor").fill("Accessibility reviewer");
  await finalRegion
    .getByLabel("Decision rationale")
    .fill("Approve only this bounded fixture accessibility review.");
  await page.route("**/api/runs/*/checkpoints", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const finalForm = finalRegion.locator("form");
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalForm).toHaveAttribute("aria-busy", "true");
  await expect(finalForm.getByRole("status")).toContainText(
    "Persisting final decision",
  );
});

test("completes the core journey using only keyboard navigation", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/intake");

  const loadScope = page.getByRole("button", { name: "Load golden fixture" });
  await tabTo(page, loadScope);
  await page.keyboard.press("Enter");
  const approveScope = page.getByRole("button", { name: "Approve claim scope" });
  await tabTo(page, approveScope);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Scope approved", { exact: true })).toBeVisible();
  const continueLink = page.getByRole("link", {
    name: "Continue to recorded fixture workbench",
  });
  await expect(continueLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/workbench$/);

  const matrix = page.getByRole("region", {
    name: "Claim by source evidence matrix",
  });
  const firstCell = matrix.getByRole("button", { name: /Claim 1.*Source 1/ });
  await tabTo(page, firstCell);
  await page.keyboard.press("ArrowRight");
  const secondCell = matrix.getByRole("button", { name: /Claim 1.*Source 2/ });
  await expect(secondCell).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /Evidence verification/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(secondCell).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(secondCell).toBeFocused();

  const failedAttempt = page.locator(
    '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"] summary',
  );
  await tabTo(page, failedAttempt);
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"]',
    ),
  ).toContainText("Attempt 1");

  const startFinal = page.getByRole("button", {
    name: "Start isolated final review",
  });
  await tabTo(page, startFinal);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/workbench\?runId=[^&]+$/);

  const approve = page.getByRole("radio", { name: "Approve" });
  await tabTo(page, approve);
  await page.keyboard.press("Space");
  await expect(approve).toBeChecked();
  const actor = page.getByLabel("Declared actor");
  await tabTo(page, actor);
  await page.keyboard.type("Keyboard-only reviewer");
  const rationale = page.getByLabel("Decision rationale");
  await tabTo(page, rationale);
  await page.keyboard.type("Approve only this bounded keyboard fixture review.");
  const persist = page.getByRole("button", { name: "Persist final decision" });
  await tabTo(page, persist);
  await page.keyboard.press("Enter");
  const receipt = page.getByTestId("final-decision-receipt");
  await expect(receipt).toContainText("Keyboard-only reviewer");
  const exportLink = receipt.getByRole("link", { name: "Download canonical JSON" });
  await tabTo(page, exportLink);
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  await download;
});

test("has no WCAG A or AA axe violations across required states", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/intake");
  await expectWcagAAndAa(page, "intake empty");
  await page.getByRole("button", { name: "Approve claim scope" }).click();
  await expectWcagAAndAa(page, "intake invalid");
  await page.getByRole("button", { name: "Load golden fixture" }).click();
  await expectWcagAAndAa(page, "intake loaded");

  await page.goto("/workbench");
  const failedAttempt = page.locator(
    '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"] summary',
  );
  await failedAttempt.click();
  await expectWcagAAndAa(page, "recorded failure and retry");
  await page
    .getByRole("button", { name: /Claim 1.*Source 2/ })
    .click();
  await expectWcagAAndAa(page, "evidence drawer open");

  await page.goto("/workbench?dispositions=awaiting&expectedRevision=revision-7");
  const objections = page.getByRole("region", {
    name: "Objection dispositions and selective revision",
  });
  await objections.getByRole("button", { name: "Save dispositions" }).click();
  await expectWcagAAndAa(page, "objection validation");
  await page.route("**/api/runs/simulated-objection-dispositions/checkpoints", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: "{}" }),
  );
  for (const objectionId of ["gf-objection-calibration", "gf-objection-degradation"]) {
    await objections
      .getByTestId(`objection-${objectionId}`)
      .getByRole("textbox", { name: "Human basis" })
      .fill("A bounded human basis for the failed persistence state.");
  }
  await objections.getByRole("button", { name: "Save dispositions" }).click();
  await expect(objections.getByRole("alert")).toBeVisible();
  await expectWcagAAndAa(page, "objection failure");

  await page.goto("/workbench");
  await page.getByRole("button", { name: "Start isolated final review" }).click();
  const finalRegion = page.locator('section[aria-labelledby="final-decision-title"]');
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expectWcagAAndAa(page, "final validation");
  await finalRegion.getByRole("radio", { name: "Approve" }).check();
  await finalRegion.getByLabel("Declared actor").fill("Axe approval reviewer");
  await finalRegion.getByLabel("Decision rationale").fill("Approve bounded fixture.");
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(page.getByTestId("final-decision-receipt")).toBeVisible();
  await expectWcagAAndAa(page, "approve and export");

  await page.goto("/workbench");
  await page.getByRole("button", { name: "Start isolated final review" }).click();
  const rejectRegion = page.locator('section[aria-labelledby="final-decision-title"]');
  await rejectRegion.getByRole("radio", { name: "Reject" }).check();
  await rejectRegion.getByLabel("Declared actor").fill("Axe reject reviewer");
  await rejectRegion.getByLabel("Decision rationale").fill("Reject bounded fixture.");
  await rejectRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(page.getByTestId("final-decision-receipt")).toBeVisible();
  await expectWcagAAndAa(page, "reject");
});

for (const viewport of [
  { width: 1280, height: 720, label: "laptop" },
  { width: 640, height: 360, label: "effective 200 percent proxy" },
  { width: 390, height: 844, label: "mobile" },
]) {
  test(`keeps essential controls reachable at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/workbench");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const matrix = page.getByRole("region", {
      name: "Claim by source evidence matrix",
    });
    const rightmost = matrix.getByRole("button", { name: /Claim 1.*Source 7/ });
    await expectUnclipped(page, rightmost);
    await matrix.getByRole("button", { name: /Claim 1.*Source 2/ }).click();
    const drawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expectUnclipped(page, drawer.getByRole("button", { name: "Close evidence drawer" }));
    await expectUnclipped(page, drawer.locator("blockquote").first());
    await page.keyboard.press("Escape");
    await expectUnclipped(
      page,
      page.locator('[data-audit-attempt][data-node-id="plan-experiment"] summary').first(),
    );
    await expectUnclipped(
      page,
      page.getByRole("button", { name: "Start isolated final review" }),
    );
  });
}

test("computes reduced motion and exposes non-color state labels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/workbench");
  const matrix = page.getByRole("region", {
    name: "Claim by source evidence matrix",
  });
  for (const [relationship, label] of [
    ["supports", "Supports"],
    ["contradicts", "Contradicts"],
    ["unresolved", "Unresolved"],
    ["mismatch", "Metadata mismatch"],
    ["failure", "Verification failure"],
  ]) {
    const legendItem = matrix
      .locator('[aria-label="Relationship legend"]')
      .locator(`[data-relationship="${relationship}"]`);
    await expect(legendItem).toBeVisible();
    await expect(legendItem).toContainText(label);
  }
  await page.getByRole("button", { name: /Claim 1.*Source 2/ }).click();
  const motion = await page.evaluate(() => {
    const milliseconds = (value: string) =>
      value
        .split(",")
        .map((part) => part.trim())
        .map((part) => (part.endsWith("ms") ? Number.parseFloat(part) : Number.parseFloat(part) * 1000));
    return [...document.querySelectorAll("*")].reduce(
      (maximum, node) => {
        const style = getComputedStyle(node);
        return {
          animation: Math.max(maximum.animation, ...milliseconds(style.animationDuration)),
          transition: Math.max(maximum.transition, ...milliseconds(style.transitionDuration)),
        };
      },
      { animation: 0, transition: 0 },
    );
  });
  expect(motion.animation).toBeLessThanOrEqual(0.01);
  expect(motion.transition).toBeLessThanOrEqual(0.01);
});
