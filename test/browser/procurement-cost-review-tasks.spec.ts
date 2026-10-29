import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { PurchaseLineCostStatus } from "../../shared/procurement/purchase-cost-status";

const initialVersion = "a".repeat(64), previewVersion = "b".repeat(64);
const issues = [{ code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Approved invoices need complete quantity coverage and explicit product/packaging evidence before replacing the quoted inventory costs." }];
function supplier(id = 21, purchaseOrderId = 17): PurchaseLineCostStatus {
  return { purchaseOrderId, purchaseOrderLineId: id, sku: "SAME-PRODUCT",
    reviewFacts: { quantityBasis: "received", expectedPieces: 100, invoicedPieces: 100, creditedPieces: 0, quantityMatches: true, missingAmountLineIds: [72], invoiceAmountCents: 13000, currency: "USD" },
    components: ["product", "packaging"].map(component => ({ component: component as "product" | "packaging", status: "review_required", sourceEvidence: "review_required", sourceCurrent: false, sourceRevisionId: 1, applicationId: 1, issues })),
    invoices: [{ invoiceId: 71, invoiceNumber: "TEST-INVOICE-71", lineId: 72, lineNumber: 1 }], receipts: [{ receiptId: 31, receiptNumber: "TEST-RECEIPT-31", status: "closed" }], lots: [] };
}

async function setup(page: Page, options: { shipment?: boolean; completed?: boolean; cannotApprove?: boolean; noShipment?: boolean } = {}) {
  const failures = await installFixtures(page, options.cannotApprove ? { permissions: ["purchasing:view"] } : undefined);
  const first = supplier(), second = supplier(22, options.shipment ? 99 : 17);
  second.reviewFacts = { ...second.reviewFacts!, quantityMatches: false, invoicedPieces: 50, missingAmountLineIds: [] };
  second.receipts = [{ receiptId: 32, receiptNumber: "TEST-RECEIPT-32", status: "closed" }];
  second.invoices = [{ invoiceId: 74, invoiceNumber: "TEST-INVOICE-74", lineId: 75, lineNumber: 1 }];
  const state = { approvals: [] as Array<{ key: string; body: Record<string, unknown> }>, previews: 0, first, second };
  const complete = () => {
    first.components = first.components.map((component, index) => ({ ...component, status: "applied", sourceEvidence: "confirmed", sourceCurrent: true,
      issues: [], postingReceipt: { applicationId: 501 + index, actorName: "Test purchasing approver", recordedAt: "2026-10-29T12:00:00Z", amountMills: index === 0 ? 1200000 : 100000 } }));
    first.reviewFacts!.missingAmountLineIds = [];
  };
  if (options.completed) { complete(); second.components = structuredClone(first.components); second.reviewFacts = { ...first.reviewFacts! }; }
  const shipmentLines = () => [first, second].map((line, index) => ({ lineId: 11 + index, purchaseOrderLineId: line.purchaseOrderLineId, shipmentId: 42, shipmentNumber: "TEST-SHIP-42", shipmentStatus: "closed", sku: line.sku,
    allocatedCents: index === 0 ? 3000 : 2000, status: "applied", applicationId: 600 + index, recordedAt: "2026-10-29T11:00:00Z", issues: [] }));
  const costs = () => ({ summary: { currency: "USD", shipmentCount: 1, chargeCount: 1, freightCents: 5000, dutyCents: 0, otherCents: 0, totalCents: 5000, poAmountCents: 26000, combinedCostCents: 31000,
    estimatedCents: 0, unallocatedChargeCount: 0, unsupportedCurrencyCount: 0, appliedLines: 2, reviewLines: 0, pendingLines: 0, inventoryCosting: "applied" },
    supplier: { freightCents: 0, dutyCents: 0 }, totals: { freightCents: 5000, dutyCents: 0, combinedCostCents: 31000 }, supplierCosts: { lines: [first, second] }, lines: shipmentLines() });
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: { ...po(17), status: "received", physicalStatus: "received", subtotalCents: 26000, totalCents: 26000 } }));
  await page.route("**/api/purchase-orders/17/shipment-costs", route => {
    const response = costs();
    if (options.noShipment) {
      response.summary = { ...response.summary, shipmentCount: 0, chargeCount: 0, freightCents: 0, totalCents: 0, combinedCostCents: 26000, appliedLines: 0 };
      response.lines = [];
      response.totals = { freightCents: 0, dutyCents: 0, combinedCostCents: 26000 };
    }
    return route.fulfill({ json: response });
  });
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: { id: 42, shipmentNumber: "TEST-SHIP-42", status: "closed", mode: "sea_fcl", allocationMethodDefault: "by_line_count", statusHistory: [],
    lines: [first, second].map((line, index) => ({ id: 11 + index, purchaseOrderId: line.purchaseOrderId, purchaseOrderLineId: line.purchaseOrderLineId, sku: line.sku, productName: "Synthetic product", qtyShipped: 100, cartonCount: 2 })),
    costs: [{ id: 31, costType: "freight", actualCents: 5000, estimatedCents: 5000, allocationMethod: "by_line_count", currency: "USD", costStatus: "finalized" }],
  } }));
  await page.route("**/api/inbound-shipments/42/cost-review", route => route.fulfill({ json: { shipmentId: 42, supplierCosts: { lines: [first, second] },
    lines: shipmentLines().map((line, index) => ({ lineId: line.lineId, purchaseOrderId: index === 0 ? 17 : second.purchaseOrderId, purchaseOrderLineId: line.purchaseOrderLineId, allocatedCents: line.allocatedCents, currency: "USD", sku: line.sku,
      sourceIssue: null, application: { id: line.applicationId, recordedAt: line.recordedAt, status: "applied", lotsUpdated: 1, cogsRowsUpdated: 0, issues: [] } })) } }));
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: { id: 71, invoiceNumber: "TEST-INVOICE-71", currency: "USD", status: "approved", lines: [
    { id: 72, lineNumber: 1, sku: "SAME-PRODUCT", lineTotalCents: 13000, costReviewVersion: initialVersion, costComponentEvidence: null },
  ] } }));
  await page.route("**/api/vendor-invoice-lines/72/cost-components/preview", async route => {
    state.previews++;
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { preview: { lineId: 72, previewVersion, lineTotalCents: 13000, before: null,
      after: { contractVersion: 1, source: "operator_review", ...body, expectedVersion: undefined, reason: undefined },
      impact: { lots: [{ lotId: 901, lotNumber: "TEST-LOT-901", onHandUnits: 2, unitCostMills: { before: 550000, after: 650000 } }], orderCosts: [], historicalCosts: [] } },
      application: null } });
  });
  await page.route("**/api/vendor-invoice-lines/72/cost-components", async route => {
    const body = route.request().postDataJSON(); state.approvals.push({ key: route.request().headers()["idempotency-key"], body });
    expect(body.previewVersion).toBe(previewVersion);
    complete();
    await route.fulfill({ json: { id: 72, costReviewVersion: "c".repeat(64), costComponentEvidence: { contractVersion: 1, source: "operator_review", packagingTreatment: body.packagingTreatment, productMills: body.productMills, packagingMills: body.packagingMills, adjustmentMills: body.adjustmentMills },
      application: { costSources: [], lotsUpdated: 1, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, costApplications: [] } } });
  });
  await page.goto(options.shipment ? "/shipments/42?tab=allocation&purchase=purchase%3A17%3Alines" : "/purchase-orders/17?tab=lines&costReview=1&poLine=21");
  return { failures, state };
}

test("shows the actual supplier task once per product and separates a quantity difference", async ({ page }, info) => {
  const { failures } = await setup(page);
  const first = page.getByTestId("cost-review-purchase:21"), second = page.getByTestId("cost-review-purchase:22");
  await expect(first.getByRole("heading", { name: "Confirm the supplier amounts", exact: true })).toHaveCount(1);
  await expect(second).toContainText("Invoice: 50 pieces. Received: 100 pieces.");
  await expect(first.getByText("Invoice quantity differs", { exact: true })).toHaveCount(0);
  await expect(page.getByText("inventory cost exception awaiting review", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("region", { name: "Cost review", exact: true }).screenshot({ path: info.outputPath("cost-tasks.png") });
  expect(failures).toEqual([]);
});

test("reviews real before/after values and applies once without leaving the PO line", async ({ page }, info) => {
  const { state, failures } = await setup(page);
  const originalUrl = page.url();
  await page.getByTestId("cost-review-purchase:21").getByRole("button", { name: "Confirm invoice", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Is packaging included in the product price?", { exact: true }).click();
  await page.getByRole("option", { name: "No, packaging is charged separately", exact: true }).click();
  await dialog.getByLabel(/^Product total/).fill("120"); await dialog.getByLabel(/^Packaging total/).fill("10");
  await dialog.getByLabel(/^Other adjustments/).fill("0"); await dialog.getByLabel("Notes / supplier invoice reference").fill("Supplier's final document confirmed");
  await dialog.getByRole("button", { name: "Review cost changes", exact: true }).click();
  const changes = dialog.getByRole("region", { name: "Supplier cost changes" });
  await expect(changes).toContainText("TEST-LOT-901"); await expect(changes).toContainText("55.0000 USD"); await expect(changes).toContainText("65.0000 USD");
  await expect(changes).toContainText("Stock quantities do not change");
  expect(state.approvals).toHaveLength(0); expect(state.previews).toBe(1);
  await page.screenshot({ path: info.outputPath("supplier-cost-changes.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Approve and apply costs", exact: true }).click();
  await expect(dialog).toContainText("Supplier amounts saved");
  await expect(dialog.getByRole("button", { name: "Approve and apply costs", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.getByTestId("cost-task-supplier:21:amounts:72")).toHaveCount(0);
  await expect(page.getByTestId("completed-costs")).toBeVisible();
  await page.getByTestId("completed-costs").getByText(/^Completed/).click();
  await expect(page.getByTestId("completed-costs")).toContainText("Test purchasing approver");
  expect(page.url()).toBe(originalUrl); expect(state.approvals).toHaveLength(1); expect(state.approvals[0].key).toBeTruthy();
  await page.reload(); await expect(page.getByTestId("cost-task-supplier:21:amounts:72")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("keeps identical SKUs from different POs separate on a shared shipment", async ({ page }) => {
  const { failures } = await setup(page, { shipment: true });
  await expect(page.getByTestId("cost-review-purchase:21")).toContainText("PO #17");
  await expect(page.getByTestId("cost-review-purchase:22")).toContainText("PO #99");
  await expect(page.getByTestId("cost-review-purchase:21").getByRole("button", { name: "Confirm invoice", exact: true })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("purchase")).toBe("purchase:17:lines");
  expect(failures).toEqual([]);
});

test("completed costs show saved details without another approval action", async ({ page }) => {
  const { failures } = await setup(page, { completed: true });
  await expect(page.getByTestId("completed-costs")).toBeVisible();
  await expect(page.getByTestId("cost-task-supplier:21:amounts:72")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and apply costs", exact: true })).toHaveCount(0);
  await page.getByTestId("completed-costs").getByText(/^Completed/).click();
  await expect(page.getByTestId("completed-costs")).toContainText("Test purchasing approver");
  expect(failures).toEqual([]);
});

test("supplier tasks remain accessible when the PO has no linked shipment", async ({ page }) => {
  const { failures } = await setup(page, { noShipment: true });
  await expect(page.getByRole("heading", { name: "Purchase costs", exact: true })).toBeVisible();
  await expect(page.getByTestId("cost-review-purchase:21")).toContainText("Confirm the supplier amounts");
  await expect(page.getByTestId("cost-review-purchase:22")).toContainText("Invoice quantity differs");
  expect(failures).toEqual([]);
});

test("viewers can read the task but cannot approve supplier costs", async ({ page }) => {
  const { state, failures } = await setup(page, { cannotApprove: true });
  await page.getByTestId("cost-review-purchase:21").getByRole("button", { name: "Confirm invoice", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Purchasing approval permission is required");
  await expect(dialog.getByRole("button", { name: "Review cost changes", exact: true })).toHaveCount(0);
  expect(state.previews).toBe(0); expect(state.approvals).toHaveLength(0); expect(failures).toEqual([]);
});
