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
import {
  buildWeightOnlyParcelPlan,
  weightOnlyParcelProvider,
} from "../../application/weight-only-parcel.provider";

describe("shipping channel profiles", () => {
  it("routes Shopify and internal websites through runtime quotes", () => {
    expect(usesRuntimeShippingQuotes("shopify")).toBe(true);
    expect(usesRuntimeShippingQuotes("internal")).toBe(true);
  });

  it("keeps eBay and dropship shipping in their channel-owned policy paths", () => {
    expect(getShippingChannelProfile("ebay")).toMatchObject({
      quoteMode: "external_policy",
      configurationOwner: "channel_adapter",
    });
    expect(getShippingChannelProfile("dropship")).toMatchObject({
      quoteMode: "managed_policy",
      configurationOwner: "dropship_portal",
    });
    expect(usesRuntimeShippingQuotes("ebay")).toBe(false);
    expect(usesRuntimeShippingQuotes("dropship")).toBe(false);
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

  it("fails closed when any line lacks a usable weight", () => {
    const result = buildWeightOnlyParcelPlan([
      { sku: "KNOWN", quantity: 1, unitWeightGrams: 100 },
      { sku: "MISSING", quantity: 2, unitWeightGrams: null },
    ]);

    expect(result).toEqual({
      ok: false,
      errors: ["MISSING: positive unit weight is required for weight-based rating"],
    });
  });
});

describe("quoteShipment", () => {
  function fakeRateProvider(onQuote?: (input: ShippingRateProviderRequest) => void): ShippingRateProvider {
    return {
      provider: { name: "fake-rates", version: "1" },
      async quote(input) {
        onQuote?.(input);
        return {
          zone: "US-48",
          quotes: [{
            carrier: "USPS",
            serviceCode: "ground",
            totalCents: 799,
            currency: "USD",
            perParcelCents: [799],
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
      originWarehouseId: 1,
      destination: { country: "US", postalCode: "16066" },
      parcels: [expect.objectContaining({ billableWeightGrams: 400 })],
    }));
  });

  it("does not call the rate provider when a shipment line has no weight", async () => {
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

    expect(result).toMatchObject({ ok: false, code: "INVALID_SHIPMENT" });
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(["ebay", "dropship"] as const)(
    "refuses runtime rating for the %s policy-managed channel",
    async (channel) => {
      const observe = vi.fn();
      const result = await quoteShipment({
        channel,
        originWarehouseId: 1,
        destination: { country: "US", postalCode: "16066" },
        lines: [{ sku: "SKU-1", quantity: 1, unitWeightGrams: 100 }],
      }, {
        parcelProvider: weightOnlyParcelProvider,
        rateProvider: fakeRateProvider(observe),
      });

      expect(result).toMatchObject({ ok: false, code: "CHANNEL_POLICY_MANAGED" });
      expect(observe).not.toHaveBeenCalled();
    },
  );
});
