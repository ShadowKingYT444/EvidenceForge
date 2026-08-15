import { expect, type Locator, type Page } from "@playwright/test";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export async function expectContainedFocus({
  page,
  boundary,
  initialFocus,
  trigger,
}: {
  page: Page;
  boundary: Locator;
  initialFocus: Locator;
  trigger: Locator;
}) {
  await expect(initialFocus).toBeFocused();

  await expect
    .poll(() =>
      boundary.evaluate((root, selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
          (element) =>
            !root.contains(element) &&
            !element.closest("[inert]") &&
            element.getClientRects().length > 0,
        ).length,
      focusableSelector),
    )
    .toBe(0);

  const focusable = boundary.locator(focusableSelector);
  const first = focusable.first();
  const last = focusable.last();

  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();

  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();

  await last.focus();
  await page.keyboard.press("Escape");
  await expect(boundary).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
