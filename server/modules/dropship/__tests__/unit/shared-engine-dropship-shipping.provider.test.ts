import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeChannelShippingResolution,
} from "../../../shipping-engine/application/channel-shipping-policy-runtime.service";
import type {
  ShipmentQuoteRequest,
  ShipmentQuoteResult,
} from "../../../shipping-engine/application/shipment-quote.service";
import type {
  ShipmentParcelProvider,
} from "../../../shipping-engine/application/shipment-parcel-provider";
import type {
  ShippingRateProvider,
} from "../../../shipping-engine/application/shipping-rate-provider";
import type {
  CatalogShippingFactByVariant,
} from "../../../shipping-engine/infrastructure/catalog-weight.repository";
import type {
  DropshipShippingShadowQuoteRequest,
} from "../../application/dropship-shipping-shadow-comparison";
import {
  SharedEngineDropshipShippingQuoteProvider,
} from "../../infrastructure/shared-engine-dropship-shipping.provider";

describe("SharedEngineDropshipShippingQuoteProvider", () => {
  it("forwards the exact warehouse, destination, carton weights, and canonical lines", async () => {
    let capturedRequest: ShipmentQuoteRequest | null = null;
    let capturedParcels: unknown = null;
    const provider = makeProvider({
      quoteShipment: async (request, dependencies) => {
        capturedRequest = request;
        const parcelResult = await dependencies.parcelProvider.plan(
          request.lines,
        );
        expect(parcelResult.ok).toBe(true);
        if (!parcelResult.ok) throw new Error("expected parcel plan");
        capturedParcels = parcelResult.plan.parcels;
        return quotedResult(parcelResult.plan);
      },
    });

    const result = await provider.quote(request());

    expect(capturedRequest).toMatchObject({
      channel: "dropship",
      originWarehouseId: 3,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "16066",
      },
      lines: [{
        sku: "SKU-101",
        productVariantId: 101,
        quantity: 1,
        unitWeightGrams: 100,
        weightSource: "echelon_catalog",
        shippingGroupCode: "protection",
      }],
      quotedAt: new Date("2026-07-26T11:00:00.000Z"),
    });
    expect(capturedParcels).toEqual([{
      sequence: 1,
      source: "cartonization",
      actualWeightGrams: 454,
      billableWeightGrams: 454,
      dimensions: {
        lengthMm: 200,
        widthMm: 150,
        heightMm: 40,
      },
      shippingGroupCode: "protection",
    }]);
    expect(result).toMatchObject({
      status: "quoted",
      baseRateCents: 799,
      rateBookCode: "dropship-vendor-default",
      rateTableId: 44,
      ratedWeightGrams: 454,
    });
  });

  it("passes an exact canonical-policy rate book to the shared engine", async () => {
    let capturedRateBookId: number | undefined;
    const provider = makeProvider({
      routing: canonicalRouting(123),
      quoteShipment: async (request, dependencies) => {
        capturedRateBookId = request.rateBookId;
        const parcelResult = await dependencies.parcelProvider.plan(
          request.lines,
        );
        if (!parcelResult.ok) throw new Error("expected parcel plan");
        return quotedResult(parcelResult.plan);
      },
    });

    await provider.quote(request());

    expect(capturedRateBookId).toBe(123);
  });

  it("records no-coverage when Standard Shipping is unavailable", async () => {
    const provider = makeProvider({
      quoteShipment: async (request, dependencies) => {
        const parcelResult = await dependencies.parcelProvider.plan(
          request.lines,
        );
        if (!parcelResult.ok) throw new Error("expected parcel plan");
        return {
          ok: true,
          parcelPlan: parcelResult.plan,
          rates: {
            rateBook: { id: 12, code: "dropship-vendor-default" },
            zone: "PA",
            quotes: [],
            warnings: ["no active service-level rate covers US PA 16066"],
          },
        };
      },
    });

    const result = await provider.quote(request());

    expect(result).toMatchObject({
      status: "unavailable",
      code: "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE",
      warnings: ["no active service-level rate covers US PA 16066"],
    });
  });

  it("does not invoke rating when the canonical route is disabled", async () => {
    const quoteShipment = vi.fn();
    const provider = makeProvider({
      routing: canonicalRouting(null, "disabled"),
      quoteShipment,
    });

    const result = await provider.quote(request());

    expect(quoteShipment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "unavailable",
      code: "DROPSHIP_SHARED_SHIPPING_ROUTE_NOT_ENGINE_QUOTED",
    });
  });

  it("preserves exact carton weight while warning on missing catalog line facts", async () => {
    const provider = makeProvider({
      facts: new Map(),
      quoteShipment: async (request, dependencies) => {
        const parcelResult = await dependencies.parcelProvider.plan(
          request.lines,
        );
        if (!parcelResult.ok) throw new Error("expected parcel plan");
        expect(parcelResult.plan.parcels[0].billableWeightGrams).toBe(454);
        expect(request.lines[0]).toMatchObject({
          productVariantId: 101,
          unitWeightGrams: null,
          weightSource: "missing",
        });
        return quotedResult(parcelResult.plan);
      },
    });

    const result = await provider.quote(request());

    expect(result).toMatchObject({
      status: "quoted",
      warnings: [
        "variant 101: canonical catalog shipping facts are missing",
      ],
    });
  });
});

function makeProvider(overrides: {
  routing?: RuntimeChannelShippingResolution;
  facts?: Map<number, CatalogShippingFactByVariant>;
  quoteShipment?: (
    request: ShipmentQuoteRequest,
    dependencies: {
      parcelProvider: ShipmentParcelProvider;
      rateProvider: ShippingRateProvider;
    },
  ) => Promise<ShipmentQuoteResult>;
} = {}) {
  const unusedRateProvider: ShippingRateProvider = {
    provider: { name: "unused", version: "test" },
    async quote() {
      throw new Error("fake quoteShipment should not call the rate provider");
    },
  };
  return new SharedEngineDropshipShippingQuoteProvider({
    loadCatalogFacts: async () => overrides.facts ?? new Map([[
      101,
      {
        productVariantId: 101,
        sku: "SKU-101",
        weightGrams: 100,
        shippingGroupCode: "protection",
        shipsInOwnContainer: false,
      },
    ]]),
    resolveChannelShipping: async () =>
      overrides.routing ?? legacyRouting(),
    quoteShipment: overrides.quoteShipment ?? (async (
      request,
      dependencies,
    ) => {
      const parcelResult = await dependencies.parcelProvider.plan(
        request.lines,
      );
      if (!parcelResult.ok) throw new Error("expected parcel plan");
      return quotedResult(parcelResult.plan);
    }),
    rateProvider: unusedRateProvider,
  });
}

function legacyRouting(): Extract<
  RuntimeChannelShippingResolution,
  { ok: true }
> {
  return {
    ok: true,
    channel: null,
    decision: {
      ok: true,
      source: "legacy_profile",
      policyId: null,
      policyVersion: null,
      routeId: null,
      mode: "engine_quoted",
      eligibilityMode: "engine",
      rateBookId: null,
      legacyRateContext: {
        pricingChannel: "dropship",
        purpose: "vendor_fulfillment_charge",
      },
    },
  };
}

function canonicalRouting(
  rateBookId: number | null,
  mode: "engine_quoted" | "channel_managed" | "disabled" = "engine_quoted",
): Extract<RuntimeChannelShippingResolution, { ok: true }> {
  return {
    ok: true,
    channel: {
      id: 103,
      provider: "manual",
      status: "active",
      isDefault: 0,
    },
    decision: {
      ok: true,
      source: "channel_policy",
      policyId: 8,
      policyVersion: 2,
      routeId: 9,
      mode,
      eligibilityMode: mode === "disabled" ? "none" : "engine",
      rateBookId,
      legacyRateContext: null,
    },
  };
}

function quotedResult(
  parcelPlan: Awaited<
    ReturnType<ShipmentParcelProvider["plan"]>
  > extends { ok: true; plan: infer Plan } ? Plan : never,
): ShipmentQuoteResult {
  return {
    ok: true,
    parcelPlan,
    rates: {
      rateBook: { id: 12, code: "dropship-vendor-default" },
      zone: "PA",
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
        ratedMeasure: 454,
        maxShipmentWeightGrams: null,
        chargeModel: "fixed_band",
        perStartedPoundCents: null,
        billablePounds: null,
        rateTableId: 44,
        productPolicyApplied: false,
        calculationTrace: [],
      }],
      warnings: [],
    },
  };
}

function request(): DropshipShippingShadowQuoteRequest {
  return {
    legacyQuoteSnapshotId: 77,
    vendorId: 10,
    storeConnectionId: 22,
    warehouseId: 3,
    destination: {
      country: "US",
      region: "PA",
      postalCode: "16066",
    },
    items: [{ productVariantId: 101, quantity: 1 }],
    packages: [{
      packageSequence: 1,
      items: [{ productVariantId: 101, quantity: 1 }],
      boxId: 4,
      boxCode: "SMALL",
      weightGrams: 454,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 40,
    }],
    cartonizationProvider: {
      name: "cardshellz-cartonize",
      version: "3.1.0",
    },
    quotedAt: new Date("2026-07-26T11:00:00.000Z"),
  };
}
