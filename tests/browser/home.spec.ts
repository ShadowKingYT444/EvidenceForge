import { expect, test } from "@playwright/test";

test("renders the deterministic fixture scaffold without live credentials", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "EvidenceForge" }),
  ).toBeVisible();
  await expect(page.getByText("Fixture mode", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No live provider credentials required", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-evidence-mode]")).toHaveAttribute(
    "data-evidence-mode",
    "fixture",
  );
});
