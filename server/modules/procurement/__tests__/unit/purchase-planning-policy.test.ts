import { describe, expect, it } from "vitest";
import { defaultPurchasePlanningPolicy, parsePurchasePlanningPolicy, purchasePlanningPolicySchema } from "@shared/procurement/purchase-planning-policy";
import { generatePurchasingRecommendations, type PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import { buildPurchasingForecastPolicyCohort } from "../../purchasing-forecast-policy";
import { buildPurchaseForecastObservations } from "../../purchase-recommendation-snapshot.service";

const row: PurchasingRecommendationRawRow = { product_id: 10, variant_id: 100, base_sku: "STOCK", product_name: "Stock item", total_pieces: 100, total_reserved_pieces: 0, total_outbound_pieces: 300, previous_outbound_pieces: 300,
  demand_order_count: 20, demand_active_days: 15, latest_demand_at: "2026-09-01", vendor_lead_time_days: 30, safety_stock_days: 5, on_order_pieces: 0, inbound_schedule: [], preferred_vendor_id: 5, vendor_product_id: 50, vendor_pack_size: 24, vendor_moq: 100 };
const run = (policy = defaultPurchasePlanningPolicy(), raw = row) => generatePurchasingRecommendations({ rows: [raw], lookbackDays: 30, asOf: "2026-09-01T12:00:00.000Z", autoDraftSettings: { planningPolicy: policy } });

describe("purchase growth and stock policy", () => {
  it("sizes the target from explicit ranges and captures their isolated forecast cohort", () => {
    const ranges = [{ productId: 10, startDate: "2026-09-01", endDate: "2026-09-30", totalPieces: 600, reference: "September plan" }];
    const policy = { ...defaultPurchasePlanningPolicy(), growthPercent: 50, products: [{ productId: 10, essential: false, minimumStockPieces: 0, targetCoverDays: null, leadTimeStages: null }], replacementForecasts: ranges };
    const analysis = run(policy);
    expect(analysis.items[0]).toMatchObject({ avgDailyUsage: 15, reorderPoint: 675, suggestedOrderPieces: 576, planningBasis: { replacementForecasts: ranges } });
    const observation = buildPurchaseForecastObservations(analysis)[0];
    expect(observation.forecastPolicyCaptureVersion).toBe(3);
    expect(observation.forecastPolicySnapshot.replacementForecasts).toEqual(ranges);
    expect(observation.forecastDailyPiecesMicros).toBe(15_000_000);
  });

  it("preserves excluded quarantine evidence without subtracting it twice", () => {
    expect(run(defaultPurchasePlanningPolicy(), { ...row, total_pieces: 120, total_reserved_pieces: 30, excluded_quarantine_pieces: 1000 }).items[0])
      .toMatchObject({ available: 90, suggestedOrderPieces: 264, planningBasis: { excludedQuarantinePieces: 1000 } });
    expect(() => run(defaultPurchasePlanningPolicy(), { ...row, excluded_quarantine_pieces: "invalid" })).toThrow(/quarantine evidence/);
    expect(run(defaultPurchasePlanningPolicy(), { ...row, vendor_currency: "USD", vendor_free_freight_threshold_cents: "invalid" }).items[0].supplierBundleTerms).toBeNull();
  });

  it("keeps default forecasts unchanged while preserving MOQ and pack rounding", () => {
    expect(run().items[0]).toMatchObject({ avgDailyUsage: 10, leadTimeDays: 30, reorderPoint: 350, suggestedOrderPieces: 264, planningBasis: { growthPercent: 0, essential: false, targetCoverDays: 35 } });
  });
  it("applies uniform growth to the existing forecast before MOQ rounding", () => {
    expect(run({ ...defaultPurchasePlanningPolicy(), growthPercent: 50 }).items[0]).toMatchObject({ avgDailyUsage: 15, reorderPoint: 525, suggestedOrderPieces: 432, planningBasis: { historicalDailyPieces: 10, adjustedDailyPieces: 15 } });
  });
  it("uses a minimum stock buffer and target cover with explicit staged lead time", () => {
    const policy = { ...defaultPurchasePlanningPolicy(), targetCoverDays: 90, products: [{ productId: 10, essential: true, minimumStockPieces: 500, targetCoverDays: 180, leadTimeStages: { rfqDays: 10, productionDays: 80, transitDays: 45, receivingDays: 5 } }] };
    expect(run(policy).items[0]).toMatchObject({ leadTimeDays: 140, reorderPoint: 1900, suggestedOrderPieces: 1800, leadTimeBasis: { leadTimeSource: "planning_policy" }, planningBasis: { essential: true, minimumStockPieces: 500, targetCoverDays: 180 } });
  });
  it("cannot reduce the supplier lead and safety floor through a small target override", () => {
    expect(run({ ...defaultPurchasePlanningPolicy(), targetCoverDays: 2 }).items[0].reorderPoint).toBe(350);
  });
  it("supports an essential minimum with no historical demand while retaining the human review gate", () => {
    const policy = { ...defaultPurchasePlanningPolicy(), products: [{ productId: 10, essential: true, minimumStockPieces: 200, targetCoverDays: null, leadTimeStages: null }] };
    expect(run(policy, { ...row, total_outbound_pieces: 0, previous_outbound_pieces: 0 }).items[0]).toMatchObject({ status: "order_now", suggestedOrderPieces: 120, qualityGate: { autoDraftEligible: false } });
  });
  it("preserves the historical cohort and records growth in distinct snapshot evidence", () => {
    const standard = buildPurchaseForecastObservations(run())[0];
    const grown = buildPurchaseForecastObservations(run({ ...defaultPurchasePlanningPolicy(), growthPercent: 50 }))[0];
    expect(standard.forecastPolicyCaptureVersion).toBe(1);
    expect(grown.forecastPolicyCaptureVersion).toBe(2);
    expect(grown.forecastPolicyFingerprint).not.toBe(standard.forecastPolicyFingerprint);
    expect(grown.forecastPolicySnapshot.growthPercent).toBe(50);
    expect(grown.forecastDailyPiecesMicros).toBe(15_000_000);
    expect(grown.baselineDailyPiecesMicros).toBe(10_000_000);
    expect(buildPurchasingForecastPolicyCohort({ growthPercent: 0 }).captureVersion).toBe(1);
  });
  it("holds uncertain open supply without creating replacement quantities automatically", () => {
    const item = run(defaultPurchasePlanningPolicy(), { ...row, on_order_pieces: 1000, open_po_count: 1, inbound_schedule: undefined }).items[0];
    expect(item.suggestedOrderPieces).toBe(0);
    expect(item.supplyTiming.reviewRequired).toBe(true);
    expect(item.reviewSignal.action).toBe("review_open_po");
    expect(item.qualityGate.autoDraftEligible).toBe(false);
  });
  it("uses the injected clock for supplier-cycle evidence", () => {
    const item = run(defaultPurchasePlanningPolicy(), { ...row, on_order_pieces: 300, open_po_count: 1, earliest_expected: "2026-09-05", inbound_schedule: [{ purchaseOrderId: 1, purchaseOrderNumber: "PO-1", purchaseOrderLineId: 1, remainingPieces: 300, expectedDate: "2026-09-05" }] }).items[0];
    expect(item.supplierCycleDiagnostics.daysUntilEarliestExpected).toBe(4);
  });
  it.each(["50", null, true, 0.5, NaN, Infinity, 1001, -101])("rejects invalid growth values %j", (growthPercent) => {
    expect(purchasePlanningPolicySchema.safeParse({ ...defaultPurchasePlanningPolicy(), growthPercent }).success).toBe(false);
  });
  it("rejects unconfigured essential targets and duplicate product policies", () => {
    const product = { productId: 10, essential: true, minimumStockPieces: 0, targetCoverDays: null, leadTimeStages: null };
    expect(() => parsePurchasePlanningPolicy({ ...defaultPurchasePlanningPolicy(), products: [product] })).toThrow();
    expect(() => parsePurchasePlanningPolicy({ ...defaultPurchasePlanningPolicy(), products: [{ ...product, essential: false }, { ...product, essential: false }] })).toThrow();
  });
  it("canonicalizes product ordering without mutating inputs", () => {
    const policy = { ...defaultPurchasePlanningPolicy(), products: [{ productId: 20, essential: false, minimumStockPieces: 0, targetCoverDays: null, leadTimeStages: null }, { productId: 10, essential: false, minimumStockPieces: 0, targetCoverDays: null, leadTimeStages: null }] };
    expect(parsePurchasePlanningPolicy(policy).products.map((product) => product.productId)).toEqual([10, 20]);
    expect(policy.products.map((product) => product.productId)).toEqual([20, 10]);
  });
});
