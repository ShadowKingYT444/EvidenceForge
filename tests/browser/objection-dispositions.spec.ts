import { expect, test } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { SIMULATED_OBJECTION_RUN_ID } from "../../src/features/workbench/workbench-query-policy";

const simulatedCheckpointRoute =
  `**/api/runs/${SIMULATED_OBJECTION_RUN_ID}/checkpoints`;

test.describe("objection dispositions and selective revision", () => {
  test("shows accepted-only changes, causal objections, and unresolved final risk", async ({
    page,
  }) => {
    await page.goto("/workbench");
    const panel = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });

    await expect(panel).toBeVisible();
    await expect(panel.getByText("Recorded fixture · read-only", { exact: true })).toBeVisible();
    const accepted = panel.getByTestId("objection-gf-objection-calibration");
    await expect(accepted.getByText("Accepted", { exact: true })).toBeVisible();
    await expect(accepted.getByText("Before", { exact: true })).toBeVisible();
    await expect(accepted.getByText("After", { exact: true })).toBeVisible();
    await expect(accepted.getByText(goldenRunV01.review!.objections[0]!.rationale)).toBeVisible();

    const unresolved = panel.getByTestId("objection-gf-objection-degradation");
    await expect(unresolved.getByText("Unresolved", { exact: true })).toBeVisible();
    await expect(unresolved.getByText("No field change", { exact: true })).toBeVisible();
    await expect(unresolved.getByText(/remains unresolved at final approval/i)).toBeVisible();
    await expect(unresolved.getByText("After", { exact: true })).toHaveCount(0);
  });

  test("requires bases, supports keyboard dispositions, and submits the process-local checkpoint contract", async ({
    page,
  }) => {
    await page.route(simulatedCheckpointRoute, async (route) => {
      const requestBody = route.request().postDataJSON();
      expect(requestBody).toMatchObject({
        checkpoint: "objection_dispositions",
        expectedRevision: "revision-7",
        decision: {
          checkpoint: "objection_dispositions",
          optionsShown: ["approve", "request revision", "reject"],
          decision: "approve",
        },
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: "revision-8",
          run: {
            id: SIMULATED_OBJECTION_RUN_ID,
            status: "revising_experiment",
            objectionDispositionDecision: requestBody.decision,
          },
        }),
      });
    });
    const href = "/workbench?dispositions=awaiting&expectedRevision=revision-7";
    await page.goto(href);
    const panel = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    await expect(panel.getByText("Process-local checkpoint", { exact: true })).toBeVisible();
    await expect(panel.getByText("simulated", { exact: true })).toBeVisible();

    const first = panel.getByTestId("objection-gf-objection-calibration");
    const accept = first.getByRole("radio", { name: "Accept objection" });
    await accept.focus();
    await page.keyboard.press("Space");
    await expect(accept).toBeChecked();

    await panel.getByRole("button", { name: "Save dispositions" }).click();
    const validation = panel.getByRole("alert");
    await expect(validation).toContainText(/basis is required/i);
    await expect(first.getByRole("textbox", { name: "Human basis" })).toBeFocused();

    await first.getByRole("textbox", { name: "Human basis" }).fill(
      "Independent calibration is required before testing.",
    );
    const second = panel.getByTestId("objection-gf-objection-degradation");
    await second.getByRole("textbox", { name: "Human basis" }).fill(
      "Qualified degradation evidence is still missing.",
    );
    await panel.getByRole("button", { name: "Save dispositions" }).click();

    const saved = panel.getByRole("status");
    await expect(saved).toBeFocused();
    await expect(saved).toContainText(/saved to this process-local run/i);
    await expect(saved).toContainText(/selective revision is pending/i);
    await expect(first.getByText("After", { exact: true })).toHaveCount(0);
  });

  test("retains inputs on stale failure, never shows false success, and fails closed for denied evidence", async ({
    page,
  }) => {
    await page.route(simulatedCheckpointRoute, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "revision_conflict",
            message: "private-sentinel raw server detail",
          },
        }),
      });
    });
    await page.goto(
      "/workbench?dispositions=awaiting&expectedRevision=stale-revision",
    );
    const panel = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    const basis = panel
      .getByTestId("objection-gf-objection-calibration")
      .getByRole("textbox", { name: "Human basis" });
    await basis.fill("Retain this human-authored stale basis.");
    await panel
      .getByTestId("objection-gf-objection-degradation")
      .getByRole("textbox", { name: "Human basis" })
      .fill("Retain unresolved basis too.");
    await panel.getByRole("button", { name: "Save dispositions" }).click();

    await expect(panel.getByRole("alert")).toContainText(/run changed/i);
    await expect(basis).toHaveValue("Retain this human-authored stale basis.");
    await expect(panel.getByText(/saved to this process-local run/i)).toHaveCount(0);
    await expect(page.getByText(/private-sentinel/i)).toHaveCount(0);

    await page.goto("/workbench?packet=denied");
    const denied = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    await expect(denied.getByRole("alert")).toContainText(/not permitted for display/i);
    await expect(denied.getByRole("radio")).toHaveCount(0);
  });

  test("refuses a contradictory 200 receipt and retains the human inputs", async ({
    page,
  }) => {
    await page.route(simulatedCheckpointRoute, async (route) => {
      const requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: "revision-8",
          run: {
            id: SIMULATED_OBJECTION_RUN_ID,
            status: "revising_experiment",
            objectionDispositionDecision: {
              ...requestBody.decision,
              edits: ["different-objection: rejected"],
              unresolvedObjections: ["different-objection"],
            },
          },
        }),
      });
    });
    await page.goto(
      "/workbench?dispositions=awaiting&expectedRevision=revision-7",
    );
    const panel = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    const first = panel.getByTestId("objection-gf-objection-calibration");
    const firstBasis = first.getByRole("textbox", { name: "Human basis" });
    await first.getByRole("radio", { name: "Accept objection" }).check();
    await firstBasis.fill("Retain this basis after a contradictory receipt.");
    await panel
      .getByTestId("objection-gf-objection-degradation")
      .getByRole("textbox", { name: "Human basis" })
      .fill("Retain the unresolved basis too.");

    await panel.getByRole("button", { name: "Save dispositions" }).click();

    await expect(panel.getByRole("alert")).toContainText(
      /could not prove that dispositions were persisted/i,
    );
    await expect(firstBasis).toHaveValue(
      "Retain this basis after a contradictory receipt.",
    );
    await expect(panel.getByText(/saved to this process-local run/i)).toHaveCount(0);
  });
});
