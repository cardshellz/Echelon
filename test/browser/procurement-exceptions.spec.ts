import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

const exceptionUrl = "/purchase-orders/17?tab=exceptions&purchase=purchase%3A17%3Aexceptions";

async function setup(page: Page, options: { payload?: unknown; kind?: string; status?: string; invoiceFailure?: boolean } = {}) {
  const failures = await installFixtures(page);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
      failures.push(`Review navigation must be read-only: ${request.method()} ${request.url()}`);
    }
  });
  const mismatch = {
    id: 81, poId: 17, kind: options.kind ?? "match_mismatch", severity: "warn", status: options.status ?? "open",
    title: "3-way match discrepancy — Invoice TEST-INV-71",
    message: "Invoice TEST-INV-71 has 1 line with match issues: price_discrepancy.",
    payload: Object.prototype.hasOwnProperty.call(options, "payload") ? options.payload : { invoiceId: 71, invoiceNumber: "TEST-INV-71", mismatchedLineIds: [72] },
    detectedAt: "2026-09-01T12:00:00Z", detectedBy: "system",
  };
  await page.route("**/api/purchase-orders/17", (route) => route.fulfill({ json: {
    ...po(17), status: "received", physicalStatus: "received", financialStatus: "paid", receivedTotalQty: 10,
    lines: [{ id: 18, lineNumber: 1, lineType: "product", sku: "MISMATCH-SKU", productName: "Synthetic product", orderQty: 10,
      receivedQty: 10, unitCostCents: 1000, unitCostMills: 100000, lineTotalCents: 10000, status: "received" }],
  } }));
  await page.route("**/api/purchase-orders/17/exceptions*", (route) => route.fulfill({ json: { exceptions: [mismatch] } }));
  await page.route("**/api/vendor-invoices/71", (route) => route.fulfill(options.invoiceFailure
    ? { status: 403, json: { error: "Forbidden" } }
    : { json: {
      id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", status: "paid", currency: "USD",
      invoicedAmountCents: 11000, balanceCents: 0, paidAmountCents: 11000, attachments: [], payments: [],
      poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "TEST-PO-17" }],
      lines: [{ id: 72, lineNumber: 1, purchaseOrderLineId: 18, sku: "MISMATCH-SKU", productName: "Synthetic product",
        qtyInvoiced: 10, qtyOrdered: 10, qtyReceived: 10, unitCostCents: 1100, unitCostMills: 110000,
        lineTotalCents: 11000, matchStatus: "price_discrepancy" }],
    } }));
  await page.goto(exceptionUrl);
  await expect(page.getByRole("tab", { name: /^Exceptions/ })).toHaveAttribute("data-state", "active");
  return failures;
}

test("opens invoice match issues by keyboard and returns to PO Exceptions after reload and a copied link", async ({ page, context }, testInfo) => {
  const failures = await setup(page);
  await expect(page.getByText("Status: Open", { exact: true })).toBeVisible();
  const review = page.getByRole("link", { name: "Open invoice issues", exact: true });
  await expect(review).toBeVisible();
  await expect(page.getByRole("link", { name: "View PO lines", exact: true })).toBeVisible();
  await review.scrollIntoViewIfNeeded();
  const bounds = await review.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath("po-exception-review-links.png"), fullPage: true });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Invoice #TEST-INV-71", exact: true })).toBeVisible();
  await expect(page.getByText("Price Mismatch", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "TEST-PO-17", exact: true })).toBeVisible();
  const invoiceUrl = page.url();
  await page.reload();
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).last().click();
  await expect(page).toHaveURL(exceptionUrl);
  await expect(page.getByRole("tab", { name: /^Exceptions/ })).toHaveAttribute("data-state", "active");
  await page.goBack();
  await expect(page).toHaveURL(invoiceUrl);

  const copied = await context.newPage();
  const copiedFailures = await setup(copied);
  await copied.goto(invoiceUrl);
  await copied.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await expect(copied).toHaveURL("/purchase-orders/17?tab=exceptions");
  await expect(copied.getByRole("tab", { name: /^Exceptions/ })).toHaveAttribute("data-state", "active");
  expect(failures.concat(copiedFailures)).toEqual([]);
});

test("links an acknowledged exception to PO lines for comparison and keeps its Exceptions return", async ({ page }) => {
  const failures = await setup(page, { status: "acknowledged" });
  await expect(page.getByText("Status: Acknowledged", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View PO lines", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Lines/ })).toHaveAttribute("data-state", "active");
  await expect(page.locator("span:visible").filter({ hasText: /^MISMATCH-SKU$/ })).toBeVisible();
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).last().click();
  await expect(page).toHaveURL(exceptionUrl);
  await expect(page.getByRole("tab", { name: /^Exceptions/ })).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});

for (const payload of [null, { invoiceId: "71", invoiceNumber: "TEST-INV-71" }]) {
  test(`keeps a usable PO link when the invoice reference is ${payload === null ? "missing" : "invalid"}`, async ({ page }) => {
    const failures = await setup(page, { payload });
    await expect(page.getByRole("link", { name: "Open invoice issues", exact: true })).toHaveCount(0);
    await expect(page.getByText("Invoice link unavailable for this exception.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "View PO lines", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Lines/ })).toHaveAttribute("data-state", "active");
    expect(failures).toEqual([]);
  });
}

test("retains the PO return when the linked invoice cannot be loaded", async ({ page }) => {
  const failures = await setup(page, { invoiceFailure: true });
  await page.getByRole("link", { name: "Open invoice issues", exact: true }).click();
  await expect(page.getByText("Unable to load invoice.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).last().click();
  await expect(page).toHaveURL(exceptionUrl);
  await expect(page.getByRole("tab", { name: /^Exceptions/ })).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});
