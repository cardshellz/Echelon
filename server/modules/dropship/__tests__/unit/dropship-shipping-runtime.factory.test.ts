import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipShippingQuoteServiceDependencies } from "../../application/dropship-shipping-quote-service";
import type { DropshipListingShippingEstimateDependencies } from "../../application/dropship-listing-shipping-estimate-service";
import type { DropshipShippingPricingRequest } from "../../application/dropship-shipping-pricing-service";
import type { DropshipSharedShippingQuoteResult } from "../../application/dropship-shared-shipping-quote";

const runtime = vi.hoisted(() => ({
  order: vi.fn<(deps: DropshipShippingQuoteServiceDependencies) => void>(),
  estimate: vi.fn<(deps: DropshipListingShippingEstimateDependencies) => void>(),
  shared: vi.fn<(input: DropshipShippingPricingRequest) => Promise<DropshipSharedShippingQuoteResult>>(),
  legacy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the public constructor boundary, not private service properties. The
// real factories and rate-source selection still run; no database is reachable.
vi.mock("../../application/dropship-shipping-quote-service", async (original) => ({
  ...await original<typeof import("../../application/dropship-shipping-quote-service")>(),
  DropshipShippingQuoteService: class {
    constructor(deps: DropshipShippingQuoteServiceDependencies) { runtime.order(deps); }
  },
  makeDropshipShippingQuoteLogger: () => runtime.logger,
}));
vi.mock("../../application/dropship-listing-shipping-estimate-service", () => ({
  DropshipListingShippingEstimateService: class {
    constructor(deps: DropshipListingShippingEstimateDependencies) { runtime.estimate(deps); }
  },
}));
vi.mock("../../infrastructure/dropship-vendor-provisioning.factory", () => ({ createDropshipVendorProvisioningServiceFromEnv: () => ({}) }));
vi.mock("../../infrastructure/dropship-shipping-quote.repository", () => ({ PgDropshipShippingQuoteRepository: class {} }));
vi.mock("../../infrastructure/dropship-basic-cartonization.provider", () => ({ BasicDropshipCartonizationProvider: class {} }));
vi.mock("../../infrastructure/dropship-listing-preview.repository", () => ({ PgDropshipListingPreviewRepository: class {} }));
vi.mock("../../infrastructure/dropship-listing-shipping-estimate.repository", () => ({ PgListingShippingEstimateContextReader: class {} }));
vi.mock("../../infrastructure/dropship-cached-rate-table.provider", () => ({
  CachedRateTableDropshipShippingRateProvider: class { quoteRates = runtime.legacy; },
}));
vi.mock("../../infrastructure/shared-engine-dropship-shipping.provider", () => ({
  createSharedEngineDropshipShippingQuoteProviderFromEnv: () => ({ quote: runtime.shared }),
}));
vi.mock("../../../../shipping-engine/infrastructure/postgres-shipping-quote-evidence.writer", () => ({ PostgresShippingQuoteEvidenceWriter: class {} }));

import { createDropshipShippingQuoteServiceFromEnv } from "../../infrastructure/dropship-shipping-quote.factory";
import { createDropshipListingShippingEstimateServiceFromEnv } from "../../infrastructure/dropship-listing-shipping-estimate.factory";
import { cartonizeDropshipItems } from "../../domain/shipping-quote";

function request(quantity: number, storeConnectionId = 22): DropshipShippingPricingRequest {
  const items = [{ productVariantId: 66, quantity }];
  const { packages } = cartonizeDropshipItems({ items,
    packageProfiles: [{ productVariantId: 66, sku: "PACK50", weightGrams: 590, lengthMm: 152, widthMm: 127,
      heightMm: 51, shippingGroupCode: null, shipsInOwnContainer: false, maxUnitsPerPackage: null,
      defaultCarrier: null, defaultService: null, defaultBoxId: null }],
    boxes: [{ id: 1, code: "8X6X4", name: "8X6X4", lengthMm: 203, widthMm: 152, heightMm: 102,
      tareWeightGrams: 45, maxWeightGrams: null, isActive: true }],
  });
  return { vendorId: 10, storeConnectionId, warehouseId: 1, items, packages,
    destination: { country: "US", region: "PA", postalCode: "16046" },
    cartonizationProvider: { name: "fixture-cartonizer", version: "1" }, quotedAt: new Date("2026-09-08T12:00:00Z") };
}

function successfulRate(): Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }> {
  // Synthetic engine response: this test proves wiring, not rate-card contents.
  return { status: "quoted", baseRateCents: 1000, currency: "USD", serviceLevelCode: "standard",
    rateBookId: 34, rateBookCode: "fixture", rateTableId: 5, resolvedZone: "PA", ratedWeightGrams: 1225,
    rateProvider: { name: "fixture-engine", version: "1" }, warnings: [],
    routing: { source: "channel_policy", mode: "engine_quoted", rateBookId: 34 },
    selectedRate: { serviceLevelId: 1, serviceLevelCode: "standard", displayName: "Standard", description: null,
      fulfillmentMode: "parcel", pricingBasis: "shipment_weight", totalCents: 1000, currency: "USD",
      promiseMinBusinessDays: null, promiseMaxBusinessDays: null, ratedMeasure: 1225,
      maxShipmentWeightGrams: null, chargeModel: "fixed_band", perStartedPoundCents: null,
      billablePounds: null, rateTableId: 5, productPolicyApplied: false, calculationTrace: [] },
  };
}

function pricingProviders() {
  createDropshipShippingQuoteServiceFromEnv();
  createDropshipListingShippingEstimateServiceFromEnv();
  return [runtime.order.mock.calls.at(-1)![0].pricingProvider,
    runtime.estimate.mock.calls.at(-1)![0].calculation.pricingProvider];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE", undefined);
  vi.stubEnv("DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS", undefined);
  vi.stubEnv("DROPSHIP_SHARED_SHIPPING_SHADOW_MODE", "off");
  runtime.shared.mockResolvedValue(successfulRate());
  runtime.legacy.mockResolvedValue({ zone: { zone: "US", zoneRuleId: 1 },
    provider: { name: "legacy-fixture", version: "1" }, rates: [{ packageSequence: 1, rateTableId: 1,
      carrier: "USPS", service: "Ground Advantage", currency: "USD", rateCents: 800 }] });
});
afterEach(() => vi.unstubAllEnvs());

describe("shipping runtime factories", () => {
  it.each(["legacy", "test"])("honors an explicit %s override in both paths", async (mode) => {
    vi.stubEnv("DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE", mode);
    vi.stubEnv("DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS", "22");
    for (const provider of pricingProviders()) {
      await expect(provider.quote(request(1, 99))).resolves.toMatchObject({ source: "legacy" });
      await expect(provider.quote(request(1, 22))).resolves.toMatchObject({ source: mode === "test" ? "shared" : "legacy" });
    }
    expect(runtime.shared).toHaveBeenCalledTimes(mode === "test" ? 2 : 0);
    expect(runtime.legacy).toHaveBeenCalledTimes(mode === "test" ? 2 : 4);
  });

  it.each(["invalid", "test"])("blocks quotes on invalid %s configuration without falling back", async (mode) => {
    vi.stubEnv("DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE", mode);
    for (const provider of pricingProviders()) {
      await expect(provider.quote(request(2))).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_CUTOVER_CONFIG_INVALID" });
    }
    expect(runtime.logger.error).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_SHIPPING_CUTOVER_CONFIG_INVALID" }));
    expect(runtime.shared).not.toHaveBeenCalled();
    expect(runtime.legacy).not.toHaveBeenCalled();
  });

  it("does not substitute a legacy charge when the shared engine has no eligible rate", async () => {
    runtime.shared.mockResolvedValue({ status: "unavailable", code: "NO_RATE", message: "No eligible rate",
      warnings: [], routing: { source: "channel_policy", mode: "engine_quoted", rateBookId: 34 } });
    for (const provider of pricingProviders()) {
      await expect(provider.quote(request(2))).rejects.toMatchObject({ code: "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE" });
    }
    expect(runtime.shared).toHaveBeenCalledTimes(2);
    expect(runtime.legacy).not.toHaveBeenCalled();
  });

  it("does not substitute a legacy charge when the shared engine fails", async () => {
    runtime.shared.mockRejectedValue(new Error("Synthetic engine failure"));
    for (const provider of pricingProviders()) {
      await expect(provider.quote(request(2))).rejects.toMatchObject({ code: "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED" });
    }
    expect(runtime.shared).toHaveBeenCalledTimes(2);
    expect(runtime.legacy).not.toHaveBeenCalled();
  });

  it.each([[1, [635]], [2, [1225]], [5, [1225, 1225, 635]]] as const)(
    "uses the shared engine by default for both paths at quantity %i", async (quantity, weights) => {
      const input = request(quantity);
      expect(input.packages.map((carton) => carton.weightGrams)).toEqual(weights);
      for (const provider of pricingProviders()) {
        await expect(provider.quote(input)).resolves.toMatchObject({ source: "shared", baseRateCents: 1000 });
      }
      expect(runtime.shared).toHaveBeenCalledTimes(2);
      expect(runtime.shared.mock.calls).toEqual([[input], [input]]);
      expect(runtime.legacy).not.toHaveBeenCalled();
    },
  );
});
