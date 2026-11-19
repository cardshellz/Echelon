import type { Locator, Page } from "@playwright/test";

export async function openCompletedCosts(root: Page | Locator) {
  const details = root.getByTestId("completed-costs").first();
  await details.waitFor({ state: "attached" });
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
  return details;
}

export async function openReceiptCostHistory(page: Page) {
  const summary = page.getByText("Receipt cost processing history", { exact: true });
  const details = summary.locator("..");
  if (await details.getAttribute("open") === null) await summary.click();
}
