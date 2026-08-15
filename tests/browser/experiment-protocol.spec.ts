import { expect, test } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";

test.describe("experiment protocol inspector", () => {
  test("shows the bounded protocol, power warning, safety gate, and inference limits", async ({
    page,
  }) => {
    await page.goto("/workbench#experiment");

    const inspector = page.getByRole("region", {
      name: "Experiment protocol inspector",
    });
    await expect(inspector).toBeVisible();
    await expect(
      inspector.getByRole("heading", { name: "Experiment protocol" }),
    ).toBeVisible();
    await expect(inspector.getByText("fixture", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Hypothesis", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Null hypothesis", { exact: true })).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.experiment!.hypothesis, { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByRole("alert").filter({ hasText: /power assumptions are missing/i }),
    ).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.experiment!.missingPowerAssumptions[0]!, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      inspector.getByText("Qualified human review required", { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByText("What this outcome establishes", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      inspector
        .getByText("What this outcome does not establish", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      inspector.getByText(
        goldenRunV01.experiment!.expectedOutcomeBranches[0]!.doesNotEstablish,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      inspector.getByText(goldenRunV01.experiment!.procedure[0]!, { exact: true }),
    ).toHaveCount(0);
  });

  test("supports a disclosed cannot-propose-responsibly state", async ({
    page,
  }) => {
    await page.goto("/workbench?protocol=abstention");

    const inspector = page.getByRole("region", {
      name: "Experiment protocol inspector",
    });
    await expect(
      inspector.getByRole("heading", { name: "Cannot propose responsibly" }),
    ).toBeVisible();
    await expect(inspector.getByText("simulated", { exact: true })).toBeVisible();
    await expect(
      inspector.getByText(/safe protocol cannot be proposed responsibly/i),
    ).toBeVisible();
    await expect(
      inspector.getByRole("heading", { name: "Missing inputs" }),
    ).toBeVisible();
    await expect(
      inspector.getByText("Qualified safety review", { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByText(/obtain the missing review and evidence/i),
    ).toBeVisible();
    await expect(inspector.getByText("Hypothesis", { exact: true })).toHaveCount(0);
  });
});
