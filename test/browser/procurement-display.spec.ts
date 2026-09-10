import { expect, test, type Page } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import type { PurchaseWorkspace } from "../../shared/procurement/purchase-workspace";
import { installFixtures, po } from "./procurement-fixtures";

function scheduleWorkspace(): PurchaseWorkspace {
  return {
    purchase: {
      id: 17, poNumber: "TEST-PO-17", status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "unbilled",
      currency: "USD", vendorName: "Test vendor", totalCents: 10000, invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0,
      expectedDeliveryDate: "2026-10-31T00:00:00Z", confirmedDeliveryDate: "2026-06-02T00:00:00Z", actualDeliveryDate: null, lines: [],
    },
    shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
  };
}

for (const timezoneId of ["America/New_York", "Asia/Tokyo"]) {
  test.describe(`purchase schedule in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test("list, header, lifecycle and inspector retain the same scheduled calendar dates", async ({ page }, testInfo) => {
      const failures = await installFixtures(page);
      const workspace = scheduleWorkspace();
      const purchase = { ...po(17), expectedDeliveryDate: workspace.purchase.expectedDeliveryDate, confirmedDeliveryDate: workspace.purchase.confirmedDeliveryDate, createdAt: "2026-06-01T12:00:00Z" };
      await page.route("**/api/purchase-orders?*", (route) => route.fulfill({ json: { purchaseOrders: [purchase], total: 1 } }));
      await page.route("**/api/purchase-orders/17", (route) => route.fulfill({ json: purchase }));
      await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: workspace }));
      await page.goto("/purchase-orders");
      if (testInfo.project.name === "mobile") await expect(page.getByText(/ETA Oct 31/).filter({ visible: true })).toBeVisible();
      else await expect(page.getByRole("cell", { name: "Oct 31, 2026", exact: true })).toBeVisible();
      await page.getByText("TEST-PO-17", { exact: true }).filter({ visible: true }).click();
      await expect(page.getByText("Requested: Oct 31, 2026", { exact: true })).toBeVisible();
      await expect(page.getByText("Vendor confirmed: Jun 2, 2026", { exact: true })).toBeVisible();
      const overview = page.getByTestId("purchase-workspace-records");
      await expect(overview.getByText("Jun 2, 2026", { exact: true })).toBeVisible();
      await overview.locator('[data-workspace-record="purchase:17"]').click();
      const inspector = page.getByTestId("purchase-record-inspector");
      await expect(inspector.getByText("Oct 31, 2026", { exact: true })).toBeVisible();
      await expect(inspector.getByText("Jun 2, 2026", { exact: true })).toBeVisible();
      expect(failures).toEqual([]);
    });
  });
}

async function setupSuppliers(page: Page, failedCatalog = false) {
  const failures = await installFixtures(page);
  const supplier = (id: number, name: string) => ({ id, code: `SUPPLIER-${id}`, name, active: 1, currency: "USD", defaultLeadTimeDays: 30 });
  const mapping = (id: number, vendorId: number, isPreferred: number) => ({ id, vendorId, productId: id, productVariantId: null, vendorSku: `TEST-SKU-${id}`, productSku: `TEST-SKU-${id}`, productName: `Fictional product ${id}`, pricingBasis: "legacy_unknown", unitCostMills: null, unitCostCents: null, isPreferred, isActive: 1, packSize: 1, moq: 1 });
  await page.route("**/api/vendors", (route) => route.fulfill({ json: [supplier(1, "Fictional supplier A"), supplier(2, "Fictional supplier B")] }));
  await page.route("**/api/vendors/1/products", (route) => route.fulfill({ json: [mapping(11, 1, 1), mapping(12, 1, 0), mapping(13, 1, 1)] }));
  await page.route("**/api/vendors/2/products", (route) => route.fulfill(failedCatalog ? { status: 503, json: { error: "Fictional catalog temporarily unavailable" } } : { json: [mapping(21, 2, 1)] }));
  await page.goto("/suppliers");
  return failures;
}

test("supplier mapping totals explicitly follow the expanded supplier, including no selection", async ({ page }) => {
  const failures = await setupSuppliers(page);
  const mapped = page.getByTestId("supplier-catalog-count");
  const preferred = page.getByTestId("supplier-preferred-count");
  await expect(mapped).toContainText("Expand a supplier to view counts");
  await page.getByText("Fictional supplier A", { exact: true }).filter({ visible: true }).click();
  await expect(mapped).toHaveText("3Catalog mappingsFor Fictional supplier A");
  await expect(preferred).toHaveText("2Preferred mappingsFor Fictional supplier A");
  await page.getByText("Fictional supplier B", { exact: true }).filter({ visible: true }).click();
  await expect(mapped).toHaveText("1Catalog mappingsFor Fictional supplier B");
  await expect(preferred).toHaveText("1Preferred mappingsFor Fictional supplier B");
  await page.getByText("Fictional supplier B", { exact: true }).filter({ visible: true }).click();
  await expect(mapped).toContainText("Expand a supplier to view counts");
  expect(failures).toEqual([]);
});

test("a failed supplier catalog is unavailable rather than an empty mapping total", async ({ page }) => {
  const failures = await setupSuppliers(page, true);
  await page.getByText("Fictional supplier B", { exact: true }).filter({ visible: true }).click();
  for (const testId of ["supplier-catalog-count", "supplier-preferred-count"]) {
    await expect(page.getByTestId(testId)).toContainText("Unavailable");
    await expect(page.getByTestId(testId)).toContainText("For Fictional supplier B");
  }
  expect(failures).toEqual([]);
});

async function setupExplanation(page: Page, historical: boolean, method: "weighted_blend_v1" | "recent_order_velocity_v1" = "weighted_blend_v1") {
  const failures = await installFixtures(page);
  const analysis = generatePurchasingRecommendations({
    asOf: "2026-09-10T12:00:00Z", lookbackDays: 30,
    autoDraftSettings: { forecastPolicy: { method, weights: { short: 30, standard: 35, long: 20, seasonal: 15 } } },
    rows: [{
      product_id: 10, variant_id: 100, base_sku: "EXPLAIN-PACK", product_name: "Fictional case pack item", total_pieces: 0, total_reserved_pieces: 0,
      total_outbound_pieces: 60, previous_outbound_pieces: 60, demand_order_count: 12, demand_active_days: 10, latest_demand_at: "2026-09-09T12:00:00Z",
      short_window_days: 7, short_outbound_pieces: 14, long_window_days: 90, long_outbound_pieces: 180,
      seasonal_window_days: 30, seasonal_outbound_pieces: 60, seasonal_demand_order_count: 12, seasonal_demand_active_days: 10,
      on_order_pieces: 0, open_po_count: 0, vendor_lead_time_days: 2, safety_stock_days: 1, preferred_vendor_id: 2, preferred_vendor_name: "Test supplier",
      vendor_product_id: 20, vendor_pricing_basis: "per_piece", vendor_quoted_unit_cost_mills: 10000, estimated_cost_mills: 10000,
      vendor_pack_size: 500, vendor_moq: 1, vendor_quoted_at: "2026-09-09T12:00:00Z", vendor_quote_valid_until: "2026-10-31",
    }],
  });
  if (historical) delete analysis.items[0].orderRounding;
  await page.route("**/api/settings/procurement", (route) => route.fulfill({ json: { useNewPoEditor: true, useNewReorderCockpit: true } }));
  await page.route("**/api/purchasing/reorder-analysis", (route) => route.fulfill({ json: analysis }));
  await page.route("**/api/purchasing/kpis", (route) => route.fulfill({ json: { criticalRestocks: 1, upcomingRestocks: 0, idleCapitalCents: 0, inboundPipelineValueCents: 0, totalOpenLines: 0, lastComputedAt: "2026-09-10T12:00:00Z" } }));
  await page.route("**/api/purchasing/exclusion-rules", (route) => route.fulfill({ json: { rules: [], totalExcluded: 0 } }));
  await page.route("**/api/purchasing/exclusion-rules/field-values?*", (route) => route.fulfill({ json: { field: "category", values: [] } }));
  await page.route("**/api/purchasing/auto-draft-settings", (route) => route.fulfill({ json: { autoDraftMode: "review_only", forecastPolicy: {} } }));
  // This fixture has no evaluation history. The independent diagnostics read is explicitly unavailable.
  await page.route("**/api/purchasing/forecast-backtests?*", (route) => route.fulfill({ status: 503, json: { error: "Fictional evaluation service unavailable" } }));
  await page.route("**/api/procurement/health/recommendation-pipeline", (route) => route.fulfill({ status: 503, json: { error: "Fictional health service unavailable" } }));
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  return { failures, analysis };
}

test("Explain shows fractional forecast weights as percentages and the engine's supplier pack increment", async ({ page }) => {
  const { failures, analysis } = await setupExplanation(page, false);
  expect(analysis.items[0]).toMatchObject({ orderUomUnits: 1, suggestedOrderPieces: 500, orderRounding: { incrementPieces: 500, source: "vendor_pack" } });
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("2.00×30% + 2.00×35% + 2.00×20% + 2.00×15%");
  await expect(drawer).toContainText("Round up in 500-piece increments (supplier case pack)");
  await expect(drawer).not.toContainText("2.00×0.3%");
  await expect(drawer).not.toContainText("to pieces of 1");
  expect(failures).toEqual([]);
});

test("Explain preserves unknown rounding provenance on older recommendation snapshots", async ({ page }) => {
  const { failures } = await setupExplanation(page, true);
  await expect(page.getByRole("dialog")).toContainText("Rounding basis not recorded");
  await expect(page.getByRole("dialog")).not.toContainText("Round up in 500-piece increments");
  expect(failures).toEqual([]);
});

test("recent-window forecasting does not claim available seasonal history was missing or redistributed", async ({ page }) => {
  const { failures, analysis } = await setupExplanation(page, false, "recent_order_velocity_v1");
  expect(analysis.items[0].forecastProvenance.forecastBlend.seasonalHistoryAvailable).toBe(true);
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("2.00 = 2.00×100%");
  await expect(drawer).not.toContainText("redistributed");
  await expect(drawer).not.toContainText("no sales in the last-year window");
  expect(failures).toEqual([]);
});
