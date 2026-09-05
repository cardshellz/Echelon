import { expect, test, type Page } from "@playwright/test";
import type { PurchaseWorkspace } from "../../shared/procurement/purchase-workspace";
import { installFixtures, po } from "./procurement-fixtures";

// Fictional shared/split documents exercise scope and navigation, never live data.
function workspace(): PurchaseWorkspace {
  const receipt = (id: number, purchaseOrderId: number, inboundShipmentId: number | null, status: string) => ({
    id, receiptNumber: `TEST-RECEIPT-${id}`, purchaseOrderId, inboundShipmentId, status,
    expectedDate: null, receivedDate: null, closedDate: null,
  });
  const shipment = (id: number, status: string) => ({
    id, shipmentNumber: `TEST-SHIP-${id}`, status, mode: "sea_fcl", containerNumber: "TEST-CONTAINER",
    eta: "2026-10-01T12:00:00Z", deliveredDate: null, estimatedTotalCostCents: 99999999,
    actualTotalCostCents: 88888888, amountScope: "whole_shipment" as const,
    purchaseOrderIds: [17, 99], unlinkedLineCount: 0,
    lines: [{ id, purchaseOrderId: 17, purchaseOrderLineId: 171, purchaseOrderLinePurchaseOrderId: 17,
      sku: "TEST-SKU", qtyShipped: 10, allocatedCostCents: null }],
  });
  return {
    purchase: {
      id: 17, poNumber: "TEST-PO-17", status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "partially_paid",
      currency: "USD", vendorName: "Test vendor", totalCents: 10000,
      // These stored rollups are deliberately unsuitable as purchase-specific totals.
      invoicedTotalCents: 99999999, paidTotalCents: 88888888, outstandingCents: 77777777,
      expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null,
      lines: [{ id: 171, sku: "TEST-SKU", productName: "Test product", lineType: "product", orderedQty: 100,
        receivedQty: 0, cancelledQty: 0, quantityBasis: "pieces" }],
    },
    shipments: [shipment(42, "booked"), shipment(43, "cancelled")],
    receipts: [receipt(31, 17, 42, "draft"), receipt(32, 99, 42, "closed"), receipt(33, 17, null, "cancelled")],
    invoices: [{ id: 71, invoiceNumber: "TEST-INV-71", status: "paid", currency: "USD", invoiceDate: null, dueDate: null,
      inboundShipmentId: 42, invoicedAmountCents: 20000, paidAmountCents: 20000, balanceCents: 0,
      amountScope: "whole_invoice", allocatedToPurchaseCents: 7500, purchaseOrderIds: [17, 99] }],
    edges: [
      { from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 42 }, relationship: "purchase_shipment" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 43 }, relationship: "purchase_shipment" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "receipt", id: 31 }, relationship: "purchase_receipt" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "receipt", id: 33 }, relationship: "purchase_receipt" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "invoice", id: 71 }, relationship: "purchase_invoice" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "receipt", id: 31 }, relationship: "shipment_receipt" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "receipt", id: 32 }, relationship: "shipment_receipt" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "invoice", id: 71 }, relationship: "shipment_invoice" },
    ],
    limitations: ["Recorded links only; receipt status does not establish availability for sale."],
  };
}

async function setup(page: Page) {
  const failures = await installFixtures(page);
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: workspace() }));
  return failures;
}

const inspector = (page: Page) => page.getByTestId("purchase-record-inspector");
const overviewLink = (page: Page, record: string) => page.locator(`[data-workspace-record="${record}"]`);

test("committed purchase opens its lifecycle, keeping split/shared and draft/cancelled records visible", async ({ page }, testInfo) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17");
  await expect(page.getByRole("tab", { name: "Lifecycle", exact: true })).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("purchase-lifecycle-workspace")).toBeVisible();
  await expect(page.getByRole("list", { name: "Receipts for shipment TEST-SHIP-42" }).getByText("TEST-RECEIPT-32", { exact: true })).toBeVisible();
  await expect(overviewLink(page, "receipt:31")).toBeVisible();
  await expect(overviewLink(page, "receipt:33")).toBeVisible();
  await expect(overviewLink(page, "shipment:43")).toBeVisible();
  await expect(page.getByText("Shared shipment · includes other purchase orders")).toHaveCount(2);
  await overviewLink(page, "purchase:17").click();
  await expect(inspector(page).getByRole("heading", { name: "TEST-PO-17", exact: true })).toBeFocused();
  await expect(inspector(page)).not.toContainText("999,999.99");
  await expect(inspector(page)).not.toContainText("888,888.88");
  await expect(inspector(page)).not.toContainText("777,777.77");
  await page.screenshot({ path: testInfo.outputPath("purchase-lifecycle.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("inline inspector supports keyboard, connected records, history, refresh, copied link and full-record return", async ({ page, context }, testInfo) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await overviewLink(page, "shipment:42").focus();
  await page.keyboard.press("Enter");
  const title = inspector(page).getByRole("heading", { name: "Shipment TEST-SHIP-42", exact: true });
  await expect(title).toBeFocused();
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(page.viewportSize()!.height);
  expect(new URL(page.url()).pathname).toBe("/purchase-orders/17");
  await expect(inspector(page)).not.toContainText("999,999.99");
  await inspector(page).getByRole("link", { name: "Receipt TEST-RECEIPT-32", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Receipt TEST-RECEIPT-32", exact: true })).toBeFocused();
  await expect(inspector(page)).toContainText("PO #99");
  await inspector(page).getByRole("link", { name: "Previous record", exact: true }).click();
  await expect(title).toBeVisible();
  await inspector(page).getByRole("link", { name: "Invoice TEST-INV-71", exact: true }).click();
  const invoiceTitle = inspector(page).getByRole("heading", { name: "Invoice TEST-INV-71", exact: true });
  await expect(invoiceTitle).toBeFocused();
  await expect(inspector(page)).toContainText("Allocated to this PO");
  await expect(inspector(page)).toContainText("75.00");
  await expect(inspector(page)).toContainText("200.00");
  const selectedUrl = page.url();
  await page.goBack();
  await expect(title).toBeVisible();
  await page.goForward();
  await expect(invoiceTitle).toBeVisible();
  await page.reload();
  await expect(invoiceTitle).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("invoice-inspector.png"), fullPage: true });
  await inspector(page).getByRole("link", { name: "Open full record", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Invoice #TEST-INV-71", exact: true })).toBeVisible();
  const expandedUrl = page.url();
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await expect(invoiceTitle).toBeVisible();
  await inspector(page).getByRole("link", { name: "Previous record", exact: true }).click();
  await expect(title).toBeVisible();
  await inspector(page).getByRole("link", { name: "Close inspector", exact: true }).click();
  await expect(overviewLink(page, "shipment:42")).toBeFocused();
  await expect(inspector(page).getByRole("heading", { name: "Inspect a connected record" })).toBeVisible();
  const copied = await context.newPage();
  const copiedFailures = await setup(copied);
  await copied.goto(expandedUrl);
  await copied.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await expect(inspector(copied).getByRole("heading", { name: "Invoice TEST-INV-71", exact: true })).toBeVisible();
  expect(new URL(copied.url()).searchParams.get("inspect")).toBe(new URL(selectedUrl).searchParams.get("inspect"));
  expect(failures.concat(copiedFailures)).toEqual([]);
});

test("explicit PO tabs and draft editing remain available", async ({ page }) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByRole("tab", { name: /^Lines/ })).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("purchase-lifecycle-workspace")).toHaveCount(0);
  await page.route("**/api/purchase-orders/17", (route) => route.fulfill({ json: { ...po(17), status: "draft" } }));
  await page.goto("/purchase-orders/17");
  await expect(page).toHaveURL(/\/purchase-orders\/17\/edit/);
  expect(failures).toEqual([]);
});

test("unknown selection and failed workspace reads preserve the purchase and offer recovery", async ({ page }) => {
  const failures = await setup(page);
  let response: "forbidden" | "malformed" | "ok" = "forbidden";
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill(response === "forbidden"
    ? { status: 403, json: { error: "Forbidden" } }
    : { json: response === "malformed" ? { ...workspace(), purchase: { ...workspace().purchase, id: 99 } } : workspace() }));
  await page.goto("/purchase-orders/17?tab=lifecycle&inspect=receipt:999");
  const address = page.url();
  await expect(page.getByRole("alert").filter({ hasText: "do not have access" })).toBeVisible();
  await expect(page).toHaveURL(address);
  response = "malformed";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be verified" })).toBeVisible();
  response = "ok";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Record unavailable in this purchase" })).toBeVisible();
  await expect(page).toHaveURL(address);
  await overviewLink(page, "shipment:42").click();
  await expect(inspector(page).getByRole("heading", { name: "Shipment TEST-SHIP-42", exact: true })).toBeVisible();
  response = "forbidden";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Refresh failed. Showing the previously loaded records" })).toBeVisible();
  await expect(inspector(page).getByRole("heading", { name: "Shipment TEST-SHIP-42", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("inspect")).toBe("shipment:42");
  expect(failures).toEqual([]);
});
