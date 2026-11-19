import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { historyContext, historyInput } from "../fixtures/shipment-history-correction";
import { relationshipFixture } from "../fixtures/document-relationships";
import type { ShipmentHistoryPosting, ShipmentHistoryReview } from "../../shared/procurement/shipment-history-correction";

async function setup(page: Page, options: { admin?: boolean; loseResponse?: boolean } = {}) {
  const failures = await installFixtures(page);
  const context = historyContext(); context.canApprove = options.admin ?? true;
  context.lines.push({ ...context.lines[0], id: 202, sku: "TEST-HOLDERS", pieces: 50000, purchaseOrderId: 99, poNumber: "TEST-PO-99", purchaseOrderLineId: 102,
    orderedPieces: 50000, receivedPieces: 50000, postedReceiptPieces: 50000 });
  context.charges = [{ currency: "USD", cents: 10001 }];
  let posting: ShipmentHistoryPosting | null = null;
  const keys: string[] = [];
  await page.route("**/api/procurement/relationships/**", route => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const data = relationshipFixture({ kind: parts[4] as "purchase" | "shipment" | "receipt", id: Number(parts[5]) });
    for (const shipment of data.shipments) if (shipment.id === 42) shipment.status = posting ? "delivered" : "booked";
    return route.fulfill({ json: data });
  });
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: { ...po(17), physicalStatus: "in_transit",
    lines: [{ id: 101, lineNumber: 1, sku: "TEST-SLEEVES", productName: "Sleeves", orderQty: 200000, receivedQty: 200000,
      lineTotalCents: 10000, unitCostMills: 5, status: "received", lineType: "product" }] } }));
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: { id: 42, shipmentNumber: "TEST-SHIP-42", status: posting ? "delivered" : "booked", mode: "air",
    createdAt: "2026-03-19T12:00:00Z", estimatedTotalCostCents: 10001, actualTotalCostCents: 10001,
    purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }],
    lines: context.lines.map(line => ({ id: line.id, purchaseOrderId: line.purchaseOrderId, purchaseOrderLineId: line.purchaseOrderLineId, sku: line.sku,
      productName: line.sku, qtyShipped: line.pieces, cartonCount: 10, allocatedCostCents: line.id === 201 ? 6001 : 4000 })), costs: [], statusHistory: [],
  } }));
  const root = "**/api/inbound-shipments/42/history-correction";
  const review: ShipmentHistoryReview = { before: context.current, after: { status: "delivered", departedOn: "2026-03-12", deliveredOn: "2026-03-19" },
    lines: context.lines, receipts: context.receipts, charges: context.charges, issues: context.issues,
    plannedPiecesBefore: 150000, shippedPiecesBefore: 0, plannedPiecesAfter: 0, shippedPiecesAfter: 150000, protectedRecordsVersion: "b".repeat(64) };
  await page.route(`${root}/preview`, route => {
    expect(route.request().postDataJSON()).toEqual(historyInput());
    return route.fulfill({ json: { previewVersion: "c".repeat(64), review } });
  });
  await page.route(root, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: posting ? { ...context, current: review.after, blockedReason: "Already delivered.", approvals: [posting] } : context });
    expect(route.request().postDataJSON()).toEqual({ ...historyInput(), previewVersion: "c".repeat(64) });
    keys.push(route.request().headers()["idempotency-key"]);
    posting ??= { id: 1, actorId: "admin", actorName: "Purchasing Administrator", approvedAt: "2026-10-23T12:00:00.000Z", reason: historyInput().reason, review };
    if (options.loseResponse && keys.length === 1) return route.abort();
    return route.fulfill({ json: posting });
  });
  return { failures, keys };
}

async function fillReview(page: Page) {
  await page.getByRole("button", { name: "Review shipment history", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("What do the shipping documents confirm?")).toHaveValue("");
  await dialog.getByLabel("What do the shipping documents confirm?").selectOption("delivered");
  await expect(dialog.getByLabel("Departure date on the document")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Review before and after" })).toBeDisabled();
  await dialog.getByLabel("Departure date on the document").fill("2026-03-12");
  await dialog.getByLabel("Delivery date on the document").fill("2026-03-19");
  await dialog.getByLabel("Document reference and reason").fill(historyInput().reason);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Review before and after" }).click();
  return dialog;
}

test("shared PO status and an admin history correction preserve split-shipment quantities, cost shares and return focus", async ({ page }, info) => {
  const { failures, keys } = await setup(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByTestId("purchase-order-status")).toHaveText("In transit");
  const line = page.getByTestId("po-line-101").filter({ visible: true });
  await expect(line.getByTestId("shipped-pieces")).toHaveText("100,000");
  await expect(line.getByTestId("received-pieces")).toHaveText("200,000");
  await line.getByRole("link", { name: "TEST-SHIP-42", exact: true }).click();
  const dialog = await fillReview(page);
  await expect(dialog).toContainText("TEST-PO-99");
  await expect(dialog.getByRole("row", { name: /Counted as shipped/ })).toContainText("150,000");
  await expect(dialog.getByRole("row", { name: /Shipment charges/ })).toHaveText("Shipment charges (USD)$100.01$100.01");
  await expect(dialog.getByLabel("Unresolved quantity evidence")).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("history-before-after.png") });
  await dialog.getByRole("button", { name: "Approve history correction" }).click();
  await expect(dialog.getByLabel("Approved shipment history correction")).toContainText("Purchasing Administrator");
  await expect(dialog.getByRole("button", { name: "Approve history correction" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close review" }).click();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await page.getByRole("button", { name: "View history corrections and approvals" }).click();
  await expect(page.getByRole("dialog").getByLabel("Approved shipment history correction")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close review" }).click();
  await page.getByRole("link", { name: "Back to TEST-PO-17", exact: true }).click();
  await expect(line.getByRole("group", { name: "Shipments for PO line 1", exact: true })).toBeFocused();
  await expect(line.getByTestId("shipped-pieces")).toHaveText("200,000");
  await expect(line.getByTestId("received-pieces")).toHaveText("200,000");
  await expect(line.getByTestId("remaining-pieces")).toHaveText("0");
  expect(keys).toHaveLength(1); expect(failures).toEqual([]);
});

test("a lost approval response retries the same intent and shows the saved approval", async ({ page }) => {
  const { failures, keys } = await setup(page, { loseResponse: true });
  await page.goto("/shipments/42");
  const dialog = await fillReview(page);
  await dialog.getByRole("button", { name: "Approve history correction" }).click();
  await expect(dialog.getByRole("button", { name: "Retry same approval" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Edit review" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Retry same approval" }).click();
  await expect(dialog.getByLabel("Approved shipment history correction")).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(failures).toEqual([]);
});

test("read-only users see the evidence and approval requirement without an approval control", async ({ page }) => {
  const { failures } = await setup(page, { admin: false });
  await page.goto("/shipments/42");
  await page.getByRole("button", { name: "Review shipment history", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("An Administrator with purchasing approval permission");
  await expect(dialog.getByLabel("Unresolved quantity evidence")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Approve|Review before/ })).toHaveCount(0);
  expect(failures).toEqual([]);
});
