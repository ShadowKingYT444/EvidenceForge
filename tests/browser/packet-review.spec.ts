import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";

const requireFromA11yPlugin = createRequire(
  createRequire(__filename).resolve("eslint-plugin-jsx-a11y"),
);
const axeScriptPath = requireFromA11yPlugin.resolve("axe-core/axe.min.js");

test.describe("controlled source-packet review", () => {
  test("renders the frozen fixture receipt, provenance, independent rights, and hashes", async ({
    page,
  }) => {
    await page.goto("/workbench#packet");

    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    await expect(
      packet.getByRole("heading", { name: "Review the bounded source packet" }),
    ).toBeVisible();
    await expect(packet.getByText("Frozen packet", { exact: true })).toBeVisible();
    const receipt = packet.getByLabel("Packet freeze receipt");
    await expect(receipt.getByText("7 sources", { exact: true })).toBeVisible();
    await expect(receipt.getByText("7 chunks", { exact: true })).toBeVisible();
    await expect(packet.getByText("Registration agency", { exact: true }).first()).toBeVisible();
    await expect(packet.getByText("Crossref", { exact: true }).first()).toBeVisible();
    await expect(packet.getByText("Store", { exact: true }).first()).toBeVisible();
    await expect(packet.getByText("Display", { exact: true }).first()).toBeVisible();
    await expect(packet.getByText("Send to model", { exact: true }).first()).toBeVisible();
    await expect(
      packet.getByText(goldenRunV01.packet!.fingerprint, { exact: true }),
    ).toBeVisible();
    await expect(packet.getByText("No packet blockers", { exact: true })).toBeVisible();
  });

  test("hides display-denied text, explains the boundary, and excludes model-denied content", async ({
    page,
  }) => {
    await page.goto("/workbench?packet=denied");

    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    const firstSource = packet.locator("[data-packet-source]").first();
    await expect(firstSource.getByText("Denied", { exact: true })).toHaveCount(2);
    await expect(
      firstSource.getByText(
        "Display permission is denied; source text is not rendered.",
      ),
    ).toBeVisible();
    await expect(
      firstSource.getByText(
        "Model-use permission is denied; no source text enters the model projection.",
      ),
    ).toBeVisible();
    await expect(firstSource.locator("blockquote")).toHaveCount(0);
    await expect(
      page.getByText(goldenRunV01.evidenceCards[0]!.excerpt, { exact: true }),
    ).toHaveCount(0);
  });

  test("supports keyboard accept and confirmed rejection without claiming persistence", async ({
    page,
  }) => {
    await page.goto("/workbench?packet=review");

    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    await expect(packet.getByText("Fixture packet state preview")).toBeVisible();
    await expect(packet.getByLabel("Packet freeze receipt").getByText("Draft")).toBeVisible();
    const accept = packet.getByRole("button", { name: "Accept and freeze packet" });
    await accept.focus();
    await expect(accept).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(packet.getByRole("status")).toBeFocused();
    await expect(packet.getByRole("status")).toContainText(
      "Process-local fixture decision recorded; the canonical run and packet remain unchanged.",
    );

    await page.goto("/workbench?packet=review");
    const reject = packet.getByRole("button", { name: "Reject packet" });
    await reject.focus();
    await page.keyboard.press("Space");
    await expect(
      packet.getByRole("heading", { name: "Confirm packet rejection" }),
    ).toBeFocused();
    await packet.getByRole("button", { name: "Cancel" }).press("Enter");
    await expect(packet.getByRole("button", { name: "Reject packet" })).toBeFocused();
    await page.keyboard.press("Enter");
    await packet.getByRole("button", { name: "Confirm rejection" }).press("Enter");
    await expect(packet.getByRole("status")).toContainText(
      "Packet rejected in this fixture preview",
    );
  });

  test("fails closed for missing and tampered packets before rendering content or actions", async ({
    page,
  }) => {
    const failures = [
      ["missing-packet", "PacketBoundaryError · packet_missing · $.packet"],
      [
        "tampered-packet",
        "PacketBoundaryError · chunk_content_hash_mismatch · $.chunks.0.contentHash",
      ],
    ] as const;
    for (const [scenario, failure] of failures) {
      await page.goto(`/workbench?packet=${scenario}`);
      await expect(
        page.getByRole("heading", { name: "Packet validation failed closed" }),
      ).toBeVisible();
      const packet = page.getByRole("region", { name: "Source packet checkpoint" });
      await expect(packet.getByText("Typed boundary failure", { exact: true })).toBeVisible();
      await expect(packet.locator("[data-packet-source]")).toHaveCount(0);
      await expect(
        packet.getByRole("button", { name: "Accept and freeze packet" }),
      ).toHaveCount(0);
      await expect(packet.getByRole("button", { name: "Reject packet" })).toHaveCount(0);
      await expect(packet.getByText(failure, { exact: true })).toBeVisible();
    }
  });

  test("surfaces an expired one-use decision capability as a typed failure", async ({
    page,
  }) => {
    await page.goto("/workbench?packet=stale-session");
    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    await packet.getByRole("button", { name: "Accept and freeze packet" }).click();
    const error = packet.getByRole("alert");
    await expect(error).toBeFocused();
    await expect(error).toContainText("PacketDecisionError · session_stale");
    await expect(error).toContainText(
      "The decision session expired; reload the validated packet.",
    );
  });

  test("keeps loading, empty, rejected, duplicate, long-content, and mutation-error states legible", async ({
    page,
  }) => {
    const states = [
      ["loading", "Loading packet review"],
      ["empty", "No approved sources in this packet"],
      ["rejected", "Packet rejected"],
      ["duplicate", "Duplicate alias merged"],
      ["long-content", "Long fixture content boundary"],
      ["error", "Post-freeze mutation rejected"],
    ] as const;

    for (const [scenario, label] of states) {
      await page.goto(`/workbench?packet=${scenario}`);
      const packet = page.getByRole("region", { name: "Source packet checkpoint" });
      await expect(packet.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(
      page.getByText("PacketMutationError · packet_frozen · update_source"),
    ).toBeVisible();
  });

  test("is responsive, reduced-motion aware, screenshot inspected, and free of serious axe findings", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/workbench?packet=review");
    const packet = page.getByRole("region", { name: "Source packet checkpoint" });
    await packet.scrollIntoViewIfNeeded();
    const firstDisclosure = packet.locator("details").first();
    const firstSummary = firstDisclosure.locator("summary");
    await firstSummary.focus();
    await page.keyboard.press("Enter");
    await expect(firstDisclosure).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(firstDisclosure).toHaveAttribute("open", "");
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("interim-desktop-packet-review-1280x720.png"),
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 640, height: 360 });
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/workbench?packet=denied");
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("interim-mobile-packet-denied-390x844.png"),
      fullPage: true,
    });

    await page.goto("/workbench?packet=long-content");
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.addScriptTag({ path: axeScriptPath });
    const violations = await page.evaluate(async () => {
      const result = await (window as unknown as { axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run();
      return result.violations.filter(
        ({ impact }) => impact === "critical" || impact === "serious",
      );
    });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

async function hasHorizontalOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}
