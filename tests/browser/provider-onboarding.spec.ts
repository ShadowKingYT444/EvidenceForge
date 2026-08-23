import { expect, test } from "@playwright/test";

test("opens one provider dialog at a time and restores focus on Escape", async ({ page }, testInfo) => {
  await page.goto("/");
  const featherless = page.getByRole("button", { name: /Featherless/ });
  await featherless.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("API key")).toHaveAttribute("type", "password");
  await page.getByRole("dialog").getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("dialog").getByLabel("API key")).toHaveAttribute("type", "text");
  await expect(page.getByRole("dialog").getByLabel("Model ID")).toHaveValue("mistralai/Mistral-Large-Instruct-2411");
  await page.screenshot({ path: testInfo.outputPath("provider-dialog.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(featherless).toBeFocused();
});

test("clears key, reveal, and model state on every dialog close path", async ({ page }) => {
  await page.goto("/");
  const provider = page.getByRole("button", { name: /Featherless/ });
  const dialog = page.getByRole("dialog");
  const closePaths = ["cancel", "close", "escape", "programmatic"] as const;
  for (const closePath of closePaths) {
    await provider.click();
    await dialog.getByLabel("API key").fill("session-secret");
    await dialog.getByLabel("Model ID").fill("private/model-id");
    await dialog.getByRole("button", { name: "Show" }).click();
    if (closePath === "cancel") await dialog.getByRole("button", { name: "Cancel" }).click();
    if (closePath === "close") await dialog.getByRole("button", { name: "Close provider dialog" }).click();
    if (closePath === "escape") await page.keyboard.press("Escape");
    if (closePath === "programmatic") await page.evaluate(() => document.querySelector<HTMLDialogElement>("dialog")?.close());
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("#provider-key")).toHaveCount(0);
    await provider.click();
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await expect(dialog.getByLabel("API key")).toHaveAttribute("type", "password");
    await expect(dialog.getByLabel("Model ID")).toHaveValue("mistralai/Mistral-Large-Instruct-2411");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
});

test("mocks a bounded successful check, clears the key, and never persists it", async ({ page }) => {
  const secret = "sk-browser-secret-that-must-not-escape";
  await page.route("**/api/providers/test", async (route) => {
    const body = route.request().postDataJSON() as { apiKey: string };
    expect(body.apiKey).toBe(secret);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, provider: "featherless", model: "mistralai/Mistral-Large-Instruct-2411", latencyMs: 42, evidenceMode: "live" }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Featherless/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("API key").fill(secret);
  await dialog.getByRole("button", { name: "Verify key" }).click();
  await expect(dialog).toContainText("Connection verified");
  await expect(dialog.getByLabel("API key")).toHaveValue("");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, url: location.href }))).toEqual({ local: 0, session: 0, url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 3100}/` });
  await expect(page.locator("body")).not.toContainText(secret);
});

test("shows a sanitized failure and fixture navigation", async ({ page }) => {
  await page.route("**/api/providers/test", async (route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "provider_failure", message: "The provider rejected this connection." } }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /DeepSeek/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("API key").fill("not-a-real-key");
  await dialog.getByRole("button", { name: "Verify key" }).click();
  await expect(dialog).toContainText("The provider rejected this connection.");
  await expect(page.getByRole("link", { name: /Use recorded fixture/ })).toHaveAttribute("href", "/intake?demo=golden");
});
