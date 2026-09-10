import { expect, test } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import { installFixtures } from "./procurement-fixtures";

test("daily queue counts purchase needs, keeps supplier and arrival work, and explains no-buy rows", async ({ page }, testInfo) => {
  const failures = await installFixtures(page);
  const base = { total_pieces: 0, total_outbound_pieces: 300, lead_time_days: 30, safety_stock_days: 7, estimated_cost_mills: 10_000 };
  const analysis = generatePurchasingRecommendations({
    asOf: "2026-09-10T12:00:00.000Z", lookbackDays: 30, requireVendor: true,
    rows: [
      { ...base, product_id: 1, base_sku: "BUY-STOCK", product_name: "Stock item", preferred_vendor_id: 10, preferred_vendor_name: "Fictional supplier" },
      { ...base, product_id: 2, base_sku: "SOURCE-STOCK", product_name: "Needs sourcing", preferred_vendor_id: null },
      { ...base, product_id: 3, base_sku: "NO-DEMAND", product_name: "Zero demand item", total_outbound_pieces: 0 },
      { ...base, product_id: 4, base_sku: "ARRIVAL-STOCK", product_name: "Review arrival", on_order_pieces: 1000, open_po_count: 1 },
      { ...base, product_id: 5, base_sku: "UPCOMING-STOCK", product_name: "Order before the lead-time window", total_pieces: 400, preferred_vendor_id: 10 },
      { ...base, product_id: 6, base_sku: "UNVERIFIED-RECEIPT", product_name: "Resolve receipt quantities", on_order_pieces: 100, open_po_count: 1,
        receipt_supply_evidence: { version: 1, lines: [{ purchaseOrderId: 17, purchaseOrderNumber: "TEST-PO-17", purchaseOrderLineId: 171,
          orderedPieces: 100, cancelledPieces: 0, poReceivedPieces: 0, postedReceivedPieces: 0, closedGrossReceivedPieces: null, closedReceivedPieces: null,
          remainingPieces: 100, receivingLineIds: [313], reviewIssues: ["Historical receiving unit is unresolved"] }] } },
    ],
  });
  // Also tolerate a retained physical stockout status: zero purchase quantity
  // must stay out of the buy queue regardless of old status classification.
  const retainedAnalysis = { ...analysis, items: analysis.items.map((item) => item.productId === 3 ? { ...item, status: "stockout" } : item) };
  await page.route("**/api/settings/procurement", (route) => route.fulfill({ json: { useNewReorderCockpit: true } }));
  await page.route("**/api/purchasing/reorder-analysis", (route) => route.fulfill({ json: retainedAnalysis }));
  // Independently timed KPI responses must not override the current analysis counts.
  await page.route("**/api/purchasing/kpis", (route) => route.fulfill({ json: { criticalRestocks: 999, upcomingRestocks: 999, idleCapitalCents: 0, inboundPipelineValueCents: 0, totalOpenLines: 0, lastComputedAt: "2026-09-10T12:00:00.000Z" } }));
  await page.route("**/api/purchasing/exclusion-rules", (route) => route.fulfill({ json: { rules: [], totalExcluded: 0 } }));
  await page.goto("/reorder-analysis");
  await expect(page.getByTestId("buying-needs-order-count")).toHaveText("2");
  await expect(page.getByRole("button", { name: /^Needs order 2$/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /NO-DEMAND/ })).toHaveCount(0);
  const sourcing = page.getByRole("row", { name: /SOURCE-STOCK/ });
  await expect(sourcing).toContainText("Supplier needed");
  await expect(sourcing).toContainText(String(analysis.items.find((item) => item.productId === 2)!.suggestedOrderPieces));
  await expect(page.getByRole("row", { name: /ARRIVAL-STOCK/ })).toContainText("Arrival review");
  await expect(page.getByTestId("buying-order-soon-count")).toHaveText("1");
  await expect(page.getByRole("row", { name: /UPCOMING-STOCK/ })).toContainText("Burn rate high");
  const unresolved = page.getByRole("row", { name: /UNVERIFIED-RECEIPT/ });
  await expect(unresolved).toContainText("Receipt review");
  await expect(unresolved).not.toContainText("270");
  await page.screenshot({ path: testInfo.outputPath("buying-priorities.png"), fullPage: true });
  await page.getByPlaceholder("Search SKU, product, vendor…").fill("SOURCE-STOCK");
  await expect(page.getByTestId("buying-needs-order-count")).toHaveText("1");
  await expect(page.getByRole("button", { name: /^Needs order 1$/ })).toBeVisible();
  await page.getByPlaceholder("Search SKU, product, vendor…").fill("NO-DEMAND");
  await expect(page.getByTestId("buying-needs-order-count")).toHaveText("0");
  await page.getByRole("button", { name: /^All 1$/ }).click();
  await expect(page.getByRole("row", { name: /NO-DEMAND/ })).toContainText("No purchase needed");
  expect(failures).toEqual([]);
});
