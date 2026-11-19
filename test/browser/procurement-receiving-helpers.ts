import type { Page } from "@playwright/test";

/** Exercise the same progressive disclosure controls used by receipt operators. */
export async function openReceivingSetup(page: Page): Promise<void> {
  const summary = page.locator('summary[aria-label="Receiving setup"]');
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
}

export async function openReceivingLineOptions(page: Page, lineId: number): Promise<void> {
  const details = page.getByTestId(`receipt-line-options-${lineId}`);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}

export async function openReceivingPackSelector(page: Page, lineId: number): Promise<void> {
  const summary = page.locator(`summary[aria-label="Change receive pack for line ${lineId}"]`);
  // A missing recorded factor already exposes its required confirmation controls.
  if (await summary.count() > 0 && await summary.locator("..").getAttribute("open") === null) await summary.click();
}

export async function openReceivingMoreActions(page: Page): Promise<void> {
  const summary = page.getByTestId("receipt-workspace").locator("summary").filter({ hasText: /^More actions$/ });
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
}
