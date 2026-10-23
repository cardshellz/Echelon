import { expect, test, type Page } from "@playwright/test";
import { relationshipFixture } from "../fixtures/document-relationships";
import { shipmentListItem } from "../fixtures/shipment-work-list";
import { installFixtures, po, receipt } from "./procurement-fixtures";

async function setup(page: Page) {
  const failures = await installFixtures(page);
  const sample = relationshipFixture({ kind: "purchase", id: 17 });
  for (const shipment of sample.shipments) {
    const lines = sample.shipmentLines.filter(line => line.shipmentId === shipment.id);
    const total = sample.charges.find(charge => charge.shipmentId === shipment.id)!.cents;
    await page.route(`**/api/inbound-shipments/${shipment.id}`, route => route.fulfill({ json: {
      id: shipment.id, shipmentNumber: shipment.number, status: shipment.status, mode: "air", createdAt: "2026-10-01T12:00:00Z",
      estimatedTotalCostCents: total, actualTotalCostCents: total, totalCartons: shipment.id === 42 ? 150 : 100, totalWeightKg: "120", totalVolumeCbm: "1.5",
      purchaseOrders: sample.purchases.filter(po => lines.some(line => line.purchaseId === po.id)).map(po => ({ id: po.id, poNumber: po.number })),
      lines: lines.map(line => ({ id: line.id, purchaseOrderId: line.purchaseId,
        purchaseOrderLineId: line.purchaseLineId, sku: line.sku, productName: line.product, qtyShipped: line.shippedPieces,
        cartonCount: line.id === 202 ? 50 : 100, allocatedCostCents: sample.allocations.find(row => row.shipmentLineId === line.id)!.cents })),
      costs: [], statusHistory: [],
    } }));
    await page.route(`**/api/inbound-shipments/${shipment.id}/allocation-status`, route => route.fulfill({ json: {
      status: "allocated", lineCount: lines.length, costCount: 1, allocatableCostCount: 1,
      effectiveCostCents: total, allocatedCostCents: total, unallocatedCents: 0, blockerCount: 0, warningCount: 0,
      issues: [], costs: [{ costId: shipment.id === 42 ? 401 : 402, costType: "freight", effectiveCents: total,
        allocatedCents: total, allocationCount: lines.length, method: "by_volume", methodSource: "shipment_default",
        rawBasisTotal: 1.5, basisTotal: 1.5, usedFallback: false, status: "allocated" }],
    } }));
    await page.route(`**/api/inbound-shipments/${shipment.id}/invoices`, route => route.fulfill({ json: {
      invoices: [], summary: { invoiceCount: 0, activeInvoiceCount: 0, totalInvoicedCents: 0, totalPaidCents: 0, outstandingCents: 0 },
    } }));
  }
  for (const row of sample.receipts) {
    await page.route(`**/api/receiving/${row.id}`, route => route.fulfill({ json: {
      ...receipt(row.id), purchaseOrderId: row.purchaseId, inboundShipmentId: row.shipmentId,
    } }));
  }
  await page.route("**/api/purchase-orders/17/workspace", route => route.fulfill({ json: {
    purchase: { id: 17, poNumber: "TEST-PO-17", status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "unpaid", currency: "USD", vendorName: "Test supplier", totalCents: 10000,
      invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null,
      lines: [{ id: 101, sku: "SAME-SKU", productName: "Sleeves", lineType: "product", orderedQty: 200000, receivedQty: 100000, cancelledQty: 0, quantityBasis: "pieces" }] },
    shipments: sample.shipments.map(row => ({ id: row.id, shipmentNumber: row.number, status: row.status, mode: "air", containerNumber: null, eta: null, deliveredDate: null,
      estimatedTotalCostCents: row.id === 42 ? 10001 : 500, actualTotalCostCents: row.id === 42 ? 10001 : 500, amountScope: "whole_shipment", purchaseOrderIds: row.id === 42 ? [17, 99] : [17], unlinkedLineCount: 0,
      lines: sample.shipmentLines.filter(line => line.shipmentId === row.id).map(line => ({ id: line.id, sku: line.sku, qtyShipped: line.shippedPieces, allocatedCostCents: null,
        purchaseOrderId: line.purchaseId, purchaseOrderLineId: line.purchaseLineId, purchaseOrderLinePurchaseOrderId: line.purchaseId })) })),
    receipts: [], invoices: [], edges: sample.shipments.map(row => ({ from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: row.id }, relationship: "purchase_shipment" })), limitations: [],
  } }));
  return failures;
}
const connections = (page: Page) => page.getByRole("region", { name: "PO, shipment and receipt connections" });

const filteredShipmentList = "/shipments?status=closed&costFilter=all&offset=50&mode=air&search=SAME-SKU";
async function installFilteredShipmentList(page: Page) {
  await page.route(/\/api\/inbound-shipments\?/, route => route.fulfill({ json: {
    shipments: [shipmentListItem({ id: 42, shipmentNumber: "TEST-SHIP-42", status: "closed", mode: "air",
      purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }] })],
    total: 51, offset: 50, limit: 50, hasMore: false, costHealthItems: [],
  } }));
  await page.route(/\/api\/procurement\/landed-cost-health\?/, route => route.fulfill({ json: {
    status: "healthy", scannedShipments: 51, critical: 0, warning: 0,
    counts: { allocationBlockers: 0, allocationWarnings: 0, pendingFinalization: 0, finalizedNotPushed: 0, staleProvisionalLots: 0 },
    items: [],
  } }));
}

test("a multi-PO receipt round trip restores the selected line and the original filtered shipment page, including copied links", async ({ page, context }) => {
  const failures = await setup(page);
  await installFilteredShipmentList(page);
  await page.goto(filteredShipmentList);
  await expect(page.getByRole("navigation", { name: "Shipment pages" })).toContainText("Showing 51–51 of 51 matching shipments");
  await page.getByRole("region", { name: "Shipment results" }).getByRole("link", { name: "TEST-SHIP-42", exact: true }).filter({ visible: true }).click();
  await connections(page).getByLabel("Show purchase order").selectOption("99");
  const selectedLine = connections(page).getByTestId("relationship-line-202");
  await expect(selectedLine.locator("td").nth(1)).toContainText("50,000");
  await expect(selectedLine.locator("td").nth(2)).toContainText("50,000");
  await expect(selectedLine.locator("td").nth(4)).toHaveText("Allocated chargesUSD 40.00");
  await selectedLine.getByRole("button", { name: "Line details" }).click();
  await connections(page).getByRole("link", { name: "TEST-PO-99", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
  await expect(connections(page).getByRole("article")).toHaveCount(1);
  await expect(connections(page).getByText("USD 100.01", { exact: true })).toBeVisible();
  await expect(connections(page).getByRole("region", { name: "TEST-PO-99", exact: true })).toContainText("USD 40.00");
  await connections(page).getByRole("link", { name: "TEST-RECEIPT-33", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(connections(page)).toContainText("This receipt · 50,000 pieces received");
  await expect(connections(page).getByTestId("relationship-line-201")).toHaveCount(0);
  const receiptUrl = page.url();
  await page.reload();

  const copied = await context.newPage();
  const copiedFailures = await setup(copied);
  await installFilteredShipmentList(copied);
  await copied.goto(receiptUrl);
  // Both reload and a fresh tab must restore the actual trail, not only the PO shortcut.
  for (const current of [page, copied]) {
    await expect(current.getByRole("dialog")).toBeVisible();
    await current.getByRole("link", { name: "Back to TEST-PO-99", exact: true }).click();
    await expect(current.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
    await expect(connections(current).getByTestId("relationship-line-202").getByRole("button", { name: "Hide details" })).toBeVisible();
    await current.getByRole("link", { name: "Back to TEST-SHIP-42", exact: true }).click();
    await expect(connections(current).getByLabel("Show purchase order")).toHaveValue("99");
    await expect(connections(current).getByTestId("relationship-line-202").getByRole("button", { name: "Hide details" })).toBeVisible();
    await current.getByRole("link", { name: "Back to shipments", exact: true }).click();
    await expect(current).toHaveURL(filteredShipmentList);
    await expect(current.getByPlaceholder("Search shipment, PO, SKU, carrier or container...")).toHaveValue("SAME-SKU");
    await expect(current.getByRole("navigation", { name: "Shipment pages" })).toContainText("Showing 51–51 of 51 matching shipments");
    await expect(current.getByRole("combobox")).toContainText("Air");
  }
  expect(failures.concat(copiedFailures)).toEqual([]);
});

test("a PO split across shipments retains each shipment's quantity, cost share and receipt on a complete return journey", async ({ page }) => {
  const failures = await setup(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  const first = connections(page).getByRole("article", { name: "Shipment TEST-SHIP-42", exact: true });
  const second = connections(page).getByRole("article", { name: "Shipment TEST-SHIP-43", exact: true });
  await expect(first.getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 60.01");
  await expect(first.getByText("USD 100.01", { exact: true })).toBeVisible();
  await expect(second.getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 5.00");
  const secondLine = second.getByTestId("relationship-line-203");
  await expect(secondLine.locator("td").nth(1)).toContainText("200,000");
  await expect(secondLine.locator("td").nth(2)).toContainText("100,000");
  await secondLine.getByRole("button", { name: "Line details" }).click();
  await second.getByRole("link", { name: "Shipment TEST-SHIP-43", exact: true }).click();
  await expect(connections(page).getByRole("article")).toHaveCount(1);
  await expect(connections(page).getByTestId("relationship-line-201")).toHaveCount(0);
  await expect(connections(page).getByText("USD 100.01", { exact: true })).toHaveCount(0);
  await connections(page).getByRole("link", { name: "TEST-RECEIPT-34", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(connections(page)).toContainText("This receipt · 100,000 pieces received");
  await expect(connections(page).getByRole("article")).toHaveAttribute("aria-label", "Shipment TEST-SHIP-43");
  await page.reload();
  await page.getByRole("link", { name: "Back to TEST-SHIP-43", exact: true }).click();
  await expect(connections(page).getByLabel("Show purchase order")).toHaveValue("17");
  await expect(connections(page).getByTestId("relationship-line-203").getByRole("button", { name: "Hide details" })).toBeVisible();
  await page.getByRole("link", { name: "Back to TEST-PO-17", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
  await expect(connections(page).getByRole("article")).toHaveCount(2);
  await expect(secondLine.getByRole("button", { name: "Hide details" })).toBeVisible();
  await expect(first.getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 60.01");
  await expect(second.getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 5.00");
  expect(failures).toEqual([]);
});

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

async function installPoLineProgress(page: Page, initialStatus = "booked") {
  let status = initialStatus;
  let unavailable = false;
  await page.route("**/api/procurement/relationships/**", route => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const parts = new URL(route.request().url()).pathname.split("/");
    const data = relationshipFixture({ kind: parts[4] as "purchase" | "shipment" | "receipt", id: Number(parts[5]) });
    data.purchaseLines[0].receivedPieces = 100000;
    const second = data.shipments.find(shipment => shipment.id === 43);
    if (second) second.status = status;
    data.receipts = data.receipts.filter(receipt => receipt.id !== 34);
    data.receiptLines = data.receiptLines.filter(line => line.receiptId !== 34);
    return route.fulfill({ json: data });
  });
  for (const id of [17, 99]) await page.route(`**/api/purchase-orders/${id}`, route => route.fulfill({ json: {
    ...po(id), currency: "USD", lines: relationshipFixture().purchaseLines.filter(line => line.purchaseId === id).map(line => ({
      id: line.id, lineNumber: line.lineNumber, sku: line.sku, productName: line.product, lineType: "product", status: "open",
      orderQty: line.orderedPieces, receivedQty: line.id === 101 ? 100000 : line.receivedPieces, cancelledQty: 0,
      unitCostMills: 100, lineTotalCents: 5000, vendorSku: "SUPPLIER-SKU",
    })),
  } }));
  return { setStatus: (next: string) => { status = next; }, setUnavailable: (next: boolean) => { unavailable = next; } };
}
const poLine = (page: Page, id: number) => page.getByTestId(`po-line-${id}`).filter({ visible: true });

test("PO Lines shows split shipment progress and returns to the same line after shipment and receiving, including copied links", async ({ page, context }, info) => {
  const failures = await setup(page);
  await installPoLineProgress(page);
  await page.goto("/purchase-orders/17?tab=lines");
  const line = poLine(page, 101);
  await expect(line.getByTestId("shipped-pieces")).toHaveText("100,000");
  await expect(line.getByTestId("remaining-pieces")).toHaveText("100,000100,000 planned");
  await expect(line.getByTestId("received-pieces")).toHaveText("100,000");
  await expect(line.getByRole("link", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  await expect(line).toContainText("100,000 pcs · Planned · Booked");
  await expect(poLine(page, 103).getByTestId("remaining-pieces")).toHaveText("100");
  await expect(poLine(page, 103)).toContainText("No linked shipments");
  await page.getByRole("tabpanel", { name: "Lines (2)" }).screenshot({ path: info.outputPath("po-lines-shipment-progress.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await line.getByRole("link", { name: "TEST-SHIP-42", exact: true }).click();
  await expect(connections(page).getByLabel("Show purchase order")).toHaveValue("17");
  await expect(connections(page).getByTestId("relationship-line-201").getByRole("button", { name: "Hide details" })).toBeVisible();
  await expect(connections(page).getByRole("region", { name: "TEST-PO-17", exact: true })).toContainText("USD 60.01");
  await connections(page).getByRole("link", { name: "TEST-RECEIPT-31", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const url = page.url();
  const copied = await context.newPage();
  const copiedFailures = await setup(copied); await installPoLineProgress(copied); await copied.goto(url);
  for (const current of [page, copied]) {
    await current.reload();
    await current.getByRole("link", { name: "Back to TEST-SHIP-42", exact: true }).click();
    await current.getByRole("link", { name: "Back to TEST-PO-17", exact: true }).click();
    await expect(current.getByRole("tab", { name: "Lines (2)", exact: true })).toHaveAttribute("data-state", "active");
    await expect(current).toHaveURL(/shipmentLine=201/);
    await expect(poLine(current, 101).getByRole("group", { name: "Shipments for PO line 1", exact: true })).toBeFocused();
    await expect(poLine(current, 101).getByTestId("shipped-pieces")).toHaveText("100,000");
  }
  expect(failures.concat(copiedFailures)).toEqual([]);
});

test("PO Lines refreshes departure/cancellation and fails visibly with retry instead of zeroing shipped counts", async ({ page }) => {
  const failures = await setup(page); const controls = await installPoLineProgress(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("100,000");
  controls.setStatus("in_transit"); await page.reload();
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("200,000");
  await expect(poLine(page, 101).getByTestId("remaining-pieces")).toHaveText("0");
  await expect(poLine(page, 101).getByTestId("received-pieces")).toHaveText("100,000");
  controls.setStatus("cancelled"); await page.reload();
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("100,000");
  await expect(poLine(page, 101).getByTestId("remaining-pieces")).toHaveText("100,000");
  await expect(poLine(page, 101)).toContainText("Cancelled · Not counted");
  controls.setUnavailable(true); await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Shipment progress could not be loaded" })).toBeVisible();
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("Unavailable");
  await expect(poLine(page, 101).getByTestId("received-pieces")).toHaveText("100,000");
  controls.setUnavailable(false); await page.getByRole("button", { name: "Retry shipment progress" }).click();
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("100,000");
  expect(failures).toEqual([]);
});

test("unknown shipment status keeps known counts visible with a direct review path", async ({ page }) => {
  const failures = await setup(page); await installPoLineProgress(page, "historical_import");
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toContainText("100,000");
  await expect(poLine(page, 101).getByTestId("remaining-pieces")).toHaveText("Unverified");
  await expect(poLine(page, 101)).toContainText("TEST-SHIP-43 has an unrecognized shipment status");
  await poLine(page, 101).getByRole("link", { name: "Review shipment links", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
  await expect(connections(page).getByRole("article", { name: "Shipment TEST-SHIP-43", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("departing a planned shipment refreshes PO line progress on return without a page reload", async ({ page }) => {
  const failures = await setup(page); const controls = await installPoLineProgress(page);
  let status = "booked"; let departures = 0;
  await page.route("**/api/inbound-shipments/43", route => route.fulfill({ json: {
    id: 43, shipmentNumber: "TEST-SHIP-43", status, mode: "air", createdAt: "2026-10-01T12:00:00Z",
    estimatedTotalCostCents: 500, actualTotalCostCents: 500, totalCartons: 100, totalWeightKg: "120", totalVolumeCbm: "1.5",
    purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }],
    lines: [{ id: 203, purchaseOrderId: 17, purchaseOrderLineId: 101, sku: "SAME-SKU", productName: "Sleeves", qtyShipped: 100000, cartonCount: 100, allocatedCostCents: 500 }],
    costs: [], statusHistory: [],
  } }));
  await page.route("**/api/inbound-shipments/43/in-transit", route => {
    expect(route.request().method()).toBe("POST");
    departures += 1; status = "in_transit"; controls.setStatus(status);
    return route.fulfill({ json: { id: 43, status } });
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("100,000");
  await poLine(page, 101).getByRole("link", { name: "TEST-SHIP-43", exact: true }).click();
  await page.getByRole("button", { name: "Mark In Transit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark In Transit", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to TEST-PO-17", exact: true }).click();
  await expect(poLine(page, 101).getByTestId("shipped-pieces")).toHaveText("200,000");
  await expect(poLine(page, 101).getByTestId("remaining-pieces")).toHaveText("0");
  await expect(poLine(page, 101).getByTestId("received-pieces")).toHaveText("100,000");
  await expect(poLine(page, 101)).toContainText("100,000 pcs · Shipped · In transit");
  expect(departures).toBe(1); expect(failures).toEqual([]);
});
