import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test.describe("evidence workbench shell", () => {
  test("maps the reviewed fixture into every primary workspace region", async ({
    page,
  }) => {
    await page.goto("/workbench");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "For a single-use 72-hour environmental sensor, can a biodegradable battery replace a lithium coin cell?",
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        "Evidence mode: Fixture. Deterministic reviewed fixture.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Claim ledger" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Claim × source matrix" }),
    ).toBeVisible();
    await expect(page.getByText("3 claim rows")).toBeVisible();
    await expect(page.getByText("7 source columns")).toBeVisible();
    await expect(page.getByText("7 traceable cards")).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Claim by source evidence relationships" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Conclusions & gaps" }),
    ).toBeVisible();
    await expect(page.getByText("3 preserved failures")).toBeVisible();
    await expect(page.getByText("2 linked retries")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Decision recorded · approve" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This shell displays the recorded decision; it does not replay or fabricate approval.",
      ),
    ).toBeVisible();
  });

  test("provides one coherent, keyboard-visible run contents index", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/workbench");

    const contents = page.getByRole("navigation", { name: "Run contents" });
    await expect(contents).toHaveCSS("position", "static");
    await expect(
      page.locator('dl[aria-label="Resolved scope"] + nav'),
    ).toHaveCount(1);

    const destinations = [
      ["01 Packet", "packet"],
      ["02 Claims", "claims"],
      ["03 Evidence", "evidence"],
      ["04 Synthesis & gap", "synthesis-gap"],
      ["05 Experiment", "experiment"],
      ["06 Review & revision", "review-revision"],
      ["07 Audit", "audit"],
      ["08 Final decision", "final-decision"],
    ] as const;

    for (const [name, id] of destinations) {
      const link = contents.getByRole("link", { name });
      await expect(link).toHaveAttribute("href", `#${id}`);
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    await expect(page.locator("#packet").getByText(/01.*Packet checkpoint/)).toBeVisible();
    await expect(page.locator("#claims").getByText(/02.*Claims/)).toBeVisible();
    await expect(page.locator("#evidence").getByText(/03.*Evidence/)).toBeVisible();
    await expect(page.locator("#synthesis-gap").getByText(/04.*Synthesis/)).toBeVisible();
    await expect(page.locator("#experiment").getByText(/05.*Experiment/)).toBeVisible();
    await expect(page.locator("#review-revision").getByText(/06.*Review & revision/)).toBeVisible();
    await expect(page.locator("#audit").getByText(/07.*Audit/)).toBeVisible();
    await expect(page.locator("#final-decision").getByText(/08.*Final decision/)).toBeVisible();

    const evidenceLink = contents.getByRole("link", { name: "03 Evidence" });
    await evidenceLink.focus();
    expect(
      await evidenceLink.evaluate((link) => getComputedStyle(link).outlineStyle),
    ).not.toBe("none");
    await evidenceLink.click();
    await expect(page).toHaveURL(/#evidence$/);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("renders awaiting, collecting, running, and partial states honestly", async ({
    page,
  }) => {
    const states = [
      ["awaiting", "Awaiting scope approval"],
      ["collecting", "Collecting approved sources"],
      ["running", "Verifying evidence"],
      ["partial", "Partial evidence"],
    ] as const;

    for (const [scenario, label] of states) {
      await page.goto(`/workbench?scenario=${scenario}`);
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      await expect(
        page.getByText("Fixture state preview—not a live provider result."),
      ).toBeVisible();
      await expect(
        page.getByLabel(
          "Evidence mode: Fixture. Deterministic reviewed fixture.",
        ),
      ).toBeVisible();
    }
  });

  test("keeps timeout, refusal, invalid output, and retry evidence explicit", async ({
    page,
  }) => {
    const recoveryStates = [
      [
        "timeout",
        "The provider timed out before returning a validated result.",
        "1 preserved failures",
      ],
      [
        "refusal",
        "The provider refused the request; no proposal was produced.",
        "1 preserved failures",
      ],
      [
        "invalid-output",
        "The model response failed contract validation and was not accepted.",
        "1 preserved failures",
      ],
      [
        "retry",
        "The prior provider failure is preserved beside its explicit retry.",
        "2 preserved failures",
      ],
    ] as const;

    for (const [scenario, evidence, preservedFailures] of recoveryStates) {
      await page.goto(`/workbench?scenario=${scenario}`);
      await expect(page.getByText(evidence).first()).toBeVisible();
      await expect(page.getByText(preservedFailures)).toBeVisible();
    }
  });

  test("keeps the integrated recovery contract typed, actionable, and honestly labeled", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      if (!/[?&]_rsc=/.test(request.url())) failedRequests.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const recoveryStates = [
      ["timeout", "timeout", "simulated", "RunError.kind=timeout", "Retry this node", "1 preserved failures"],
      ["refusal", "provider refusal", "simulated", "RunError.kind=provider_refusal", "Revise the request", "1 preserved failures"],
      ["invalid-json", "invalid model json", "simulated", "RunError.kind=invalid_model_json", "Retry with JSON repair", "1 preserved failures"],
      ["invalid-schema", "invalid model output", "simulated", "RunError.kind=invalid_model_output", "Retry after schema validation", "1 preserved failures"],
      ["retry-exhausted", "provider failure", "simulated", "RunError.kind=provider_failure + NodeExecution.retryOfExecutionId", "Review the input or provider configuration", "2 preserved failures"],
      ["retry", "provider failure", "fixture", "goldenRunV01.errors + NodeExecution.retryOfExecutionId", "Continue from the successful linked retry", "2 preserved failures"],
      ["source-mismatch", "metadata mismatch", "fixture", "SourceRecord.metadataVerification.status=mismatch", "Review the field-level mismatch", "3 preserved failures"],
      ["missing-source", "missing source", "fixture", "goldenRunV01.errors[kind=missing_source]", "Add or approve another bounded source", "1 preserved failures"],
    ] as const;

    for (const [scenario, kind, evidenceMode, contractSource, action, preservedFailures] of recoveryStates) {
      await page.goto(`/workbench?scenario=${scenario}`);
      const recovery = page.getByRole("region", { name: "Recovery contract" });
      await expect(recovery.getByText(kind, { exact: true })).toBeVisible();
      await expect(recovery.getByText(evidenceMode, { exact: true })).toBeVisible();
      await expect(recovery.getByText(contractSource, { exact: true })).toBeVisible();
      await expect(recovery.getByText(new RegExp(`^${action}`))).toBeVisible();
      await expect(recovery.getByText("Prior attempt retained", { exact: true })).toBeVisible();
      await expect(page.getByText(preservedFailures)).toBeVisible();
      await expect(page.getByText("0 running now")).toBeVisible();
      await expect(page.getByText("Running", { exact: true })).toHaveCount(0);
    }

    await page.goto("/workbench?scenario=source-mismatch");
    await expect(
      page.getByRole("button", { name: /Contradicts.*Metadata mismatch/ }),
    ).toBeVisible();

    await page.goto("/workbench?scenario=missing-source");
    const missingAttempt = page.locator('[data-audit-attempt][data-node-id="collect-sources"]');
    await missingAttempt.locator("summary").click();
    const missingError = missingAttempt.locator("li").filter({
      hasText: "gf-error-source-08",
    });
    await expect(missingError).toContainText("provider DOI_NOT_FOUND");
    await expect(missingError).toContainText("HTTP 404");

    await page.goto("/workbench?scenario=retry-exhausted");
    const exhaustedRetry = page.locator(
      '[data-audit-attempt][data-execution-status="failed"]',
    ).nth(1);
    await exhaustedRetry.locator("summary").click();
    await expect(
      exhaustedRetry.getByText("Retry of fixture-preview-retry-exhausted-1"),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("interim-integrated-retry-exhausted-1440.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?scenario=missing-source");
    await expect(page.getByRole("region", { name: "Recovery contract" })).toBeVisible();
    await page.addScriptTag({ path: axeScriptPath });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as Window & {
          axe: { run: () => Promise<{ violations: Array<{ impact: string | null }> }> };
        }
      ).axe;
      const result = await axe.run();
      return result.violations.filter(({ impact }) =>
        impact === "critical" || impact === "serious",
      );
    });
    expect(violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("interim-integrated-missing-source-mobile-390.png"),
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("separates reviewer, final, approved, rejected, and failed decisions", async ({
    page,
  }) => {
    const decisions = [
      ["reviewer-decision", "Reviewer decision required", "Final decision pending"],
      ["final-decision", "Final decision required", "Final decision pending"],
      ["approved", "Approved with boundaries", "Decision recorded · approve"],
      ["rejected", "Rejected", "Decision recorded · reject"],
      ["failed", "Run failed", "No final approval recorded"],
    ] as const;

    for (const [scenario, state, finalLabel] of decisions) {
      await page.goto(`/workbench?scenario=${scenario}`);
      await expect(page.getByText(state, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: finalLabel }),
      ).toBeVisible();
    }
  });

  test("keeps only a genuinely actionable desktop final decision sticky", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const scenario of ["approved", "rejected", "failed", "final-decision"]) {
      await page.goto(`/workbench?scenario=${scenario}`);
      const finalBar = page.locator('[data-decision-state]');
      await expect(finalBar).toHaveCSS("position", "static");
      await expect(finalBar).toHaveAttribute("data-decision-actionable", "false");
    }

    await page.goto("/workbench");
    await page.getByRole("button", { name: "Start isolated final review" }).click();
    await expect(page).toHaveURL(/\/workbench\?runId=[^&]+$/);
    const actionable = page.locator(
      '[data-decision-state="awaiting_final_approval"]',
    );
    await expect(actionable).toHaveAttribute("data-decision-actionable", "true");
    await expect(actionable).toHaveCSS("position", "sticky");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(actionable).toHaveCSS("position", "static");
  });

  test("preserves layout, keyboard focus, reduced motion, and screenshots", async ({
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
    await page.goto("/workbench");
    expect(await page.locator("main > header").boundingBox()).toMatchObject({
      x: 0,
      width: 1280,
    });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "EvidenceForge" })).toBeFocused();
    const contentsLinks = page
      .getByRole("navigation", { name: "Run contents" })
      .getByRole("link");
    await expect(contentsLinks).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      await expect(contentsLinks.nth(index)).toBeFocused();
    }
    const sourceSummaries = page
      .getByRole("region", { name: "Source packet checkpoint" })
      .locator("details > summary");
    await expect(sourceSummaries).toHaveCount(7);
    for (let index = 0; index < 7; index += 1) {
      await page.keyboard.press("Tab");
      await expect(sourceSummaries.nth(index)).toBeFocused();
    }
    expect(
      await sourceSummaries.last().evaluate(
        (summary) => getComputedStyle(summary).outlineStyle,
      ),
    ).not.toBe("none");
    await page.keyboard.press("Tab");
    const matrixScroll = page.getByLabel("Scrollable evidence matrix");
    await expect(matrixScroll).toBeFocused();
    expect(
      await matrixScroll.evaluate(
        (region) => getComputedStyle(region).outlineStyle,
      ),
    ).not.toBe("none");
    await page.keyboard.press("Tab");
    const firstMatrixCell = page.getByRole("button", {
      name: /Claim 1.*Source 1/,
    });
    await expect(firstMatrixCell).toBeFocused();
    expect(
      await firstMatrixCell.evaluate(
        (button) => getComputedStyle(button).outlineStyle,
      ),
    ).not.toBe("none");
    await page.keyboard.press("Tab");
    const firstConclusionLink = page
      .getByRole("region", { name: "Conclusions and selected research gap" })
      .getByRole("link", { name: /Open evidence/ })
      .first();
    await expect(firstConclusionLink).toBeFocused();
    expect(
      await firstConclusionLink.evaluate(
        (link) => getComputedStyle(link).outlineStyle,
      ),
    ).not.toBe("none");
    const auditSummary = page.locator(
      'aside[aria-label="Experiment and audit"] > details > summary',
    );
    await auditSummary.focus();
    await expect(
      auditSummary,
    ).toBeFocused();
    expect(
      await auditSummary.evaluate(
        (summary) => getComputedStyle(summary).outlineStyle,
      ),
    ).not.toBe("none");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("desktop-fixture-workbench-viewport.png"),
    });
    await page.screenshot({
      path: testInfo.outputPath("desktop-fixture-workbench.png"),
      fullPage: true,
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    // A 640 × 360 CSS viewport approximates the usable layout at 200% zoom
    // on the 1280 × 720 recording target.
    await page.setViewportSize({ width: 640, height: 360 });
    await page
      .getByRole("heading", { name: "Decision recorded · approve" })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("heading", { name: "Decision recorded · approve" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?scenario=timeout");
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
      path: testInfo.outputPath("mobile-timeout-workbench.png"),
      fullPage: true,
    });

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("has no critical or serious automated accessibility violations", async ({
    page,
  }) => {
    await page.goto("/workbench?scenario=final-decision");
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
