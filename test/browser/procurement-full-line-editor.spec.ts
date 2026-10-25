import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { ShipmentEditorContext, ShipmentEditorPreview, ShipmentEditorRequest } from "@shared/procurement/shipment-editor";
import type { PoQuantityAmendmentContext, PoQuantityAmendmentPreview, PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";

const version = "a".repeat(64), reviewed = "b".repeat(64);
const admin = { user: { id: "editor-admin", username: "Reviewer", role: "admin" }, roles: ["Administrator"], permissions: ["purchasing:view", "purchasing:approve", "inventory:view"] };
const product = { id: 2, sku: "NEW-PRODUCT", name: "Added product", isActive: true,
  variants: [{ id: 20, sku: "NEW-PIECE", name: "Piece", unitsPerVariant: 1, isActive: true }] };

test("PO editor adds and removes lines in one review and retains protected receipt history", async ({ page }) => {
  const failures = await installFixtures(page);
  const line: PoQuantityAmendmentContext["lines"][number] = { id: 11, lineNumber: 1, name: "Unused original product", orderQty: 10, receivedQty: 0, invoicedQty: 0,
    unitCostMills: 10000, totalProductCostCents: 1000, packagingCostCents: 0, discountCents: 0, taxCents: 0, componentTotalCents: 1000,
    lineType: "product", pricing: { basis: "per_piece", quantityPieces: 10, unitCostMills: 10000 }, lineTotalCents: 1000, status: "open", blockedReason: null, removalBlockedReason: null };
  const protectedLine = { ...line, id: 12, lineNumber: 2, name: "Received product", receivedQty: 10, status: "received", removalBlockedReason: "This line has receipts. Its history cannot be deleted from the PO." };
  const context: PoQuantityAmendmentContext = { purchaseOrderId: 17, currency: "USD", sourceVersion: version, canApprove: true, blockedReason: null, lines: [line, protectedLine] };
  let preview: PoQuantityAmendmentPreview;
  const approvals: PoQuantityPreviewRequest[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: admin });
    if (path === "/api/products") return route.fulfill({ json: [product] });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), status: "partially_received" } });
    if (path === "/api/purchase-orders/17/quantity-amendment" && request.method() === "GET") return route.fulfill({ json: context });
    if (path === "/api/purchase-orders/17/quantity-amendment/preview") {
      const body = request.postDataJSON() as PoQuantityPreviewRequest;
      expect(body.removals).toEqual([11]); expect(body.changes).toEqual([]); expect(body.additions).toHaveLength(1);
      preview = { purchaseOrderId: 17, currency: "USD", sourceVersion: version, previewVersion: reviewed, reason: body.reason, lines: [],
        removedLines: [line], addedLines: [{ clientKey: body.additions![0].clientKey, lineNumber: 3, productId: 2, name: product.name, sku: product.sku,
          expectedReceiveVariantId: 20, expectedReceiveUnitsPerVariant: 1, orderQty: 20, unitCostMills: 25000, totalProductCostCents: 5000,
          packagingCostCents: 0, discountCents: 0, taxCents: 0, lineTotalCents: 5000, sourceFingerprint: version }],
        beforeTotalCents: 2000, afterTotalCents: 6000, beforeStatus: "partially_received", afterStatus: "partially_received", warnings: [], invoiceMatches: [],
        impact: { quantities: [], shipments: [], lots: [], orderCosts: [], historicalCosts: [], applications: [] } };
      return route.fulfill({ json: preview });
    }
    if (path === "/api/purchase-orders/17/quantity-amendment" && request.method() === "POST") {
      approvals.push(request.postDataJSON());
      return route.fulfill({ json: { purchaseOrderId: 17, revisionNumber: 3, auditEventId: 101, preview } });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await page.getByRole("button", { name: "Edit PO", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Remove line 2", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/This line has receipts/)).toBeVisible();
  await dialog.getByRole("button", { name: "Remove line 1", exact: true }).click();
  await dialog.getByRole("button", { name: "Add line item" }).click();
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await dialog.getByLabel("Product", { exact: true }).selectOption("2");
  await dialog.getByLabel("Receive as", { exact: true }).selectOption("20");
  await dialog.getByLabel("Pieces ordered").fill("20");
  await dialog.getByLabel("Product price / piece (USD)").fill("2.5000");
  await dialog.getByRole("button", { name: "Add to this edit" }).click();
  await dialog.getByLabel("Reason for editing / supplier reference").fill("Supplier approved this replacement line");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("cell", { name: /^Add .* Added product$/ })).toBeVisible();
  await expect(dialog.getByText(/1 added/)).toBeVisible();
  await dialog.screenshot({ path: test.info().outputPath("po-edit-review.png") });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve & save PO" }).click();
  await expect(dialog.getByRole("status")).toContainText("saved as revision 3");
  expect(approvals).toHaveLength(1); expect(failures).toEqual([]);
  await expect(page).toHaveURL(/purchase-orders\/17\?tab=lines/);
});

async function shipmentSetup(page: Page, options: { lost?: boolean; blocked?: boolean; stale?: boolean; canApprove?: boolean; refreshFailure?: boolean } = {}) {
  const failures = await installFixtures(page);
  const line: ShipmentEditorContext["lines"][number] = { key: "line:7", id: 7, sku: "ORIGINAL", name: "Original product", purchaseOrderId: 17, purchaseOrderLineId: 11, poNumber: "TEST-PO-17",
    fields: { qtyShipped: 100, cartonCount: 2, dimensionBasis: "carton", weightKg: "2.000", lengthCm: "10.00", widthCm: "20.00", heightCm: "30.00", notes: null }, allocatedCostCents: 500, totalWeightKg: "4.000", totalVolumeCbm: "0.012000" };
  const context: ShipmentEditorContext = { shipmentId: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", sourceVersion: version,
    canApprove: options.canApprove !== false, blockedReason: options.blocked ? "This shipment has receiving history. Use Receipt and quantity corrections below." : null, lines: [line], charges: [{ currency: "USD", cents: 500 }], receipts: [] };
  let committed = false, lose = options.lost === true;
  const approvals: { key: string; body: unknown }[] = [];
  const results = new Map<string, unknown>();
  let preview: ShipmentEditorPreview;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: admin });
    if (path === "/api/inbound-shipments/42") return route.fulfill({ json: { id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "air", lines: [{ ...line.fields, id: 7, inboundShipmentId: 42, purchaseOrderId: 17, purchaseOrderLineId: 11, sku: "ORIGINAL", productName: line.name }], costs: [], statusHistory: [] } });
    if (path === "/api/inbound-shipments/42/editor" && request.method() === "GET") {
      if (committed && options.refreshFailure) return route.fulfill({ status: 503, json: { error: "Shipment read temporarily unavailable" } });
      return route.fulfill({ json: { ...context, sourceVersion: committed ? "c".repeat(64) : version } });
    }
    if (path === "/api/purchase-orders/work-list") return route.fulfill({ json: { items: [{ id: 99, poNumber: "TEST-PO-99", vendorId: 2, status: "sent", totalCents: 5000 }], limit: 20, offset: 0, total: 1, nextOffset: null } });
    if (path === "/api/purchase-orders/99/shippable-lines") return route.fulfill({ json: { lines: [{ id: 15, sku: "ADDED", productName: "Second PO product", remainingQty: 200,
      shipmentUnits: { productId: 2, selectedVariantId: 20, unitsPerVariantSnapshot: 1, issue: null, variants: [{ id: 20, sku: "NEW-PIECE", name: "Piece", unitsPerVariant: 1 }] } }], reviewRequiredLines: [] } });
    if (path === "/api/inbound-shipments/42/editor/preview") {
      if (options.stale) return route.fulfill({ status: 409, json: { error: "Shipment charges changed. Reload and review again.", code: "SHIPMENT_EDITOR_STALE" } });
      const body = request.postDataJSON() as ShipmentEditorRequest;
      preview = { previewVersion: reviewed, review: { shipmentId: 42, sourceVersion: version, reason: body.reason, before: [line],
        after: body.additions.length ? [{ ...line, id: null, key: `new:${body.additions[0].clientKey}`, name: "Second PO product", purchaseOrderId: 99, purchaseOrderLineId: 15, poNumber: "TEST-PO-99", fields: { qtyShipped: 200 } }] : [{ ...line, fields: { ...line.fields, ...body.changes[0].fields } }], charges: context.charges,
        costShares: [{ purchaseOrderId: 17, poNumber: "TEST-PO-17", beforeCents: 500, afterCents: 0 }, { purchaseOrderId: 99, poNumber: "TEST-PO-99", beforeCents: 0, afterCents: 500 }] } };
      return route.fulfill({ json: preview });
    }
    if (path === "/api/inbound-shipments/42/editor" && request.method() === "POST") {
      const key = request.headers()["idempotency-key"];
      approvals.push({ key, body: request.postDataJSON() });
      if (!results.has(key)) { committed = true; results.set(key, { auditId: 100, actorName: "Reviewing Admin", approvedAt: "2026-10-25T12:00:00Z", preview }); }
      if (lose) { lose = false; return route.abort("failed"); }
      return route.fulfill({ json: results.get(key) });
    }
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=lines");
  await page.getByRole("button", { name: "Edit shipment", exact: true }).click();
  return { failures, approvals, dialog: page.getByRole("dialog") };
}

test("shipment editor replaces a PO line and replays the same admin approval after a lost response", async ({ page }) => {
  const { failures, approvals, dialog } = await shipmentSetup(page, { lost: true });
  await dialog.getByRole("button", { name: "Remove line", exact: true }).click();
  await dialog.getByRole("button", { name: "Add PO line" }).click();
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await dialog.getByLabel("Purchase order", { exact: true }).selectOption("99");
  await dialog.getByLabel("PO line", { exact: true }).selectOption("15");
  await dialog.getByRole("button", { name: "Add to this edit" }).click();
  await dialog.getByLabel("Reason / document reference").fill("Verified the replacement contents with the supplier");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("Removed from shipment")).toBeVisible();
  await expect(dialog.getByText("TEST-PO-17: 5.00 → 0.00")).toBeVisible();
  await expect(dialog.getByText("TEST-PO-99: 0.00 → 5.00")).toBeVisible();
  await dialog.screenshot({ path: test.info().outputPath("shipment-edit-review.png") });
  await dialog.getByLabel("I reviewed the line changes and cost shares.").check();
  await dialog.getByRole("button", { name: "Approve & save shipment" }).click();
  await expect(dialog.getByRole("button", { name: "Retry saved approval" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Retry saved approval" }).click();
  await expect(dialog.getByRole("status")).toContainText("Approved by Reviewing Admin");
  expect(approvals).toHaveLength(2); expect(approvals[0]).toEqual(approvals[1]); expect(failures).toEqual([]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(/shipments\/42\?tab=lines/);
});

test("shipment editor keeps a stale review unsavable and explains receiving restrictions", async ({ page }) => {
  const { dialog, approvals, failures } = await shipmentSetup(page, { stale: true });
  await dialog.getByLabel("Pieces 7", { exact: true }).fill("150");
  await dialog.getByLabel("Reason / document reference").fill("Corrected the supplier manifest count");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Shipment charges changed");
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  expect(approvals).toEqual([]); expect(failures).toEqual([]);
});

test("shipment with receiving history explains why physical lines cannot be removed", async ({ page }) => {
  const { dialog, approvals } = await shipmentSetup(page, { blocked: true });
  await expect(dialog.getByText(/This shipment has receiving history/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove line", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Receipt and quantity corrections", exact: true }).first()).toBeEnabled();
  expect(approvals).toEqual([]);
});

test("a refresh failure does not replace a saved shipment approval with an error", async ({ page }) => {
  const { dialog, approvals } = await shipmentSetup(page, { refreshFailure: true });
  await dialog.getByLabel("Pieces 7", { exact: true }).fill("150");
  await dialog.getByLabel("Reason / document reference").fill("Verified the supplier packing list");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByLabel("I reviewed the line changes and cost shares.").check();
  const refresh = page.waitForResponse(response => response.url().endsWith("/api/inbound-shipments/42/editor") && response.request().method() === "GET" && response.status() === 503);
  await dialog.getByRole("button", { name: "Approve & save shipment" }).click();
  await refresh;
  await expect(dialog.getByRole("status")).toContainText("Approved by Reviewing Admin");
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
  expect(approvals).toHaveLength(1);
});
