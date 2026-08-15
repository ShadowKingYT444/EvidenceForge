import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

type BootstrapSnapshot = {
  run: {
    id: string;
    schemaVersion: string;
    status: string;
    evidenceMode: string;
    updatedAt: string;
    packet: { fingerprint: string } | null;
    executions: Array<{ id: string; evidenceMode: string }>;
    errors: Array<{ id: string }>;
    finalDecision: unknown;
    [key: string]: unknown;
  };
  revision: string;
};

async function startFinalReview(page: Page) {
  await page.goto("/workbench#decision");
  await page.getByRole("button", { name: "Start isolated final review" }).click();
  await expect(page).toHaveURL(/\/workbench\?runId=[^&]+$/);
  const runId = new URL(page.url()).searchParams.get("runId");
  expect(runId).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Final decision required" }),
  ).toBeVisible();
  return runId!;
}

async function fillDecision(
  page: Page,
  choice: "Approve" | "Reject",
  actor: string,
  rationale: string,
) {
  const finalRegion = page.locator(
    'section[aria-labelledby="final-decision-title"]',
  );
  await finalRegion.getByRole("radio", { name: choice }).check();
  await finalRegion.getByLabel("Declared actor").fill(actor);
  await finalRegion.getByLabel("Decision rationale").fill(rationale);
  return finalRegion;
}

test("loads the canonical v0.2 snapshot, validates approval, and gates the canonical export", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`,
    );
  });

  const runId = await startFinalReview(page);
  const beforeResponse = await page.request.get(`/api/runs/${runId}`);
  expect(beforeResponse.status()).toBe(200);
  const before = (await beforeResponse.json()) as BootstrapSnapshot;
  expect(before.run).toMatchObject({
    id: runId,
    schemaVersion: "0.2",
    evidenceMode: "fixture",
    status: "awaiting_final_approval",
    finalDecision: null,
  });

  await page.goto(
    `/workbench?runId=${encodeURIComponent(runId)}` +
      `&expectedRevision=${encodeURIComponent(before.revision)}` +
      "&dispositions=awaiting&scenario=approved" +
      "&packet=empty&matrix=empty&protocol=abstention",
  );
  await page.getByRole("link", { name: "02 Packet" }).click();
  await expect(page.getByText(before.run.packet!.fingerprint)).toBeVisible();
  await page.getByRole("link", { name: "08 Decision" }).click();
  await expect(
    page.getByRole("heading", { name: "Final decision required" }),
  ).toBeVisible();
  await expect(
    page.getByText("Safe protocol cannot be proposed responsibly from the current packet."),
  ).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  consoleErrors.length = 0;
  failedRequests.length = 0;

  const finalRegion = page.locator(
    'section[aria-labelledby="final-decision-title"]',
  );
  await expect(finalRegion.getByRole("radio", { name: "Approve" })).not.toBeChecked();
  await expect(finalRegion.getByRole("radio", { name: "Reject" })).not.toBeChecked();
  await expect(finalRegion.getByRole("link", { name: /Download/ })).toHaveCount(0);

  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByRole("radio", { name: "Approve" })).toBeFocused();
  await finalRegion.getByRole("radio", { name: "Approve" }).check();
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByLabel("Declared actor")).toBeFocused();
  await finalRegion.getByLabel("Declared actor").fill("Browser fixture reviewer");
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByLabel("Decision rationale")).toBeFocused();
  await finalRegion
    .getByLabel("Decision rationale")
    .fill("Approve only the bounded educational pilot.");

  await page.route("**/api/runs/*/checkpoints", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByRole("button", { name: "Persisting decision…" })).toBeDisabled();
  await expect(finalRegion.getByRole("link", { name: /Download/ })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Decision recorded · approve" }),
  ).toBeVisible();
  await expect(page.getByText("Approved with boundaries", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(
    failedRequests.every(
      (failure) => failure.includes("&_rsc=") && failure.endsWith("net::ERR_ABORTED"),
    ),
  ).toBe(true);
  failedRequests.length = 0;

  const receipt = page.getByTestId("final-decision-receipt");
  await expect(receipt).toContainText("Browser fixture reviewer");
  await expect(receipt).toContainText("Approve only the bounded educational pilot.");
  const exportLink = receipt.getByRole("link", {
    name: "Download canonical JSON",
  });
  const downloadPromise = page.waitForEvent("download");
  await exportLink.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(
    await readFile(downloadPath!, "utf8"),
  ) as BootstrapSnapshot["run"];
  expect(exported).toMatchObject({
    id: runId,
    schemaVersion: "0.2",
    evidenceMode: "fixture",
    status: "approved",
    packet: { fingerprint: before.run.packet!.fingerprint },
    finalDecision: {
      checkpoint: "final",
      optionsShown: ["approve", "reject"],
      decision: "approve",
      declaredActor: "Browser fixture reviewer",
      rationale: "Approve only the bounded educational pilot.",
      unresolvedObjections: ["gf-objection-degradation"],
    },
  });
  expect(exported.executions.map(({ id }) => id)).toEqual(
    before.run.executions.map(({ id }) => id),
  );
  expect(exported.errors.map(({ id }) => id)).toEqual(
    before.run.errors.map(({ id }) => id),
  );
  expect(
    exported.executions.every(({ evidenceMode }) => evidenceMode === "fixture"),
  ).toBe(true);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("records reject in a separate UI session", async ({ page }) => {
  const runId = await startFinalReview(page);
  const finalRegion = await fillDecision(
    page,
    "Reject",
    "Independent browser reviewer",
    "Reject while the recorded residual risk remains unresolved.",
  );
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(
    page.getByRole("heading", { name: "Decision recorded · reject" }),
  ).toBeVisible();
  await expect(page.getByTestId("final-decision-receipt")).toContainText(
    "Independent browser reviewer",
  );
  const stored = (await (
    await page.request.get(`/api/runs/${runId}`)
  ).json()) as BootstrapSnapshot;
  expect(stored.run.status).toBe("rejected");
});

test("rejects a contradictory 200 receipt, retains inputs, and never unlocks export", async ({
  page,
}) => {
  const runId = await startFinalReview(page);
  const before = (await (
    await page.request.get(`/api/runs/${runId}`)
  ).json()) as BootstrapSnapshot;
  const decidedAt = "2026-08-08T18:00:00.000Z";
  await page.route(`**/api/runs/${runId}/checkpoints`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revision: "contradictory-revision",
        run: {
          ...before.run,
          status: "approved",
          updatedAt: decidedAt,
          finalDecision: {
            id: "contradictory-final",
            checkpoint: "final",
            optionsShown: ["approve", "reject"],
            decision: "approve",
            edits: [],
            decidedAt,
            unresolvedObjections: ["gf-objection-degradation"],
            declaredActor: "Different actor",
            rationale: "Approve only the bounded educational pilot.",
          },
        },
      }),
    });
  });
  const finalRegion = await fillDecision(
    page,
    "Approve",
    "Browser fixture reviewer",
    "Approve only the bounded educational pilot.",
  );
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByRole("alert")).toContainText(
    "could not prove that the final decision was persisted",
  );
  await expect(finalRegion.getByLabel("Declared actor")).toHaveValue(
    "Browser fixture reviewer",
  );
  await expect(finalRegion.getByLabel("Decision rationale")).toHaveValue(
    "Approve only the bounded educational pilot.",
  );
  await expect(finalRegion.getByRole("link", { name: /Download/ })).toHaveCount(0);
  await expect(finalRegion).not.toContainText("Final decision persisted");
});

test("sanitizes a server failure, retains inputs, and never unlocks export", async ({
  page,
}) => {
  const runId = await startFinalReview(page);
  await page.route(`**/api/runs/${runId}/checkpoints`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "internal_error",
          message: "private-provider-token-must-not-render",
        },
      }),
    });
  });
  const finalRegion = await fillDecision(
    page,
    "Approve",
    "Failure-path reviewer",
    "Retain this rationale after a server failure.",
  );
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByRole("alert")).toContainText(
    "final decision was not saved",
  );
  await expect(finalRegion).not.toContainText("private-provider-token-must-not-render");
  await expect(finalRegion.getByLabel("Declared actor")).toHaveValue(
    "Failure-path reviewer",
  );
  await expect(finalRegion.getByLabel("Decision rationale")).toHaveValue(
    "Retain this rationale after a server failure.",
  );
  await expect(finalRegion.getByRole("link", { name: /Download/ })).toHaveCount(0);
});

test("handles stale-session reset without losing input or creating false success", async ({
  page,
}) => {
  const runId = await startFinalReview(page);
  await page.route(`**/api/runs/${runId}/checkpoints`, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "revision_conflict" } }),
    });
  });
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "run_not_found" } }),
    });
  });
  const finalRegion = await fillDecision(
    page,
    "Reject",
    "Reset-path reviewer",
    "Retain this rationale across the stale response.",
  );
  await finalRegion.getByRole("button", { name: "Persist final decision" }).click();
  await expect(finalRegion.getByRole("alert")).toContainText("Session reset");
  await expect(finalRegion.getByLabel("Declared actor")).toHaveValue(
    "Reset-path reviewer",
  );
  await expect(finalRegion.getByLabel("Decision rationale")).toHaveValue(
    "Retain this rationale across the stale response.",
  );
  await expect(finalRegion.getByRole("link", { name: /Download/ })).toHaveCount(0);

  await page.addScriptTag({ path: axeScriptPath });
  const violations = await page.evaluate(async () => {
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
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    );
  });
  expect(violations).toEqual([]);

  await page.setViewportSize({ width: 640, height: 360 });
  await finalRegion.scrollIntoViewIfNeeded();
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
});
