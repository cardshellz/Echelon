import { describe, expect, it } from "vitest";
import { generatePurchasingRecommendations, type PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { purchaseBuyingDisposition } from "@shared/procurement/purchase-buying-review";
import { forwardDemandBuyingRow, PURCHASE_BUYING_AS_OF } from "../fixtures/purchase-buying-review.fixture";

const row = (overrides: Partial<PurchasingRecommendationRawRow> = {}): PurchasingRecommendationRawRow => ({
  product_id: 1, base_sku: "TEST-STOCK", product_name: "Fictional stock", total_pieces: 0,
  total_outbound_pieces: 300, preferred_vendor_id: 10, lead_time_days: 30,
  safety_stock_days: 7, inventory_variant_policies: [{ requiresShipping: true, trackInventory: true }], ...overrides,
});
const analyze = (rows: PurchasingRecommendationRawRow[]) => generatePurchasingRecommendations({
  asOf: "2026-09-10T12:00:00.000Z", lookbackDays: 30, requireVendor: true, rows,
});

describe("purchase priority regression", () => {
  it("never calls zero demand and zero target a buying stockout", () => {
    const result = analyze([row({ total_outbound_pieces: 0 })]);
    expect(result.items[0]).toMatchObject({ status: "no_movement", suggestedOrderPieces: 0, actionable: false });
    expect(result.summary).toMatchObject({ outOfStock: 0, belowReorderPoint: 0, actionableCount: 0 });
  });
  it("retains an essential stock floor even without sales history", () => {
    const policy = defaultPurchasePlanningPolicy();
    policy.products = [{ productId: 1, essential: true, minimumStockPieces: 100, targetCoverDays: null, leadTimeStages: null }];
    const result = generatePurchasingRecommendations({ asOf: "2026-09-10T12:00:00.000Z", lookbackDays: 30, rows: [row({ total_outbound_pieces: 0 })], autoDraftSettings: { planningPolicy: policy } });
    expect(result.items[0]).toMatchObject({ status: "stockout", suggestedOrderPieces: 100 });
    expect(result.summary.outOfStock).toBe(1);
  });
  it("retains missing-supplier demand while suppressing explicit non-stock products", () => {
    const result = analyze([
      row({ product_id: 1, preferred_vendor_id: null }),
      row({ product_id: 2, inventory_variant_policies: [{ requiresShipping: false, trackInventory: false }] }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skippedReason).toBe("no_vendor");
    expect(purchaseBuyingDisposition(result.items[0])).toBe("purchase_now");
    expect(result.summary).toMatchObject({ outOfStock: 1, excludedCount: 1 });
    expect(result.skippedItems.find((item) => item.productId === 2)).toMatchObject({ skippedReason: "excluded", actionable: false, qualityGate: { autoDraftEligible: false } });
  });
  it("keeps covered stockouts out of the buy count while preserving arrival review", () => {
    const result = analyze([row({ on_order_pieces: 1000, open_po_count: 1 })]);
    expect(result.items[0].suggestedOrderPieces).toBe(0);
    expect(result.items[0].supplyTiming?.reviewRequired).toBe(true);
    expect(purchaseBuyingDisposition(result.items[0])).toBe("supply_review");
    expect(result.summary.outOfStock).toBe(0);
  });
  it.each([
    { inboundPieces: 100, suggestedPieces: 70 },
    { inboundPieces: 169, suggestedPieces: 1 },
  ])("retains a $suggestedPieces-piece forecast shortfall with $inboundPieces pieces already ordered", ({ inboundPieces, suggestedPieces }) => {
    const result = generatePurchasingRecommendations({
      asOf: PURCHASE_BUYING_AS_OF, lookbackDays: 30, rows: [forwardDemandBuyingRow(inboundPieces)],
      autoDraftSettings: { skipOnOpenPo: true, approvalPolicy: "high_confidence_only" },
    });
    expect(result.items[0]).toMatchObject({
      reorderPoint: 470, status: "order_now", suggestedOrderPieces: suggestedPieces,
      skippedReason: null, actionable: true, forwardDemandBasis: { overlayCaptureComplete: true },
      // Correcting the buying need must not bypass quote, arrival or approval controls.
      qualityGate: { autoDraftEligible: false },
    });
    expect(result.items[0].explanation).toContain("Reorder point is 470 pieces");
    expect(purchaseBuyingDisposition(result.items[0])).toBe("purchase_now");
    expect(result.summary).toMatchObject({ belowReorderPoint: 1, skippedOnOrder: 0 });
  });
  it.each([170, 200])("skips new purchasing only when %s inbound pieces cover the full forecast target", (inboundPieces) => {
    const result = generatePurchasingRecommendations({
      asOf: PURCHASE_BUYING_AS_OF, lookbackDays: 30, rows: [forwardDemandBuyingRow(inboundPieces)],
      autoDraftSettings: { skipOnOpenPo: true },
    });
    expect(result.items[0]).toMatchObject({
      reorderPoint: 470, suggestedOrderPieces: 0, skippedReason: "already_on_order", actionable: false,
    });
    expect(result.items[0].explanation).toContain(`committed supply ${300 + inboundPieces} pieces vs reorder point 470`);
    expect(result.summary).toMatchObject({ belowReorderPoint: 0, skippedOnOrder: 1 });
  });
});
