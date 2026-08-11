import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");
const localOrigin = "http://127.0.0.1:3100/";

type JourneyRun = {
  id: string;
  schemaVersion: string;
  status: string;
  evidenceMode: string;
  packet: { fingerprint: string } | null;
  executions: Array<{ id: string; evidenceMode: string }>;
  errors: Array<{ id: string }>;
  finalDecision: {
    checkpoint: string;
    optionsShown: string[];
    decision: string;
    declaredActor: string;
    rationale: string;
    unresolvedObjections: string[];
  } | null;
  [key: string]: unknown;
};

type Bootstrap = {
  runId: string;
  revision: string;
  snapshot: JourneyRun;
  disclosure: {
    evidenceMode: string;
    resetNotice: string;
    actorAuthority: string;
  };
};

let approvedRunId = "";
let approvedTopLevelKeys: string[] = [];
let approvedExecutionIds: string[] = [];
let approvedErrorIds: string[] = [];
let approvedPacketFingerprint = "";

function observeNetwork(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  const checkpointPosts: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(localOrigin)) {
      externalRequests.push(request.url());
    }
    if (
      request.method() === "POST" &&
      /\/api\/runs\/[^/]+\/checkpoints$/.test(new URL(request.url()).pathname)
    ) {
      checkpointPosts.push(request.url());
    }
  });

  return { consoleErrors, failedRequests, externalRequests, checkpointPosts };
}

function expectCleanNetwork(observed: ReturnType<typeof observeNetwork>) {
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.externalRequests).toEqual([]);
  expect(
    observed.failedRequests.filter(
      (failure) =>
        !/[?&]_rsc=/.test(failure) || !failure.endsWith("net::ERR_ABORTED"),
    ),
  ).toEqual([]);
}

async function expectNoSeriousAxeFindings(page: Page) {
  await page.addScriptTag({ path: axeScriptPath });
  const serious = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: () => Promise<{
            violations: Array<{ id: string; impact: string | null }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run();
    return result.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    );
  });
  expect(serious).toEqual([]);
}

async function bootstrapFinalSession(page: Page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs/fixture-workbench") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Start isolated final review" })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe(
    "private, no-store, max-age=0",
  );
  const bootstrap = (await response.json()) as Bootstrap;
  await expect(page).toHaveURL(
    new RegExp(`/workbench\\?runId=${bootstrap.runId}$`),
  );
  await expect(page.getByText(`Run ${bootstrap.runId} · contract 0.2`)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Final decision required" }),
  ).toBeVisible();
  expect(bootstrap.snapshot).toMatchObject({
    id: bootstrap.runId,
    schemaVersion: "0.2",
    status: "awaiting_final_approval",
    evidenceMode: "fixture",
    finalDecision: null,
  });
  expect(bootstrap.disclosure).toMatchObject({
    evidenceMode: "fixture",
    resetNotice: expect.stringContaining("restart or redeploy"),
    actorAuthority: expect.stringContaining("declared and unverified"),
  });
  return bootstrap;
}

async function assertCanonicalExport(
  page: Page,
  runId: string,
  expected: {
    status: "approved" | "rejected";
    decision: "approve" | "reject";
    actor: string;
    rationale: string;
    fingerprint: string;
    executionIds: string[];
    errorIds: string[];
  },
) {
  const first = await page.request.get(`/api/runs/${runId}/export`);
  const second = await page.request.get(`/api/runs/${runId}/export`);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe("private, no-store, max-age=0");
  expect(first.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(first.headers()["content-disposition"]).toBe(
    `attachment; filename="${runId}.json"`,
  );
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  const firstBytes = await first.body();
  expect(await second.body()).toEqual(firstBytes);

  const downloadPromise = page.waitForEvent("download");
  await page
    .getByTestId("final-decision-receipt")
    .getByRole("link", { name: "Download canonical JSON" })
    .click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect(await readFile(downloadPath!)).toEqual(firstBytes);

  const exported = JSON.parse(firstBytes.toString("utf8")) as JourneyRun;
  expect(exported).toMatchObject({
    id: runId,
    schemaVersion: "0.2",
    evidenceMode: "fixture",
    status: expected.status,
    packet: { fingerprint: expected.fingerprint },
    finalDecision: {
      checkpoint: "final",
      optionsShown: ["approve", "reject"],
      decision: expected.decision,
      declaredActor: expected.actor,
      rationale: expected.rationale,
      unresolvedObjections: ["gf-objection-degradation"],
    },
  });
  expect(exported.executions.map(({ id }) => id)).toEqual(expected.executionIds);
  expect(exported.errors.map(({ id }) => id)).toEqual(expected.errorIds);
  expect(
    exported.executions.every(({ evidenceMode }) => evidenceMode === "fixture"),
  ).toBe(true);
  return exported;
}

test.describe("complete golden fixture journey", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("inspects the recorded story, then approves and exports an isolated final session", async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const observed = observeNetwork(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/intake");
    await page.getByRole("button", { name: "Load golden fixture" }).click();
    await page.getByRole("button", { name: "Approve claim scope" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Scope approved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Research question")).toBeDisabled();

    const continueToWorkbench = page.getByRole("link", {
      name: "Continue to recorded fixture workbench",
    });
    await continueToWorkbench.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/workbench$/);

    await expect(
      page.getByLabel("Evidence mode: Fixture. Deterministic reviewed fixture."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This shell displays the recorded decision; it does not replay or fabricate approval.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Claim ledger" })).toBeVisible();
    await expect(page.getByText("3 claim rows")).toBeVisible();

    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    await expect(packet.getByText("Frozen packet", { exact: true })).toBeVisible();
    await expect(packet.getByText(goldenRunV01.packet!.fingerprint)).toBeVisible();
    await expect(
      packet.getByLabel("Packet freeze receipt").getByText("7 sources", {
        exact: true,
      }),
    ).toBeVisible();

    const matrix = page.getByRole("region", {
      name: "Claim by source evidence matrix",
    });
    await expect(
      matrix.getByRole("button", {
        name: /Contradicts.*1 evidence.*Metadata mismatch/,
      }),
    ).toBeVisible();
    await expect(
      matrix.getByRole("button", { name: /Unresolved.*1 evidence/ }).first(),
    ).toBeVisible();
    const firstCell = matrix.getByRole("button", { name: /Claim 1.*Source 1/ });
    await firstCell.focus();
    await page.keyboard.press("ArrowRight");
    const secondCell = matrix.getByRole("button", { name: /Claim 1.*Source 2/ });
    await expect(secondCell).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(drawer.getByText("gf-evidence-02", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Deterministic passage check", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Model entailment", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Human review", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(secondCell).toBeFocused();

    const conclusions = page.getByRole("region", {
      name: "Conclusions and selected research gap",
    });
    await expect(conclusions.getByText("Conflicting", { exact: true })).toBeVisible();
    await expect(
      conclusions.getByText("Insufficient evidence · abstain", { exact: true }),
    ).toBeVisible();
    await expect(conclusions.getByLabel("Human selection record")).toContainText(
      "Gap 01 · selected",
    );

    const protocol = page.getByRole("region", {
      name: "Experiment protocol inspector",
    });
    await expect(protocol.getByText("fixture", { exact: true })).toBeVisible();
    await expect(
      protocol.getByRole("alert").filter({ hasText: /power assumptions are missing/i }),
    ).toBeVisible();
    await expect(
      protocol.getByText("Qualified human review required", { exact: true }),
    ).toBeVisible();
    await expect(
      protocol.getByText("What this outcome does not establish", { exact: true }).first(),
    ).toBeVisible();

    const objections = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    await expect(
      objections.getByText("Recorded fixture · read-only", { exact: true }),
    ).toBeVisible();
    const accepted = objections.getByTestId("objection-gf-objection-calibration");
    await expect(accepted.getByText("Accepted", { exact: true })).toBeVisible();
    await expect(accepted.getByText("Before", { exact: true })).toBeVisible();
    await expect(accepted.getByText("After", { exact: true })).toBeVisible();
    const unresolved = objections.getByTestId("objection-gf-objection-degradation");
    await expect(unresolved.getByText("Unresolved", { exact: true })).toBeVisible();
    await expect(unresolved.getByText("No field change", { exact: true })).toBeVisible();
    await expect(unresolved.getByText("After", { exact: true })).toHaveCount(0);

    const failedPlan = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"]',
    );
    const retriedPlan = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="succeeded"]',
    );
    await expect(failedPlan).toHaveCount(1);
    await expect(retriedPlan).toHaveCount(1);
    await failedPlan.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(failedPlan.getByText("Failed", { exact: true })).toBeVisible();
    await expect(failedPlan.getByText("Attempt 1 · fixture", { exact: true })).toBeVisible();
    await retriedPlan.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(retriedPlan.getByText("Succeeded", { exact: true })).toBeVisible();
    await expect(retriedPlan.getByText("Retry of gf-execution-plan-1")).toBeVisible();
    expect(observed.checkpointPosts).toEqual([]);

    await retriedPlan.locator("summary").press("Enter");
    await failedPlan.locator("summary").press("Enter");
    await failedPlan.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("interim-golden-failure-retry-1440.png"),
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("interim-golden-recorded-1440.png"),
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 640, height: 360 });
    await page.getByRole("heading", { name: "Decision recorded · approve" }).scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("interim-golden-recorded-mobile-390.png"),
      fullPage: true,
    });
    await expectNoSeriousAxeFindings(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    const bootstrap = await bootstrapFinalSession(page);
    approvedRunId = bootstrap.runId;
    approvedPacketFingerprint = bootstrap.snapshot.packet!.fingerprint;
    approvedExecutionIds = bootstrap.snapshot.executions.map(({ id }) => id);
    approvedErrorIds = bootstrap.snapshot.errors.map(({ id }) => id);

    const finalRegion = page.locator(
      'section[aria-labelledby="final-decision-title"]',
    );
    await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
    await expect(finalRegion.getByRole("radio", { name: "Approve" })).toBeFocused();
    await finalRegion.getByRole("radio", { name: "Approve" }).check();
    await finalRegion.getByLabel("Declared actor").fill("Golden journey reviewer");
    await finalRegion
      .getByLabel("Decision rationale")
      .fill("Approve only this bounded fixture demonstration.");
    const checkpointResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${bootstrap.runId}/checkpoints`) &&
        response.request().method() === "POST",
    );
    await finalRegion.getByRole("button", { name: "Persist final decision" }).focus();
    await page.keyboard.press("Enter");
    const checkpointResponse = await checkpointResponsePromise;
    expect(checkpointResponse.status()).toBe(200);
    expect(checkpointResponse.headers()["cache-control"]).toBe(
      "private, no-store, max-age=0",
    );
    await expect(
      page.getByRole("heading", { name: "Decision recorded · approve" }),
    ).toBeVisible();
    await expect(page.getByTestId("final-decision-receipt")).toContainText(
      "Golden journey reviewer",
    );

    const approved = await assertCanonicalExport(page, bootstrap.runId, {
      status: "approved",
      decision: "approve",
      actor: "Golden journey reviewer",
      rationale: "Approve only this bounded fixture demonstration.",
      fingerprint: approvedPacketFingerprint,
      executionIds: approvedExecutionIds,
      errorIds: approvedErrorIds,
    });
    approvedTopLevelKeys = Object.keys(approved).sort();
    expect(observed.checkpointPosts).toHaveLength(1);
    expectCleanNetwork(observed);
  });

  test("rejects and exports a fresh isolated session with approval-path parity", async ({
    page,
  }, testInfo) => {
    test.setTimeout(45_000);
    const observed = observeNetwork(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/workbench");
    const bootstrap = await bootstrapFinalSession(page);
    expect(bootstrap.runId).not.toBe(approvedRunId);
    expect(bootstrap.snapshot.packet!.fingerprint).toBe(approvedPacketFingerprint);
    expect(bootstrap.snapshot.executions.map(({ id }) => id)).toEqual(
      approvedExecutionIds,
    );
    expect(bootstrap.snapshot.errors.map(({ id }) => id)).toEqual(approvedErrorIds);

    const finalRegion = page.locator(
      'section[aria-labelledby="final-decision-title"]',
    );
    await finalRegion.getByRole("radio", { name: "Reject" }).focus();
    await page.keyboard.press("Space");
    await finalRegion.getByLabel("Declared actor").fill("Independent reject reviewer");
    await finalRegion
      .getByLabel("Decision rationale")
      .fill("Reject while the recorded residual risk remains unresolved.");
    await finalRegion.getByRole("button", { name: "Persist final decision" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Decision recorded · reject" }),
    ).toBeVisible();

    const rejected = await assertCanonicalExport(page, bootstrap.runId, {
      status: "rejected",
      decision: "reject",
      actor: "Independent reject reviewer",
      rationale: "Reject while the recorded residual risk remains unresolved.",
      fingerprint: approvedPacketFingerprint,
      executionIds: approvedExecutionIds,
      errorIds: approvedErrorIds,
    });
    expect(Object.keys(rejected).sort()).toEqual(approvedTopLevelKeys);
    expect(rejected.id).not.toBe(approvedRunId);
    expect(observed.checkpointPosts).toHaveLength(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("interim-golden-rejected-mobile-390.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expectCleanNetwork(observed);
  });
});
