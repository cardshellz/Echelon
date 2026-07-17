import { describe, expect, it, vi } from "vitest";
import {
  getShippingChannelProfile,
  usesRuntimeShippingQuotes,
} from "../../domain/shipping-channel";
import { quoteShipment } from "../../application/shipment-quote.service";
import type {
  ShippingRateProvider,
  ShippingRateProviderRequest,
} from "../../application/shipping-rate-provider";
import { resolveShipmentLineWeights } from "../../application/shipment-weight.service";
import {
  buildWeightOnlyParcelPlan,
  weightOnlyParcelProvider,
} from "../../application/weight-only-parcel.provider";

describe("shipping channel profiles", () => {
  it("routes Shopify, internal websites, and dropship charges through runtime quotes", () => {
    expect(usesRuntimeShippingQuotes("shopify")).toBe(true);
    expect(usesRuntimeShippingQuotes("internal")).toBe(true);
    expect(usesRuntimeShippingQuotes("dropship")).toBe(true);
  });

  it("keeps eBay checkout external while dropship rates vendor fulfillment", () => {
    expect(getShippingChannelProfile("ebay")).toMatchObject({
      quoteMode: "external_policy",
      configurationOwner: "channel_adapter",
    });
    expect(getShippingChannelProfile("dropship")).toMatchObject({
      quoteMode: "runtime_quote",
      configurationOwner: "dropship_portal",
      ratePurpose: "vendor_fulfillment_charge",
    });
    expect(usesRuntimeShippingQuotes("ebay")).toBe(false);
  });
});

describe("resolveShipmentLineWeights", () => {
  it("prefers canonical Echelon catalog weight over Shopify weight", () => {
    expect(resolveShipmentLineWeights([
      { sku: "SKU-1", quantity: 2, channelWeightGrams: 90 },
    ], new Map([["SKU-1", 125]]))).toEqual([{
      sku: "SKU-1",
      quantity: 2,
      unitWeightGrams: 125,
      weightSource: "echelon_catalog",
    }]);
  });

  it("uses channel weight only while the Echelon weight is missing", () => {
    expect(resolveShipmentLineWeights([
      { sku: "SKU-1", quantity: 1, channelWeightGrams: 90 },
    ], new Map())).toEqual([{
      sku: "SKU-1",
      quantity: 1,
      unitWeightGrams: 90,
      weightSource: "channel_fallback",
    }]);
  });

  it("marks the line missing when neither source has weight", () => {
    expect(resolveShipmentLineWeights([
      { sku: null, quantity: 1, channelWeightGrams: null },
    ], new Map())).toEqual([{
      sku: null,
      quantity: 1,
      unitWeightGrams: null,
      weightSource: "missing",
    }]);
  });
});

describe("weight-only parcel provider", () => {
  it("builds one shipment from every line's extended weight", () => {
    const result = buildWeightOnlyParcelPlan([
      { sku: "A", quantity: 2, unitWeightGrams: 125.2 },
      { sku: null, quantity: 3, unitWeightGrams: 50 },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe("single_weight_based_shipment");
    expect(result.plan.parcels).toEqual([{
      sequence: 1,
      source: "channel_weight",
      actualWeightGrams: 401,
      billableWeightGrams: 401,
      dimensions: null,
      shippingGroupCode: null,
    }]);
  });

  it("rates known weight and warns when another line lacks weight", () => {
    const result = buildWeightOnlyParcelPlan([
      { sku: "KNOWN", quantity: 1, unitWeightGrams: 100 },
      { sku: "MISSING", quantity: 2, unitWeightGrams: null },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parcels[0].billableWeightGrams).toBe(100);
    expect(result.plan.warnings).toEqual([
      "MISSING: missing weight excluded from rated shipment weight",
    ]);
  });

  it("uses the minimum rate-band weight when every line lacks weight", () => {
    const result = buildWeightOnlyParcelPlan([
      { sku: "MISSING", quantity: 2, unitWeightGrams: null },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parcels[0].billableWeightGrams).toBe(1);
    expect(result.plan.warnings).toEqual([
      "MISSING: missing weight excluded from rated shipment weight",
      "no usable item weights; applied 1g minimum rating weight",
    ]);
  });

  it("records use of a transitional channel-weight fallback", () => {
    const result = buildWeightOnlyParcelPlan([{
      sku: "SHOPIFY-FALLBACK",
      quantity: 1,
      unitWeightGrams: 75,
      weightSource: "channel_fallback",
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.warnings).toEqual([
      "SHOPIFY-FALLBACK: used channel weight because Echelon catalog weight is missing",
    ]);
  });
});

describe("quoteShipment", () => {
  function fakeRateProvider(onQuote?: (input: ShippingRateProviderRequest) => void): ShippingRateProvider {
    return {
      provider: { name: "fake-rates", version: "1" },
      async quote(input) {
        onQuote?.(input);
        return {
          rateBook: { id: 1, code: "test-book" },
          zone: "US-48",
          quotes: [{
            serviceLevelId: 1,
            serviceLevelCode: "standard",
            displayName: "Standard Shipping",
            description: null,
            fulfillmentMode: "parcel",
            pricingBasis: "shipment_weight",
            totalCents: 799,
            currency: "USD",
            promiseMinBusinessDays: 3,
            promiseMaxBusinessDays: 7,
            ratedMeasure: 400,
            maxShipmentWeightGrams: null,
          }],
          warnings: [],
        };
      },
    };
  }

  it("passes a complete weight-based parcel to an injected rate provider", async () => {
    const observe = vi.fn();
    const result = await quoteShipment({
      channel: "shopify",
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      lines: [{ sku: "SKU-1", quantity: 2, unitWeightGrams: 200 }],
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: fakeRateProvider(observe),
    });

    expect(result.ok).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      rateContext: {
        pricingChannel: "shopify",
        purpose: "customer_checkout",
      },
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      parcels: [expect.objectContaining({ billableWeightGrams: 400 })],
    }));
  });

  it("still calls the rate provider when a shipment line has no weight", async () => {
    const observe = vi.fn();
    const result = await quoteShipment({
      channel: "shopify",
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      lines: [{ sku: "SKU-1", quantity: 1, unitWeightGrams: null }],
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: fakeRateProvider(observe),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parcelPlan.warnings).toContain(
      "SKU-1: missing weight excluded from rated shipment weight",
    );
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      parcels: [expect.objectContaining({ billableWeightGrams: 1 })],
    }));
  });

  it("selects the dropship vendor-fulfillment rate context", async () => {
    const observe = vi.fn();
    const result = await quoteShipment({
      channel: "dropship",
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      lines: [{ sku: "SKU-1", quantity: 1, unitWeightGrams: 100 }],
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: fakeRateProvider(observe),
    });

    expect(result.ok).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      rateContext: {
        pricingChannel: "dropship",
        purpose: "vendor_fulfillment_charge",
      },
    }));
  });

  it("forwards pallet freight context without coupling it to a carrier", async () => {
    const observe = vi.fn();
    const result = await quoteShipment({
      channel: "internal",
      originWarehouseId: 1,
      destination: { country: "US", region: "PA", postalCode: "16066" },
      lines: [{ sku: "CASE-1", quantity: 20, unitWeightGrams: 5000 }],
      freight: {
        palletCount: 2,
        totalWeightGrams: 100_000,
        freightClass: "70",
        accessorials: ["liftgate"],
      },
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: fakeRateProvider(observe),
    });

    expect(result.ok).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      freight: {
        palletCount: 2,
        totalWeightGrams: 100_000,
        freightClass: "70",
        accessorials: ["liftgate"],
      },
    }));
  });

  it("refuses runtime rating for eBay's external checkout policy", async () => {
    const observe = vi.fn();
    const result = await quoteShipment({
      channel: "ebay",
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      lines: [{ sku: "SKU-1", quantity: 1, unitWeightGrams: 100 }],
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: fakeRateProvider(observe),
    });

    expect(result).toMatchObject({ ok: false, code: "CHANNEL_POLICY_MANAGED" });
    expect(observe).not.toHaveBeenCalled();
  });
});
