import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test.describe("node execution audit rail", () => {
  test("renders actual fixture attempts with full bounded disclosure", async ({
    page,
  }) => {
    await page.goto("/workbench");

    const attempts = page.locator("[data-audit-attempt]");
    await expect(attempts).toHaveCount(10);
    await expect(page.getByText("3 preserved failures")).toBeVisible();
    await expect(page.getByText("2 linked retries")).toBeVisible();
    await expect(page.getByText("0 running now")).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toHaveCount(0);

    const planAttempts = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"]',
    );
    await expect(planAttempts).toHaveCount(2);
    await expect(planAttempts.nth(0)).toHaveAttribute(
      "data-execution-status",
      "failed",
    );
    await expect(planAttempts.nth(1)).toHaveAttribute(
      "data-execution-status",
      "succeeded",
    );

    const failedPlan = planAttempts.nth(0);
    await failedPlan.locator("summary").click();
    await expect(failedPlan.getByText("Requested provider")).toBeVisible();
    await expect(failedPlan.getByText("Returned provider")).toBeVisible();
    await expect(failedPlan.getByText("Requested model")).toBeVisible();
    await expect(failedPlan.getByText("Returned model")).toBeVisible();
    await expect(failedPlan.getByText("Prompt ID")).toBeVisible();
    await expect(failedPlan.getByText("Prompt version")).toBeVisible();
    await expect(failedPlan.getByText("Prompt hash")).toBeVisible();
    await expect(failedPlan.getByText("Output schema")).toBeVisible();
    await expect(failedPlan.getByText("Evidence mode")).toBeVisible();
    await expect(
      failedPlan.getByRole("heading", { name: "Validation" }),
    ).toBeVisible();
    await expect(failedPlan.getByText("Client latency")).toBeVisible();
    await expect(failedPlan.getByText("Provider total")).toBeVisible();
    await expect(failedPlan.getByText("Input tokens")).toBeVisible();
    await expect(failedPlan.getByText("Estimated cost")).toBeVisible();
    await expect(failedPlan.getByText("Unavailable", { exact: true })).toHaveCount(
      16,
    );
    await expect(
      failedPlan.getByText("sampleSizeBasis was omitted").first(),
    ).toBeVisible();
    await expect(
      failedPlan.getByText("invalid model output", { exact: true }),
    ).toBeVisible();
    await expect(
      failedPlan
        .getByText("Evidence mode")
        .locator("..")
        .getByText("fixture", { exact: true }),
    ).toBeVisible();

    const successfulRetry = planAttempts.nth(1);
    await successfulRetry.locator("summary").click();
    await expect(
      successfulRetry.getByText("Retry of gf-execution-plan-1"),
    ).toBeVisible();
  });

  test("renders empty, awaiting, and partial audit history without future attempts", async ({
    page,
  }) => {
    await page.goto("/workbench?scenario=awaiting");
    await expect(page.locator("[data-audit-attempt]")).toHaveCount(0);
    await expect(
      page.getByText("No execution attempts recorded", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toHaveCount(0);

    await page.goto("/workbench?scenario=partial");
    await expect(page.locator("[data-audit-attempt]")).toHaveCount(4);
    await expect(page.getByText("Partial ledger", { exact: true })).toBeVisible();
  });

  test("keeps timeout, refusal, invalid output, and retry-then-success distinct", async ({
    page,
  }) => {
    await page.goto("/workbench?scenario=timeout");
    await expect(
      page.locator('[data-audit-attempt][data-execution-status="timed_out"]'),
    ).toHaveCount(1);
    await expect(page.getByText("Timed out", { exact: true })).toBeVisible();
    await expect(page.getByText("Attempt 1 · simulated")).toBeVisible();

    await page.goto("/workbench?scenario=refusal");
    await expect(
      page.locator('[data-audit-attempt][data-execution-status="refused"]'),
    ).toHaveCount(1);
    await expect(page.getByText("Refused", { exact: true })).toBeVisible();

    await page.goto("/workbench?scenario=invalid-output");
    await expect(
      page.locator('[data-node-id="plan-experiment"][data-execution-status="failed"]'),
    ).toHaveCount(1);
    await expect(
      page.getByText("sampleSizeBasis was omitted").first(),
    ).toBeVisible();

    await page.goto("/workbench?scenario=retry");
    const plan = page.locator('[data-node-id="plan-experiment"]');
    await expect(plan).toHaveCount(2);
    await expect(plan.nth(0)).toHaveAttribute("data-execution-status", "failed");
    await expect(plan.nth(1)).toHaveAttribute(
      "data-execution-status",
      "succeeded",
    );
  });

  test("never labels a visual preview as a genuinely running attempt", async ({
    page,
  }) => {
    await page.goto("/workbench?scenario=running");

    await expect(page.getByText("Verifying evidence", { exact: true })).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toHaveCount(0);
    await expect(page.getByText("0 running now")).toBeVisible();
  });

  test("renders a stale open attempt in a final run without claiming it is Running", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?scenario=stale-execution");

    await expect(
      page.getByText("Approved with boundaries", { exact: true }),
    ).toBeVisible();
    const staleAttempt = page.locator(
      '[data-audit-attempt][data-execution-status="started"]',
    );
    await expect(staleAttempt).toHaveCount(1);
    await expect(
      staleAttempt.getByText("Started (stale open record)", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toHaveCount(0);
    await expect(page.getByText("0 running now")).toBeVisible();
    await staleAttempt.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(staleAttempt.getByText("Requested provider")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("mobile-stale-open-final-run.png"),
      fullPage: true,
    });
  });

  test("supports keyboard disclosure and responsive audit inspection", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()}`);
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/workbench?scenario=retry");
    const failedAttempt = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"]',
    );
    await failedAttempt.locator("summary").scrollIntoViewIfNeeded();
    await failedAttempt.locator("summary").focus();
    await expect(failedAttempt.locator("summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(failedAttempt.getByText("Requested provider")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("desktop-retry-audit-1280x720.png"),
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 640, height: 360 });
    await failedAttempt.locator("summary").scrollIntoViewIfNeeded();
    await expect(failedAttempt.locator("summary")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?scenario=timeout");
    const timeoutAttempt = page.locator(
      '[data-audit-attempt][data-execution-status="timed_out"]',
    );
    await timeoutAttempt.locator("summary").scrollIntoViewIfNeeded();
    await timeoutAttempt.locator("summary").click();
    await expect(timeoutAttempt.getByText("Requested model")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("mobile-timeout-audit.png"),
      fullPage: true,
    });

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("does not render secrets or private prompt bodies", async ({ page }) => {
    await page.goto("/workbench");
    await page.locator("[data-audit-attempt]").first().locator("summary").click();
    const text = await page.locator("main").innerText();

    expect(text).not.toMatch(/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/i);
    expect(text).not.toMatch(/\b(sk|gsk|nvapi)[-_][A-Za-z0-9]{16,}\b/i);
    expect(text).not.toContain("developer message");
    expect(text).not.toContain("system prompt");
    expect(text).toMatch(/prompt id/i);
    expect(text).toMatch(/prompt hash/i);
  });

  test("has no critical or serious automated accessibility violations", async ({
    page,
  }) => {
    await page.goto("/workbench?scenario=retry");
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
