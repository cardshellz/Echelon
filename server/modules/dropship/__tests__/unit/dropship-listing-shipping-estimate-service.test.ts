import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY, listingShippingEstimateInputSchema,
  LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE,
  LISTING_SHIPPING_ESTIMATE_WARNING } from "../../../../../shared/dropship/listing-shipping-estimate";
import {
  DropshipListingShippingEstimateService,
  type DropshipListingShippingEstimateDependencies,
  type ListingShippingEstimateContext,
} from "../../application/dropship-listing-shipping-estimate-service";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import type { DropshipShippingPricingResult } from "../../application/dropship-shipping-pricing-service";
import { DropshipError } from "../../domain/errors";

const at = new Date("2026-09-06T12:00:00.000Z");
const input = { storeConnectionId: 22, productVariantId: 101, quantity: 2, destination: { country: "us", region: "pa", postalCode: "17046" } };

function makeContext(): ListingShippingEstimateContext {
  return { vendorId: 10, storeConnectionId: 22, vendorStatus: "onboarding", entitlementStatus: "active", storeStatus: "connected", defaultWarehouseId: 3, warehouseConfigError: null };
}

function makeCandidate(): DropshipListingCatalogCandidate {
  return {
    productId: 501, productVariantId: 101, productLineIds: [9], category: "Protectors",
    productIsActive: true, variantIsActive: true, unitsPerVariant: 100, defaultRetailPriceCents: 1199,
    sku: "PACK", productName: "Sleeves", variantName: "100 pack", title: "Sleeves", description: null,
    brand: null, gtin: null, mpn: null, condition: "new", itemSpecifics: null, imageUrls: [], weightGrams: 100,
    ebayBrowseCategoryId: null, ebayBrowseCategoryName: null,
  };
}

function makePricing(): DropshipShippingPricingResult {
  return {
    source: "legacy", decision: { source: "legacy", mode: "legacy", reasonCode: "LEGACY_MODE" },
    baseRateCents: 999, currency: "USD", rateTableId: 33,
    zone: { zoneRuleId: 5, zone: "1" }, rateProvider: { name: "cached_admin_rate_table", version: "1" },
    rateMatches: [{ packageSequence: 1, rateTableId: 33, carrier: "USPS", service: "Ground", currency: "USD", rateCents: 999 }],
  };
}

function makeDependencies() {
  return {
    contexts: { loadForMember: vi.fn(async (): Promise<ListingShippingEstimateContext | null> => makeContext()) },
    catalog: {
      listCatalogCandidates: vi.fn(async () => [makeCandidate()]),
      listCatalogExposureRules: vi.fn<DropshipListingShippingEstimateDependencies["catalog"]["listCatalogExposureRules"]>(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
      listSelectionRules: vi.fn<DropshipListingShippingEstimateDependencies["catalog"]["listSelectionRules"]>(async () => [{ id: 2, vendorId: 10, scopeType: "catalog", action: "include" }]),
      listVariantOverrides: vi.fn<DropshipListingShippingEstimateDependencies["catalog"]["listVariantOverrides"]>(async () => []),
    },
    calculation: {
      cartonization: { cartonize: vi.fn<DropshipListingShippingEstimateDependencies["calculation"]["cartonization"]["cartonize"]>(async (request) => ({
        packages: [{ packageSequence: 1, items: request.items, placements: [], productVariantId: 101, quantity: request.items[0].quantity, boxId: null, boxCode: null, weightGrams: 200, lengthMm: null, widthMm: null, heightMm: null, requestedCarrier: null, requestedService: null }],
        engine: { name: "test", version: "1" }, warnings: [], packagingWarnings: [],
      })) },
      pricingProvider: { quote: vi.fn(async (): Promise<DropshipShippingPricingResult> => makePricing()) },
      repository: {
        getActiveShippingMarkupPolicy: vi.fn<DropshipListingShippingEstimateDependencies["calculation"]["repository"]["getActiveShippingMarkupPolicy"]>(async () => ({ id: 7, source: "config", markupBps: 1000, fixedMarkupCents: 50, minMarkupCents: null, maxMarkupCents: null })),
        getActiveInsurancePoolPolicy: vi.fn<DropshipListingShippingEstimateDependencies["calculation"]["repository"]["getActiveInsurancePoolPolicy"]>(async () => ({ id: 8, source: "config", feeBps: 200, minFeeCents: null, maxFeeCents: null })),
      },
    },
    clock: { now: () => at },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies DropshipListingShippingEstimateDependencies;
}

describe("read-only listing shipping estimate", () => {
  let deps: ReturnType<typeof makeDependencies>;
  let service: DropshipListingShippingEstimateService;
  beforeEach(() => { deps = makeDependencies(); service = new DropshipListingShippingEstimateService(deps); });

  it("estimates onboarding/unfunded stores using all fees, configured origin and pack quantity", async () => {
    const original = structuredClone(input);
    const result = await service.estimateForMember("member-1", input);
    expect(result).toEqual({ status: "estimated", storeConnectionId: 22, productVariantId: 101,
      totalShippingCents: 1170, currency: "USD", estimatedAt: at.toISOString(), quantity: 2, warnings: [],
      destination: { country: "US", region: "PA", postalCode: "17046" },
    });
    expect(deps.contexts.loadForMember).toHaveBeenCalledWith("member-1", 22);
    expect(deps.calculation.cartonization.cartonize).toHaveBeenCalledWith(expect.objectContaining({ warehouseId: 3, items: [{ productVariantId: 101, quantity: 2 }], quotedAt: at }));
    expect(input).toEqual(original);
    // No write methods, provisioning, ATP/reservation, wallets or marketplace APIs exist in the service contract.
    expect(Object.keys(deps.calculation.repository).sort()).toEqual(["getActiveInsurancePoolPolicy", "getActiveShippingMarkupPolicy"]);
    expect(await service.estimateForMember("member-1", input)).toEqual(result);
  });

  it.each(["suspended", "closed", "lapsed"])("rejects vendor status %s before reading product data", async (vendorStatus) => {
    deps.contexts.loadForMember.mockResolvedValue({ ...makeContext(), vendorStatus });
    await expect(service.estimateForMember("member-1", input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED" });
    expect(deps.catalog.listCatalogCandidates).not.toHaveBeenCalled();
  });
  it.each([
    [{ entitlementStatus: "lapsed" }, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED"],
    [{ storeStatus: "needs_reauth" }, "DROPSHIP_LISTING_STORE_BLOCKED"],
    [{ storeConnectionId: 999 }, "DROPSHIP_STORE_CONNECTION_REQUIRED"],
  ])("rejects non-estimable context %j", async (override, code) => {
    deps.contexts.loadForMember.mockResolvedValue({ ...makeContext(), ...override });
    await expect(service.estimateForMember("member-1", input)).rejects.toMatchObject({ code });
    expect(deps.calculation.cartonization.cartonize).not.toHaveBeenCalled();
  });
  it("does not provision a missing vendor or expose another store", async () => {
    deps.contexts.loadForMember.mockResolvedValue(null);
    await expect(service.estimateForMember("other-member", input)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(deps.catalog.listCatalogCandidates).not.toHaveBeenCalled();
    expect(deps.calculation.pricingProvider.quote).not.toHaveBeenCalled();
  });
  it("rejects an unauthenticated member", async () => {
    await expect(service.estimateForMember("", input)).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(deps.contexts.loadForMember).not.toHaveBeenCalled();
  });
  it.each(["missing", "inactive", "unexposed", "unselected", "excluded", "disabled"])("rejects %s product before calculating", async (scenario) => {
    if (scenario === "missing") deps.catalog.listCatalogCandidates.mockResolvedValue([]);
    if (scenario === "inactive") deps.catalog.listCatalogCandidates.mockResolvedValue([{ ...makeCandidate(), variantIsActive: false }]);
    if (scenario === "unexposed") deps.catalog.listCatalogExposureRules.mockResolvedValue([]);
    if (scenario === "unselected") deps.catalog.listSelectionRules.mockResolvedValue([]);
    if (scenario === "excluded") deps.catalog.listSelectionRules.mockResolvedValue([{ id: 2, scopeType: "catalog", action: "include" }, { id: 3, scopeType: "variant", action: "exclude", productVariantId: 101 }]);
    if (scenario === "disabled") deps.catalog.listVariantOverrides.mockResolvedValue([{ productVariantId: 101, enabledOverride: false }]);
    await expect(service.estimateForMember("member-1", input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SHIPPING_VARIANT_NOT_SELECTED" });
    expect(deps.calculation.pricingProvider.quote).not.toHaveBeenCalled();
  });
  it("returns explicit unavailable when origin is missing", async () => {
    deps.contexts.loadForMember.mockResolvedValue({ ...makeContext(), defaultWarehouseId: null });
    await expect(service.estimateForMember("member-1", input)).resolves.toMatchObject({ status: "unavailable", code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ reasonCode: "DROPSHIP_LISTING_SHIPPING_ORIGIN_REQUIRED" }) }));
    expect(deps.calculation.cartonization.cartonize).not.toHaveBeenCalled();
  });
  it.each(["DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED", "DROPSHIP_SHIPPING_ZONE_REQUIRED", "DROPSHIP_SHIPPING_RATE_REQUIRED", "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE"])("returns explicit unavailable for %s", async (code) => {
    deps.calculation.pricingProvider.quote.mockRejectedValue(new DropshipError(code, "Private rate table configuration.", { weightGrams: 1225, packageSequence: 1 }));
    const result = await service.estimateForMember("member-1", input);
    expect(result).toMatchObject({ status: "unavailable", code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE });
    expect(result).not.toHaveProperty("totalShippingCents");
    expect(deps.logger.warn).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      reasonCode: code, quantity: 2, diagnostic: { weightGrams: 1225, packageSequence: 1 },
      destination: { country: "US", region: "PA", postalCode: "17046" },
    }) }));
    expect(JSON.stringify(result)).not.toContain("Private rate table");
    expect(result).not.toHaveProperty("diagnostic");
  });
  it.each(["getActiveShippingMarkupPolicy", "getActiveInsurancePoolPolicy"] as const)("fails closed without %s", async (method) => {
    deps.calculation.repository[method].mockResolvedValue(null);
    expect(await service.estimateForMember("member-1", input)).toMatchObject({ status: "unavailable" });
  });
  it("propagates unexpected errors instead of disguising them as missing data", async () => {
    deps.calculation.pricingProvider.quote.mockRejectedValue(new Error("database offline"));
    await expect(service.estimateForMember("member-1", input)).rejects.toThrow("database offline");
  });
  it("validates monetary output rather than returning non-integer totals", async () => {
    deps.calculation.pricingProvider.quote.mockResolvedValue({ ...makePricing(), baseRateCents: 1.5 });
    await expect(service.estimateForMember("member-1", input)).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_INVALID_MONEY_INPUT" });
  });
  it("preserves legitimate zero shipping instead of marking it unavailable", async () => {
    deps.calculation.pricingProvider.quote.mockResolvedValue({ ...makePricing(), baseRateCents: 0 });
    deps.calculation.repository.getActiveShippingMarkupPolicy.mockResolvedValue({ id: 7, source: "config", markupBps: 0, fixedMarkupCents: 0, minMarkupCents: null, maxMarkupCents: null });
    expect(await service.estimateForMember("member-1", input)).toMatchObject({ status: "estimated", totalShippingCents: 0 });
  });
  it("rejects unsafe money instead of rounding it", async () => {
    deps.calculation.pricingProvider.quote.mockResolvedValue({ ...makePricing(), baseRateCents: Number.MAX_SAFE_INTEGER + 1 });
    await expect(service.estimateForMember("member-1", input)).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_INVALID_MONEY_INPUT" });
  });
  it("uses the shared engine charge without exposing its rate identity or provider diagnostics", async () => {
    deps.calculation.pricingProvider.quote.mockResolvedValue({
      source: "shared", decision: { source: "shared", mode: "live", reasonCode: "LIVE_ENABLED" }, baseRateCents: 800, currency: "USD", rateTableId: 44,
      quote: { status: "quoted", baseRateCents: 800, currency: "USD", serviceLevelCode: "standard", rateBookId: 12, rateBookCode: "dropship", rateTableId: 44, resolvedZone: "1", ratedWeightGrams: 200, rateProvider: { name: "local_rate_table", version: "1" }, warnings: ["Shipping region inferred from postal code."], routing: {},
        selectedRate: { serviceLevelId: 4, serviceLevelCode: "standard", displayName: "Standard Shipping", description: null, fulfillmentMode: "parcel", pricingBasis: "shipment_weight", totalCents: 800, currency: "USD", promiseMinBusinessDays: null, promiseMaxBusinessDays: null, ratedMeasure: 200, maxShipmentWeightGrams: null, chargeModel: "fixed_band", perStartedPoundCents: null, billablePounds: null, rateTableId: 44, productPolicyApplied: false, calculationTrace: [] },
      },
    });
    const result = await service.estimateForMember("member-1", input);
    expect(result).toEqual({ storeConnectionId: 22, productVariantId: 101, quantity: 2, destination: { country: "US", region: "PA", postalCode: "17046" },
      estimatedAt: at.toISOString(), status: "estimated", totalShippingCents: 948, currency: "USD", warnings: [LISTING_SHIPPING_ESTIMATE_WARNING] });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      code: "DROPSHIP_LISTING_SHIPPING_ESTIMATE_WARNINGS",
      context: expect.objectContaining({ rateWarnings: ["Shipping region inferred from postal code."] }),
    }));
  });
  it("replaces internal packaging warnings with a customer-safe advisory", async () => {
    const cartonization = await deps.calculation.cartonization.cartonize({ vendorId: 10, storeConnectionId: 22, warehouseId: 3, items: [{ productVariantId: 101, quantity: 2 }], destination: { country: "US", region: "PA", postalCode: "17046" }, quotedAt: at });
    deps.calculation.cartonization.cartonize.mockResolvedValue({ ...cartonization, warnings: ["Dimensions missing; estimated from weight."] });
    expect(await service.estimateForMember("member-1", input)).toMatchObject({ status: "estimated", warnings: [LISTING_SHIPPING_ESTIMATE_WARNING] });
  });
  it("accepts the resource cap without converting packs to eaches", async () => {
    expect(await service.estimateForMember("member-1", { ...input, quantity: MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY })).toMatchObject({ status: "estimated", quantity: MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY });
  });
  it.each([0, -1, 1.5, MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY + 1, Number.MAX_SAFE_INTEGER])("rejects invalid quantity %i", async (quantity) => {
    await expect(service.estimateForMember("member-1", { ...input, quantity })).rejects.toHaveProperty("issues");
    expect(deps.contexts.loadForMember).not.toHaveBeenCalled();
  });
  it.each([
    { warehouseId: 999 }, { vendorId: 999 }, { idempotencyKey: "not-an-order" }, { items: [] },
    { destination: { country: "USA", postalCode: "17046" } },
    { destination: { country: "US", postalCode: " " } },
  ])("rejects invalid or authority-bearing input %j", (override) => {
    expect(listingShippingEstimateInputSchema.safeParse({ ...input, ...override }).success).toBe(false);
  });
});
