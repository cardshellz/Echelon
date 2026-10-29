import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import type { ShipmentMeasurementPreview } from "../../shared/procurement/shipment-measurement-correction";

async function setup(page: Page, options: { loseResponse?: boolean; cannotApprove?: boolean; stale?: boolean; costing?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { saved: false, keys: [] as string[], previews: 0, approvalCount: 0, closed: !options.costing, closes: 0 };
  const before = { cartonCount: 2, dimensionBasis: "carton" as const, weightKg: "5.000", lengthCm: "10.00", widthCm: "10.00", heightCm: "10.00" };
  const after = { ...before, lengthCm: "30.00" };
  const lines = [{ lineId: 1, sku: "FIRST-PO-PRODUCT", purchaseOrderId: 17, shippedPieces: 100 },
    { lineId: 2, sku: "SECOND-PO-PRODUCT", purchaseOrderId: 99, shippedPieces: 100 }];
  let approvedPreview: ShipmentMeasurementPreview;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/inbound-shipments/42" && request.method() === "GET") return route.fulfill({ json: {
      id: 42, shipmentNumber: "TEST-MEASUREMENT-SHIP", status: state.closed ? "closed" : "costing", mode: "sea_fcl", purchaseOrderId: 17,
      allocationMethodDefault: "by_volume", statusHistory: [], lines: lines.map(line => ({ id: line.lineId, purchaseOrderId: line.purchaseOrderId,
        purchaseOrderLineId: line.lineId + 100, sku: line.sku, productName: line.sku, qtyShipped: line.shippedPieces,
        ...(state.saved && line.lineId === 1 ? after : { ...before, lengthCm: options.costing && line.lineId === 1 ? null : before.lengthCm }), allocatedCostCents: line.lineId === 1 ? state.saved ? 3750 : 2500 : state.saved ? 1250 : 2500 })),
      costs: [{ id: 71, costType: "freight", actualCents: 5000, estimatedCents: 5000, allocationMethod: "by_volume", currency: "USD", costStatus: "finalized" }],
    } });
    if (path.endsWith("/42/measurements") && request.method() === "GET") return route.fulfill({ json: {
      shipmentId: 42, shipmentNumber: "TEST-MEASUREMENT-SHIP", status: state.closed ? "closed" : "costing", sourceVersion: state.saved ? "c".repeat(64) : "a".repeat(64),
      canApprove: !options.cannotApprove, blockedReason: null, lines: lines.map(line => ({ ...line, measurements: state.saved && line.lineId === 1 ? after : { ...before, lengthCm: options.costing && line.lineId === 1 ? null : before.lengthCm } })),
      approvals: state.saved ? [{ id: 1, actorId: "test-user", actorName: "Test administrator", approvedAt: "2026-10-29T12:00:00Z", preview: approvedPreview }] : [],
    } });
    if (path.endsWith("/42/measurements/preview")) {
      state.previews++;
      const input = request.postDataJSON();
      expect(input.lines[0].measurements.lengthCm).toBe("30");
      approvedPreview = { shipmentId: 42, shipmentNumber: "TEST-MEASUREMENT-SHIP", status: state.closed ? "closed" : "costing", sourceVersion: input.sourceVersion,
        previewVersion: "b".repeat(64), reason: input.reason, chargeCents: 5000,
        lines: lines.map((line, index) => ({ ...line, before: { ...before, lengthCm: options.costing && index === 0 ? null : before.lengthCm }, after: index === 0 ? after : before,
          physicalTotals: { before: { totalWeightKg: "10.000", totalVolumeCbm: options.costing && index === 0 ? "0.000000" : "0.002000", chargeableWeightKg: "10.000" },
            after: { totalWeightKg: "10.000", totalVolumeCbm: index === 0 ? "0.006000" : "0.002000", chargeableWeightKg: "10.000" } },
          allocatedCents: { before: 2500, after: index === 0 ? 3750 : 1250 }, landedTotalCents: { before: 13500, after: index === 0 ? 14750 : 12250 } })),
        impact: { lots: [{ lotId: 501, lotNumber: "TEST-LOT-501", onHandUnits: 1, unitCostMills: { before: 675000, after: 737500 } }],
          orderCosts: [{ costId: 10, orderId: 1, quantity: 1, totalMills: { before: 675000, after: 737500 } }], historicalCosts: [], applications: [] } };
      return route.fulfill({ json: approvedPreview });
    }
    if (path.endsWith("/42/close") && request.method() === "POST") {
      state.closes++;
      if (!state.saved) return route.fulfill({ status: 400, json: { code: "MISSING_ALLOCATION_DIMENSIONS", error: "Box dimensions are missing.", details: { code: "MISSING_ALLOCATION_DIMENSIONS" } } });
      state.closed = true;
      return route.fulfill({ json: { id: 42, status: "closed", costApplication: { status: "applied", updated: 1, total: 1, skipped: [] } } });
    }
    if (path.endsWith("/42/update-costs") && request.method() === "POST") {
      const input = request.postDataJSON();
      if (!input.measurementCorrection) return route.fulfill({ status: 400, json: { code: "MISSING_ALLOCATION_DIMENSIONS", error: "Box dimensions are missing." } });
      expect(input.measurementCorrection.previewVersion).toBe("b".repeat(64));
      expect(input.measurementCorrection.evidenceConfirmed).toBe(true);
      expect(input.measurementCorrection.lines[0].measurements).not.toHaveProperty("qtyShipped");
      state.keys.push(request.headers()["idempotency-key"]);
      if (options.stale) return route.fulfill({ status: 409, json: { code: "SHIPMENT_MEASUREMENTS_STALE", error: "The shipment charges changed. Reload and review the measurements again." } });
      state.saved = true; state.approvalCount = 1;
      if (options.loseResponse && state.keys.length === 1) return route.abort("connectionreset");
      return route.fulfill({ json: { shipmentId: 42, status: "applied", updated: 1, total: 1, skipped: [], finalizedLines: 2, adjustments: 2,
        measurementCorrection: { auditEventId: 1, actorId: "test-user", actorName: "Test administrator", approvedAt: "2026-10-29T12:00:00Z", preview: approvedPreview } } });
    }
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=allocation&purchase=purchase%3A17%3Alines");
  await page.getByRole("button", { name: "Measurements and approvals", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Length (cm) FIRST-PO-PRODUCT", { exact: true })).toBeVisible();
  return { state, failures, dialog };
}
async function editAndReview(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Length (cm) FIRST-PO-PRODUCT", { exact: true }).fill("30");
  await dialog.getByLabel("Reason / packing document reference").fill("Packing document confirms the shipping carton dimensions");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Shipment cost shares before and after" })).toBeVisible();
  await dialog.getByLabel("I checked these measurements against the packing document and reviewed the cost changes.").check();
}
test("one admin approval corrects closed-shipment measurements and shows every PO cost share and saved approval", async ({ page }, info) => {
  const { state, failures, dialog } = await setup(page);
  await editAndReview(page);
  const shares = dialog.getByRole("region", { name: "Shipment cost shares before and after" });
  if (page.viewportSize()!.width < 640) {
    await expect(shares.getByTestId("mobile-cost-share-1")).toContainText("$37.50");
    await expect(shares.getByTestId("mobile-cost-share-2")).toContainText("$12.50");
  } else {
    await expect(shares.getByRole("row").filter({ hasText: "FIRST-PO-PRODUCT" })).toContainText("$37.50");
    await expect(shares.getByRole("row").filter({ hasText: "SECOND-PO-PRODUCT" })).toContainText("$12.50");
  }
  await expect(dialog).toContainText("Shipped pieces, receipts and stock counts stay unchanged.");
  expect(state.saved).toBe(false);
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath("measurement-cost-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Approve and update costs" }).click();
  await expect(dialog.getByRole("heading", { name: "Measurements and costs saved" })).toBeVisible();
  await expect(dialog.getByText("Saved approvals (1)", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Test administrator");
  expect(state.keys).toHaveLength(1); expect(state.approvalCount).toBe(1);
  await page.screenshot({ path: info.outputPath("measurement-cost-approval.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get("purchase")).toBe("purchase:17:lines");
  expect(failures).toEqual([]);
});
test("a lost approval response retains its reviewed request and idempotency key", async ({ page }) => {
  const { state, failures, dialog } = await setup(page, { loseResponse: true });
  await editAndReview(page);
  await dialog.getByRole("button", { name: "Approve and update costs" }).click();
  await expect(dialog.getByRole("alert")).toContainText("We could not confirm");
  await expect(dialog.getByRole("button", { name: "Edit measurements" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry saved approval" }).click();
  await expect(dialog.getByRole("heading", { name: "Measurements and costs saved" })).toBeVisible();
  expect(state.keys).toHaveLength(2); expect(state.keys[0]).toBe(state.keys[1]); expect(state.approvalCount).toBe(1);
  expect(failures).toEqual([]);
});
test("a changed source offers a direct reload and cannot save stale costs", async ({ page }) => {
  const { state, dialog } = await setup(page, { stale: true });
  await editAndReview(page);
  await dialog.getByRole("button", { name: "Approve and update costs" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reload and review");
  await dialog.getByRole("button", { name: "Reload measurements" }).click();
  await expect(dialog.getByLabel("Length (cm) FIRST-PO-PRODUCT", { exact: true })).toHaveValue("10.00");
  expect(state.saved).toBe(false);
});
test("server authority controls measurement corrections even for an apparent admin session", async ({ page }) => {
  const { dialog, state } = await setup(page, { cannotApprove: true });
  await expect(dialog.getByText("A current Administrator with purchasing approval permission must approve this correction.")).toBeVisible();
  await expect(dialog.getByLabel("Length (cm) FIRST-PO-PRODUCT", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(state.previews).toBe(0); expect(state.keys).toEqual([]);
});
test("a cost update blocked by missing measurements opens the same correction without leaving the shipment", async ({ page }) => {
  const { dialog, failures } = await setup(page);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await page.getByRole("button", { name: "Update shipment costs", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Correct shipment measurements" })).toBeVisible();
  await expect(dialog.getByLabel("Length (cm) FIRST-PO-PRODUCT", { exact: true })).toHaveValue("10.00");
  expect(new URL(page.url()).pathname).toBe("/shipments/42"); expect(failures).toEqual([]);
});
test("closing a received shipment opens the same approved measurement editor and can finish after correction", async ({ page }) => {
  const { dialog, state, failures } = await setup(page, { costing: true });
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await page.getByRole("tab", { name: "Lines (2)", exact: true }).click();
  await page.getByRole("button", { name: "Close Shipment", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Correct shipment measurements" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Enter missing dimensions", exact: true })).toHaveCount(0);
  await editAndReview(page);
  await dialog.getByRole("button", { name: "Approve and update costs" }).click();
  await expect(dialog.getByRole("heading", { name: "Measurements and costs saved" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await page.getByRole("button", { name: "Close Shipment", exact: true }).click();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  expect(state.closes).toBe(2); expect(state.approvalCount).toBe(1); expect(failures).toEqual([]);
});
