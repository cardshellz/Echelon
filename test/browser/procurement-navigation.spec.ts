import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";

function selectedTab(page: Page, name: RegExp) {
  return expect(page.getByRole("tab", { name })).toHaveAttribute("data-state", "active");
}

test("purchase -> shipment Costs -> invoice, native history, reload and copied-link return", async ({ page, context }) => {
  const failures = await installFixtures(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  await selectedTab(page, /^Shipments/);
  const shipmentLink = page.getByRole("link", { name: "TEST-SHIP-42", exact: true });
  await shipmentLink.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: /^Costs/ }).click();
  const costsUrl = page.url();
  await page.locator('a[href^="/ap-invoices/71"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "Invoice #TEST-INV-71", exact: true })).toBeVisible();
  const invoiceUrl = page.url();
  await page.reload();
  await expect(page.getByRole("link", { name: "Back to shipment #42", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to shipment #42", exact: true }).click();
  await expect(page).toHaveURL(costsUrl);
  await selectedTab(page, /^Costs/);
  await page.goBack();
  await expect(page).toHaveURL(invoiceUrl);
  await page.goForward();
  await selectedTab(page, /^Costs/);
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await selectedTab(page, /^Shipments/);

  const copied = await context.newPage();
  const copiedFailures = await installFixtures(copied);
  await copied.goto(invoiceUrl);
  await copied.getByRole("link", { name: "Back to purchase #17", exact: true }).click();
  await selectedTab(copied, /^Shipments/);
  expect(failures.concat(copiedFailures)).toEqual([]);
});

test("shared shipment -> other PO -> receipt absent from list retains original purchase", async ({ page }) => {
  const failures = await installFixtures(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("link", { name: "TEST-SHIP-42", exact: true }).click();
  await page.locator('a[href^="/purchase-orders/99"]').first().click();
  await page.getByRole("tab", { name: /^Receipts/ }).click();
  await page.getByRole("link", { name: "RO #31", exact: true }).click();
  const receiptUrl = page.url();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await page.reload();
  await expect(dialog.getByRole("heading", { name: /^Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Back to purchase #17", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await selectedTab(page, /^Receipts/);
  await page.goBack();
  await expect(page).toHaveURL(receiptUrl);
  await expect(dialog.getByRole("heading", { name: /^Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await dialog.getByRole("link", { name: "Back to purchase #17", exact: true }).click();
  await selectedTab(page, /^Shipments/);
  expect(failures).toEqual([]);
});

test("failed receipt retains its address, contextual exit and Retry", async ({ page }) => {
  const failures = await installFixtures(page);
  await page.goto("/purchase-orders/17?tab=receipts");
  let fail = true;
  await page.route("**/api/receiving/31", (route) => route.fulfill(fail ? { status: 403, json: { error: "Forbidden" } } : { json: receipt(31) }));
  await page.getByRole("link", { name: "RO #31", exact: true }).click();
  const address = page.url();
  await expect(page.getByRole("dialog").getByText(/do not have access/)).toBeVisible();
  await expect(page).toHaveURL(address);
  fail = false;
  await page.getByRole("dialog").getByRole("button", { name: /Retry/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: /^Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await expect(page).toHaveURL(address);
  expect(failures).toEqual([]);
});

test("a late receipt action cannot overwrite a later visit to the same receipt", async ({ page }) => {
  const failures = await installFixtures(page);
  const draft = { ...receipt(31), status: "draft" };
  await page.route("**/api/receiving", (route) => route.fulfill({ json: [draft, receipt(32)] }));
  await page.route("**/api/receiving/31", (route) => route.fulfill({ json: draft }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/receiving/31/open", async (route) => {
    await pending;
    await route.fulfill({ json: { ...draft, status: "open" } });
  });
  await page.goto("/receiving");
  await page.locator('a:visible').filter({ hasText: /^TEST-RECEIPT-31$/ }).click();
  const request = page.waitForRequest("**/api/receiving/31/open");
  await page.getByTestId("btn-open-receipt").click();
  await request;
  await page.goBack();
  await page.locator('a:visible').filter({ hasText: /^TEST-RECEIPT-32$/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: /^Receipt TEST-RECEIPT-32/ })).toBeVisible();
  await page.goBack();
  await page.locator('a:visible').filter({ hasText: /^TEST-RECEIPT-31$/ }).click();
  await expect(page.getByTestId("btn-open-receipt")).toBeDisabled();
  release();
  // Enabled means the mutation observer settled, including its onSuccess.
  await expect(page.getByTestId("btn-open-receipt")).toBeEnabled();
  await expect(page.getByRole("dialog").getByRole("heading", { name: /^Receipt TEST-RECEIPT-31 Draft/ })).toBeVisible();
  expect(failures).toEqual([]);
});

test("invalid receipt URLs retain an exit and never fetch a coerced record", async ({ page }) => {
  const failures = await installFixtures(page);
  const recordReads: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/receiving\//.test(request.url())) recordReads.push(request.url());
  });
  await page.goto("/receiving?open=01&purchase=purchase%3A17%3Areceipts");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/invalid receipt ID/)).toBeVisible();
  await dialog.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await selectedTab(page, /^Receipts/);
  expect(recordReads).toEqual([]);
  expect(failures).toEqual([]);
});
