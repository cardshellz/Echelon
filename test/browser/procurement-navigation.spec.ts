import { expect, test, type Page } from "@playwright/test";

// Deliberately fictional documents. Empty receiving list proves detail loading
// is independent of list pagination/filtering. Mutations fail every test.
const po = (id: number) => ({ id, poNumber: `TEST-PO-${id}`, status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "unpaid", vendorId: 2, vendor: { name: "Test vendor" }, lines: [], subtotalCents: 10000, totalCents: 10000 });
const shipment = { id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", purchaseOrderId: 17, lines: [{ id: 1, purchaseOrderId: 99, purchaseOrderLineId: 1, sku: "TEST-SKU", productName: "Test product", qtyShipped: 10, cartonCount: 1 }], costs: [{ id: 1, costType: "freight", description: "Test freight", estimatedCents: 10000, actualCents: 10000, linkedInvoice: { id: 71, invoiceNumber: "TEST-INV-71", status: "paid" } }], statusHistory: [] };
const invoice = { id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", inboundShipmentId: 42, shipmentNumber: "TEST-SHIP-42", status: "paid", invoicedAmountCents: 10000, balanceCents: 0, paidAmountCents: 10000, lines: [], poLinks: [{ id: 1, purchaseOrderId: 99, poNumber: "TEST-PO-99" }], attachments: [], payments: [] };
const receipt = (id: number) => ({ id, receiptNumber: `TEST-RECEIPT-${id}`, createdAt: "2026-09-01T12:00:00Z", status: "closed", purchaseOrderId: 99, inboundShipmentId: 42, lines: [], vendorId: 2, vendorName: "Test vendor" });

async function installFixtures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      failures.push(`Unexpected mutation: ${request.method()} ${request.url()}`);
      return route.abort();
    }
    const path = new URL(request.url()).pathname;
    let json: unknown = [];
    if (path === "/api/auth/me") json = { user: { id: "test-user", username: "test", role: "admin" }, permissions: [], roles: ["admin"] };
    else if (path === "/api/settings/procurement") json = { useNewPoEditor: true };
    else if (/^\/api\/purchase-orders\/(17|99)$/.test(path)) json = po(Number(path.split("/").at(-1)));
    else if (/\/purchase-orders\/\d+\/shipments$/.test(path)) json = [shipment];
    else if (/\/purchase-orders\/\d+\/receipts$/.test(path)) json = { receipts: [{ id: 1, receivingOrderId: 31, purchaseOrderLineId: 1, qtyReceived: 10 }] };
    else if (/\/purchase-orders\/\d+\/invoices$/.test(path)) json = { invoices: [invoice] };
    else if (/\/purchase-orders\/\d+\/exceptions$/.test(path)) json = { exceptions: [] };
    else if (/\/purchase-orders\/\d+\/history$/.test(path)) json = { history: [] };
    else if (path === "/api/purchase-orders") json = { purchaseOrders: [] };
    else if (path === "/api/inbound-shipments/42") json = shipment;
    else if (path === "/api/inbound-shipments/42/allocation-status") json = { issues: [], costs: [], status: "allocated", blockerCount: 0, warningCount: 0, lineCount: 1, allocatableCostCount: 1, effectiveCostCents: 10000, unallocatedCents: 0 };
    else if (path === "/api/inbound-shipments/42/invoices") json = { invoices: [invoice], summary: { invoiceCount: 1 } };
    else if (path === "/api/vendor-invoices/71") json = invoice;
    else if (/^\/api\/receiving\/\d+$/.test(path)) json = receipt(Number(path.split("/").at(-1)));
    else if (path.endsWith("/validation-warnings")) json = { warnings: [] };
    else if (path.endsWith("/reversals")) json = { reversals: [] };
    await route.fulfill({ json });
  });
  return failures;
}

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
