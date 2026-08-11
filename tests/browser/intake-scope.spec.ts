import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test.describe("intake and scope approval", () => {
  test("keeps evidence work blocked through empty, invalid, and awaiting states", async ({
    page,
  }) => {
    await page.goto("/intake");

    await expect(
      page.getByRole("heading", { level: 1, name: "Define the claim contract" }),
    ).toBeVisible();
    await expect(page.getByText("No claims yet")).toBeVisible();
    await expect(
      page.getByText("Source and model work blocked", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Approve claim scope" }).click();
    await expect(page.getByText("Enter the research question.")).toBeVisible();
    await expect(page.getByText("Add at least one testable claim.")).toBeVisible();

    await page.getByLabel("Research question").fill("Can a bounded system work?");
    await page
      .getByLabel("Intended application")
      .fill("A reviewable laboratory comparison");
    await page.getByRole("button", { name: "Add claim" }).click();
    await page
      .getByLabel("Claim 1 statement")
      .fill("The bounded system can meet its target.");
    await expect(page.getByText("Awaiting scope approval", { exact: true })).toBeVisible();
  });

  test("adds, edits, removes, and approves claims with keyboard-operable controls", async ({
    page,
  }) => {
    await page.goto("/intake");
    await page.getByLabel("Research question").fill("Can a bounded system work?");
    await page
      .getByLabel("Intended application")
      .fill("A reviewable laboratory comparison");

    await page.getByRole("button", { name: "Add claim" }).focus();
    await page.keyboard.press("Enter");
    await page
      .getByLabel("Claim 1 statement")
      .fill("The bounded system meets the target.");
    await page
      .getByLabel("Claim 1 operational definition")
      .fill("The preregistered outcome clears the comparator threshold.");

    await page.getByRole("button", { name: "Add claim" }).focus();
    await page.keyboard.press("Enter");
    await page
      .getByLabel("Claim 2 statement")
      .fill("A removable claim.");
    await page
      .getByLabel("Claim 2 operational definition")
      .fill("This row will be removed.");
    await page.getByRole("button", { name: "Remove claim 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Claim 2 statement")).toHaveCount(0);

    await page.getByRole("button", { name: "Approve claim scope" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Scope approved", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Source and model work may begin", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Claim 1 statement")).toBeDisabled();
  });

  test("loads the golden fixture as an honestly labeled approval copy", async ({
    page,
  }) => {
    await page.goto("/intake");
    await expect(page.getByText("Recommended demo path", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load golden fixture" }).click();

    await expect(page.getByText("Fixture copy", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Research question")).toHaveValue(
      "For a single-use 72-hour environmental sensor, can a biodegradable battery replace a lithium coin cell?",
    );
    await expect(page.getByLabel("Claim 3 statement")).toBeVisible();
    await expect(
      page.getByText("Source and model work blocked", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Deterministic fixture data—not a live provider result. Review and approve this copy.",
      ),
    ).toBeVisible();
  });

  test("moves focus to the continuation link after successful approval", async ({
    page,
  }) => {
    await page.goto("/intake");
    await page.getByRole("button", { name: "Load golden fixture" }).click();
    await page.getByRole("button", { name: "Approve claim scope" }).click();

    await expect(
      page.getByRole("link", {
        name: "Continue to recorded fixture workbench",
      }),
    ).toBeFocused();
    await expect(page.getByText("Scope approved", { exact: true })).toBeVisible();
  });

  test("limits clarification questions to three", async ({ page }) => {
    await page.goto("/intake");

    const add = page.getByRole("button", { name: "Add clarification" });
    await add.click();
    await add.click();
    await add.click();

    await expect(
      page.getByRole("textbox", { name: "Clarification 3" }),
    ).toBeVisible();
    await expect(add).toBeDisabled();
  });

  test("restores deterministic focus after keyboard clarification removal", async ({
    page,
  }) => {
    await page.goto("/intake");
    const add = page.getByRole("button", { name: "Add clarification" });
    await add.click();
    await add.click();
    await add.click();

    await page.getByRole("button", { name: "Remove clarification 1" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "Clarification 1" }),
    ).toBeFocused();

    await add.click();
    await page.getByRole("button", { name: "Remove clarification 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "Clarification 2" }),
    ).toBeFocused();

    await page.getByRole("button", { name: "Remove clarification 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "Clarification 1" }),
    ).toBeFocused();

    await page.getByRole("button", { name: "Remove clarification 1" }).focus();
    await page.keyboard.press("Enter");
    await expect(add).toBeFocused();
  });

  test("preserves semantic structure, focus order, reduced motion, and responsive layout", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/intake");
    expect(await page.locator("main > header").boundingBox()).toMatchObject({
      x: 0,
      width: 1280,
    });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Load golden fixture" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Research question")).toBeFocused();

    await page.getByRole("button", { name: "Load golden fixture" }).click();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(
      await page.locator("input, textarea").evaluateAll((controls) =>
        controls.every((control) => {
          const field = control as HTMLInputElement | HTMLTextAreaElement;
          return field.labels !== null && field.labels.length === 1;
        }),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("desktop-golden-scope-viewport.png"),
    });
    await page.screenshot({
      path: testInfo.outputPath("desktop-golden-scope.png"),
      fullPage: true,
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    // A 640 × 360 CSS viewport exercises the effective layout available at
    // 200% zoom on the 1280 × 720 recording target.
    await page.setViewportSize({ width: 640, height: 360 });
    const approveAtZoom = page.getByRole("button", {
      name: "Approve claim scope",
    });
    await approveAtZoom.scrollIntoViewIfNeeded();
    await expect(approveAtZoom).toBeVisible();
    expect(
      await approveAtZoom.evaluate((control) => {
        const bounds = control.getBoundingClientRect();
        return (
          bounds.top >= 0 &&
          bounds.left >= 0 &&
          bounds.bottom <= window.innerHeight &&
          bounds.right <= window.innerWidth
        );
      }),
    ).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("main > header").boundingBox()).toMatchObject({
      x: 0,
      width: 390,
    });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("mobile-golden-scope.png"),
      fullPage: true,
    });

    expect(consoleErrors).toEqual([]);
  });

  test("captures the invalid state with associated errors", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/intake");
    await page.getByRole("button", { name: "Approve claim scope" }).click();

    await expect(page.getByLabel("Research question")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator('main [role="alert"]')).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("desktop-invalid-scope.png"),
      fullPage: true,
    });
  });

  test("has no critical or serious automated accessibility violations", async ({
    page,
  }) => {
    await page.goto("/intake");
    await page.getByRole("button", { name: "Load golden fixture" }).click();
    await page.addScriptTag({ path: axeScriptPath });

    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run: () => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                help: string;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run();
      return result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      );
    });

    expect(violations).toEqual([]);
  });
});
