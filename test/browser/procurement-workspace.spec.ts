import { purchaseCostApplicationsFixture } from "../fixtures/purchase-cost-applications";
import { purchaseCostTraceFixture } from "../fixtures/purchase-cost-trace";
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

test("cost source detail preserves purchase context and exact amount evidence", async ({ page }, testInfo) => {
  const failures = await setup(page);
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: { ...workspace(), costTrace: purchaseCostTraceFixture() } }));
  await page.goto("/purchase-orders/17?tab=lifecycle");
  const trace = page.getByTestId("purchase-cost-trace");
  await expect(trace.getByRole("heading", { name: "Cost trace", exact: true })).toBeVisible();
  const quote = trace.getByTestId("cost-quote-171");
  await quote.locator("summary").click();
  await expect(quote).toContainText("$100.00");
  await expect(quote).toContainText("$18.00");
  await expect(quote).toContainText("$0.6667");
  await expect(quote).toContainText("approximately $78.67");
  await expect(quote).toContainText("100 pieces still expected");
  const charge = trace.getByTestId("cost-charge-501");
  await charge.locator("summary").click();
  await expect(charge).toContainText("0.00 EUR");
  await expect(charge).toContainText("0.00 (currency not recorded)");
  await expect(charge).not.toContainText("Applied");
  await charge.getByRole("link", { name: "Shipment charge #501", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Shipment TEST-SHIP-42", exact: true })).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/purchase-orders/17");
  await expect(charge).toHaveAttribute("open", "");
  const receiptCost = trace.getByTestId("cost-receipt-311");
  await receiptCost.locator("summary").click();
  await expect(receiptCost).toContainText("TEST-LOT-901");
  await expect(receiptCost).toContainText("41.8350 (currency not recorded)");
  await receiptCost.getByRole("link", { name: "Receipt line #311", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Receipt TEST-RECEIPT-31", exact: true })).toBeFocused();
  await inspector(page).getByTestId("cost-receipt-311").locator("summary").click();
  await expect(inspector(page)).toContainText("Receipt transaction #3001");
  await expect(inspector(page)).toContainText("Application snapshots and sold-cost outcomes are shown separately");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("purchase-cost-trace.png"), fullPage: true });
  expect(failures).toEqual([]);
});
test("recorded cost history shows exact lot lineage and COGS with a separate receipt retry", async ({ page }, testInfo) => {
  const failures = await setup(page);
  const traceData = purchaseCostApplicationsFixture();
  const data = { ...workspace(), costTrace: traceData };
  data.receipts[0] = { ...data.receipts[0], status: "closed", closedDate: "2026-09-07T12:00:00Z" };
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: {
    user: { id: "test-user", username: "test", role: "admin" }, permissions: ["purchasing:approve"], roles: ["admin"],
  } }));
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: data }));
  const keys: string[] = [];
  await page.route("**/api/receiving/31/retry-costs", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData()).toBe("{}");
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) return route.fulfill({ status: 500, json: { error: "Synthetic uncertain response" } });
    const request = traceData.receiptCostRequests![0];
    request.state = "applied";
    request.attempts[0].latestRecordedAttempt = false;
    request.attempts.unshift({ id: 72, state: "applied", latestRecordedAttempt: true, recordedBy: "test-reviewer",
      recordedAt: "2026-09-07T13:00:00.000Z", evidenceState: "verified_record", issues: [], applicationIds: [21] });
    return route.fulfill({ json: { state: "applied", requests: [{ requestId: 61, purchaseOrderLineId: 171, state: "applied", issues: [], attemptRecorded: true }] } });
  });
  await page.goto("/purchase-orders/17?tab=lifecycle");
  const trace = page.getByTestId("purchase-cost-trace");
  const revision = trace.getByTestId("cost-revision-11");
  await expect(revision).toContainText("$99.0000 across 150 base pieces");
  await expect(revision).toContainText("Latest recorded source");
  const application = revision.getByTestId("cost-application-21");
  await application.locator(":scope > summary").click();
  await expect(application).toContainText("-$0.34");
  await expect(application).toContainText("Internal reporting event #41");
  await expect(application).toContainText("Delivery to Archon or another external system is not verified");
  await application.locator("summary").filter({ hasText: "TEST-TRANSFER-902" }).click();
  await expect(application).toContainText("$33.3350 → $33.0000");
  await expect(application).toContainText("Contribution #31: source lot #901");
  await expect(application).toContainText("Current on-hand: 0 variant units");
  await application.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("cost-application-visible.png") });
  await revision.getByRole("link", { name: "Vendor invoice line #711", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Invoice TEST-INV-71", exact: true })).toBeFocused();
  expect(new URL(page.url()).searchParams.get("inspect")).toBe("invoice:71");
  const request = trace.getByTestId("receipt-cost-request-61");
  await expect(request).toContainText("Physical receipt: Closed");
  await expect(request).toContainText("The stock receipt remains recorded");
  await request.getByRole("button", { name: "Retry receipt costs", exact: true }).click();
  await expect(trace.getByRole("alert")).toContainText("physical receipt is separate");
  await expect(request.getByRole("button", { name: "Retry receipt costs", exact: true })).toBeEnabled();
  await request.getByRole("button", { name: "Retry receipt costs", exact: true }).click();
  await expect(request).toContainText("Receipt cost attempt completed");
  await expect(request.getByRole("button")).toHaveCount(0);
  await request.locator("summary").click();
  await expect(request).toContainText("Attempt #71");
  await expect(request).toContainText("Attempt #72");
  await expect(request).toContainText("Applications: #21");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(new URL(page.url()).searchParams.get("inspect")).toBe("invoice:71");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await request.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("receipt-cost-queue-visible.png") });
  expect(failures).toEqual([]);
});

test("cost history stays inspectable without exposing a retry to users without approval capability", async ({ page }) => {
  const failures = await setup(page);
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: { ...workspace(), costTrace: purchaseCostApplicationsFixture() } }));
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await expect(page.getByTestId("receipt-cost-request-61")).toContainText("Retry required");
  await expect(page.getByRole("button", { name: "Retry receipt costs", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("cost-revision-11")).toBeVisible();
  expect(failures).toEqual([]);
});

test("purchase source RFQ opens inline without losing shipment context", async ({ page }) => {
  const failures = await setup(page);
  const data = workspace();
  data.rfqOrigins = [{ id: 1, rfqId: 10, rfqNumber: "TEST-RFQ-10", rfqLineId: 20,
    purchaseOrderLineId: 171, quoteRevisionId: 7, quoteReference: "VENDOR-QUOTE-7", quotedPieces: 100,
    currency: "USD", linkedAt: "2026-09-07T12:00:00.000Z" }];
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: data }));
  await page.route("**/api/purchasing/rfqs/10", (route) => route.fulfill({ json: {
    id: 10, rfqNumber: "TEST-RFQ-10", vendorId: 5, currency: "USD", status: "quoted", version: "a".repeat(64),
    lines: [{ id: 20, status: "ordered", productId: 100, productVariantId: 200, warehouseId: 1,
      vendorProductId: 300, sku: "TEST-SKU", productName: "Test product", requestedPieces: 100, latestQuote: null,
      quantityReview: { recommendationRules: { vendorProductId: 300, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1, orderMultiplePieces: 1, orderMultipleSource: "base_piece" }, currentRules: { vendorProductId: 300, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1, orderMultiplePieces: 1, orderMultipleSource: "base_piece" }, evaluatedPieces: 100, issues: [], requiresReason: false, canConvert: true },
      purchaseOrder: { purchaseOrderId: 17, purchaseOrderLineId: 171, quoteRevisionId: 7, poNumber: "TEST-PO-17", status: "acknowledged" } }],
  } }));
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "TEST-RFQ-10 · 1 purchase line" }).click();
  await expect(page.getByRole("heading", { name: /TEST-RFQ-10/ })).toBeVisible();
  await expect(page.getByText(/Quote VENDOR-QUOTE-7/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open full RFQ" })).toHaveAttribute("href", "/procurement/rfqs?rfqId=10");
  expect(new URL(page.url()).pathname).toBe("/purchase-orders/17");
  await page.getByRole("button", { name: "Close RFQ details" }).click();
  await overviewLink(page, "shipment:42").click();
  await expect(inspector(page)).toContainText("TEST-SHIP-42");
  expect(new URL(page.url()).pathname).toBe("/purchase-orders/17");
  expect(failures).toEqual([]);
});
