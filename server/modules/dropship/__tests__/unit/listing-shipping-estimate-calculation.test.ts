import { describe, expect, it } from "vitest";
import { listingShippingEstimateCalculationSchema } from "../../../../../shared/dropship/listing-shipping-estimate";
import type { DropshipShippingCalculationResult } from "../../application/dropship-shipping-quote-service";
import type { DropshipShippingPricingResult } from "../../application/dropship-shipping-pricing-service";
import { buildListingShippingEstimateCalculation } from "../../application/listing-shipping-estimate-calculation";

const items = [{ productVariantId: 66, quantity: 2 }];
const facts = new Map([[66, { sku: "ARM-ENV-SGL-P50", weightGrams: 317.5 }]]);

function sharedPricing(): DropshipShippingPricingResult {
  return {
    source: "shared", decision: { source: "shared", mode: "live", reasonCode: "LIVE_ENABLED" }, baseRateCents: 600, currency: "USD", rateTableId: 5,
    quote: {
      status: "quoted", programCharges: { revision: 3, baseCents: 600, markupCents: 100, insuranceCents: 19, totalCents: 719,
        charges: { markup: { bps: 1000, fixedCents: 40, minCents: null, maxCents: null }, insurance: { bps: 271, fixedCents: 0, minCents: null, maxCents: null } } },
      baseRateCents: 600, currency: "USD", serviceLevelCode: "standard", rateBookId: 34, rateBookCode: "dropship-vendor", rateTableId: 5, resolvedZone: "2",
      ratedWeightGrams: 635, rateProvider: { name: "local_rate_table", version: "1" }, warnings: ["engine advisory"], routing: { source: "legacy_profile" },
      selectedRate: { rateRowId: 9001, serviceLevelId: 4, serviceLevelCode: "standard", displayName: "Standard Shipping", description: null, fulfillmentMode: "parcel",
        pricingBasis: "shipment_weight", totalCents: 719, currency: "USD", promiseMinBusinessDays: null, promiseMaxBusinessDays: null, ratedMeasure: 635,
        maxShipmentWeightGrams: 907, chargeModel: "base_plus_per_started_pound", perStartedPoundCents: 50, billablePounds: 2, rateTableId: 5, productPolicyApplied: true,
        calculationTrace: [{ kind: "base_charge", ruleId: 12, label: "Envelope base", amountCents: 500, skus: ["ARM-ENV-SGL-P50"] }, { kind: "adjustment", ruleId: null, label: "Rounding", amountCents: -1, skus: [] }] },
    },
  };
}

function legacyPricing(): DropshipShippingPricingResult {
  return {
    source: "legacy", decision: { source: "legacy", mode: "test", reasonCode: "TEST_STORE_NOT_ALLOWED" }, baseRateCents: 824, currency: "USD", rateTableId: 33,
    zone: { zoneRuleId: 5, zone: "1" }, rateProvider: { name: "cached_admin_rate_table", version: "1" },
    rateMatches: [{ packageSequence: 1, rateTableId: 33, carrier: "USPS", service: "Ground", currency: "USD", rateCents: 824 }],
  };
}

function makeResult(pricing: DropshipShippingPricingResult): DropshipShippingCalculationResult {
  return {
    cartonization: {
      packaging: { suiteId: 1, suiteRevision: 1, assignmentRevision: 1, boxes: [] },
      packages: [{ packageSequence: 1, items: [{ productVariantId: 66, quantity: 2 }], placements: [], productVariantId: 66, quantity: 2, boxId: 7, boxCode: "BOX-10x8x4",
        weightGrams: 635, lengthMm: 254, widthMm: 203, heightMm: 102, requestedCarrier: null, requestedService: null }],
      engine: { name: "basic", version: "1" }, warnings: ["carton advisory"], packagingWarnings: [],
    },
    pricing, currency: "USD", rateTableId: pricing.rateTableId,
    baseRateCents: pricing.source === "shared" ? 600 : 824, markupCents: 100, dunnageCents: 0, insurancePoolCents: 19,
    totalShippingCents: pricing.source === "shared" ? 719 : 943, quotePayload: {},
  };
}

describe("listing shipping estimate calculation detail", () => {
  it("projects the shared-engine evidence: weights, cartons, program, table, row, zone, charges, policy steps", () => {
    const result = makeResult(sharedPricing());
    const calculation = buildListingShippingEstimateCalculation({ result, originWarehouseId: 1, items, facts });
    expect(calculation).toEqual({
      pricingSource: "shared", cutoverMode: "live", cutoverReasonCode: "LIVE_ENABLED", originWarehouseId: 1,
      items: [{ productVariantId: 66, sku: "ARM-ENV-SGL-P50", quantity: 2, unitWeightGrams: 317.5, lineWeightGrams: 635 }],
      packages: [{ packageSequence: 1, boxCode: "BOX-10x8x4", weightGrams: 635, lengthMm: 254, widthMm: 203, heightMm: 102, items: [{ productVariantId: 66, quantity: 2 }] }],
      rate: { source: "shared_engine", rateBookId: 34, rateBookCode: "dropship-vendor", rateTableId: 5, rateRowId: 9001, serviceLevelCode: "standard",
        serviceLevelName: "Standard Shipping", zone: "2", ratedWeightGrams: 635, chargeModel: "base_plus_per_started_pound", rowMaxShipmentWeightGrams: 907,
        perStartedPoundCents: 50, billablePounds: 2, productPolicyApplied: true,
        policySteps: [{ kind: "base_charge", ruleId: 12, label: "Envelope base", amountCents: 500, skus: ["ARM-ENV-SGL-P50"] }, { kind: "adjustment", ruleId: null, label: "Rounding", amountCents: -1, skus: [] }] },
      charges: { baseCents: 600, markupCents: 100, insuranceCents: 19, dunnageCents: 0, totalCents: 719 },
      warnings: ["carton advisory", "engine advisory"],
    });
    expect(listingShippingEstimateCalculationSchema.safeParse(calculation).success).toBe(true);
  });
  it("projects the legacy rate-table evidence per package and reports an unknown row id as null on the shared path", () => {
    const legacy = buildListingShippingEstimateCalculation({ result: makeResult(legacyPricing()), originWarehouseId: 3, items, facts });
    expect(legacy.rate).toEqual({ source: "legacy_rate_table", zone: "1", zoneRuleId: 5, packages: [{ packageSequence: 1, rateTableId: 33, carrier: "USPS", service: "Ground", rateCents: 824 }] });
    expect(legacy).toMatchObject({ pricingSource: "legacy", cutoverMode: "test", cutoverReasonCode: "TEST_STORE_NOT_ALLOWED", charges: { totalCents: 943 }, warnings: ["carton advisory"] });
    const pricing = sharedPricing();
    delete (pricing as { quote: { selectedRate: { rateRowId?: number | null } } }).quote.selectedRate.rateRowId;
    expect(buildListingShippingEstimateCalculation({ result: makeResult(pricing), originWarehouseId: 1, items, facts }).rate).toMatchObject({ rateRowId: null });
  });
  it("reports missing catalog weight as null instead of inventing zero", () => {
    const calculation = buildListingShippingEstimateCalculation({ result: makeResult(sharedPricing()), originWarehouseId: 1, items, facts: new Map() });
    expect(calculation.items).toEqual([{ productVariantId: 66, sku: null, quantity: 2, unitWeightGrams: null, lineWeightGrams: null }]);
  });
  it("refuses to emit evidence that violates the contract and never mutates its inputs", () => {
    const result = makeResult(sharedPricing());
    const snapshot = structuredClone(result);
    expect(() => buildListingShippingEstimateCalculation({ result: { ...result, markupCents: -1 }, originWarehouseId: 1, items, facts }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SHIPPING_CALCULATION_INVALID" }));
    expect(() => buildListingShippingEstimateCalculation({ result, originWarehouseId: 0, items, facts })).toThrow();
    buildListingShippingEstimateCalculation({ result, originWarehouseId: 1, items, facts });
    expect(result).toEqual(snapshot);
  });
});
