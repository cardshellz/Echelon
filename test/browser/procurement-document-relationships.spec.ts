import { expect, test, type Page } from "@playwright/test";
import { relationshipFixture } from "../fixtures/document-relationships";
import { installFixtures, receipt } from "./procurement-fixtures";

async function setup(page: Page) {
  const failures = await installFixtures(page);
  const sample = relationshipFixture({ kind: "purchase", id: 17 });
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "closed", mode: "air", createdAt: "2026-10-01T12:00:00Z",
    estimatedTotalCostCents: 10001, actualTotalCostCents: 10001, totalCartons: 150, totalWeightKg: "120", totalVolumeCbm: "1.5",
    purchaseOrders: sample.purchases.map(po => ({ id: po.id, poNumber: po.number })),
    lines: sample.shipmentLines.filter(line => line.shipmentId === 42).map(line => ({ id: line.id, purchaseOrderId: line.purchaseId,
      purchaseOrderLineId: line.purchaseLineId, sku: line.sku, productName: line.product, qtyShipped: line.shippedPieces,
      cartonCount: line.id === 201 ? 100 : 50, allocatedCostCents: line.id === 201 ? 6001 : 4000 })),
    costs: [], statusHistory: [],
  } }));
  await page.route("**/api/receiving/31", route => route.fulfill({ json: { ...receipt(31), purchaseOrderId: 17 } }));
  await page.route("**/api/purchase-orders/17/workspace", route => route.fulfill({ json: {
    purchase: { id: 17, poNumber: "TEST-PO-17", status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "unpaid", currency: "USD", vendorName: "Test supplier", totalCents: 10000,
      invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null,
      lines: [{ id: 101, sku: "SAME-SKU", productName: "Sleeves", lineType: "product", orderedQty: 200000, receivedQty: 100000, cancelledQty: 0, quantityBasis: "pieces" }] },
    shipments: sample.shipments.map(row => ({ id: row.id, shipmentNumber: row.number, status: row.status, mode: "air", containerNumber: null, eta: null, deliveredDate: null,
      estimatedTotalCostCents: 10001, actualTotalCostCents: 10001, amountScope: "whole_shipment", purchaseOrderIds: row.id === 42 ? [17, 99] : [17], unlinkedLineCount: 0,
      lines: sample.shipmentLines.filter(line => line.shipmentId === row.id).map(line => ({ id: line.id, sku: line.sku, qtyShipped: line.shippedPieces, allocatedCostCents: null,
        purchaseOrderId: line.purchaseId, purchaseOrderLineId: line.purchaseLineId, purchaseOrderLinePurchaseOrderId: line.purchaseId })) })),
    receipts: [], invoices: [], edges: sample.shipments.map(row => ({ from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: row.id }, relationship: "purchase_shipment" })), limitations: [],
  } }));
  return failures;
}
const connections = (page: Page) => page.getByRole("region", { name: "PO, shipment and receipt connections" });

test("shared PO lines and cost shares remain clear through shipment, receiving, back and copied links", async ({ page, context }, info) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  let view = connections(page);
  await expect(view.getByRole("article")).toHaveCount(2);
  await expect(view.getByText("USD 60.01", { exact: true })).toHaveCount(2); // PO share and its line, not the whole shipment.
  await expect(view.getByText("PO lines without a shipment link")).toBeVisible();
  await view.getByRole("link", { name: "Shipment TEST-SHIP-42", exact: true }).click();
  view = connections(page);
  await expect(view.getByLabel("Show purchase order")).toHaveValue("17");
  await view.getByLabel("Show purchase order").selectOption("all");
  await expect(view.getByRole("region", { name: "TEST-PO-99", exact: true })).toContainText("USD 40.00");
  await expect(view.getByText("USD 100.01", { exact: true })).toBeVisible();
  await view.getByLabel("Show purchase order").selectOption("17");
  await view.getByTestId("relationship-line-201").getByRole("button", { name: "Line details" }).click();
  await view.getByRole("link", { name: "TEST-RECEIPT-31", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(connections(page)).toContainText("60,000 pieces received");
  await page.getByRole("link", { name: "Back to TEST-SHIP-42", exact: true }).click();
  await expect(connections(page).getByLabel("Show purchase order")).toHaveValue("17");
  await expect(connections(page).getByRole("button", { name: "Hide details", exact: true })).toBeVisible();
  const copied = await context.newPage(); await setup(copied); await copied.goto(page.url());
  await expect(connections(copied).getByRole("button", { name: "Hide details", exact: true })).toBeVisible(); await copied.close();
  await page.reload();
  await expect(connections(page).getByRole("button", { name: "Hide details", exact: true })).toBeVisible();
  await connections(page).screenshot({ path: info.outputPath("grouped-shipment.png") });
  expect(await view.getByTestId("relationship-line-201").evaluate(row => row.scrollWidth <= row.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("lifecycle uses the same grouped lines and scoped costs as the full shipment", async ({ page }, info) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17?tab=lifecycle&inspect=shipment:42");
  const view = connections(page);
  await expect(view.getByText("USD 100.01", { exact: true })).toBeVisible();
  await expect(view.getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 60.01");
  await expect(view.getByTestId("relationship-line-201")).toContainText("200,000");
  await view.getByLabel("Show purchase order").selectOption("all");
  await expect(view.getByTestId("relationship-line-202")).toContainText("50,000");
  await view.screenshot({ path: info.outputPath("lifecycle-relationships.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("read failures have an inline retry; missing links never turn into zero costs or guessed receipt quantities", async ({ page }) => {
  const failures = await setup(page); let fail = true;
  await page.route("**/api/procurement/relationships/shipment/42", route => {
    if (fail) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const data = relationshipFixture(); data.shipmentLines[0].purchaseId = null; data.shipmentLines[0].purchaseLineId = null;
    data.receiptLines[0].piecesPerUnit = null; data.allocations[0].cents = null;
    return route.fulfill({ json: data });
  });
  await page.goto("/shipments/42");
  await expect(page.getByRole("alert").filter({ hasText: "Retry document links" })).toContainText("Document links and cost shares could not be loaded");
  fail = false; await page.getByRole("button", { name: "Retry document links" }).click();
  await expect(connections(page)).toContainText("PO not linked");
  await expect(connections(page)).toContainText("piece conversion not saved");
  await expect(connections(page)).toContainText("Allocation is incomplete");
  expect(failures).toEqual([]);
});
