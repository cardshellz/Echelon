import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteRequest,
  DropshipSharedShippingQuoteResult,
} from "../../application/dropship-shared-shipping-quote";
import {
  CutoverDropshipShippingPricingProvider,
  type DropshipShippingPricingRequest,
} from "../../application/dropship-shipping-pricing-service";
import type {
  DropshipShippingRateProvider,
  DropshipShippingRateRequest,
  DropshipShippingRateResult,
} from "../../application/dropship-shipping-rate-provider";

describe("CutoverDropshipShippingPricingProvider", () => {
  it("preserves legacy package rates outside the cutover allowlist", async () => {
    const harness = createHarness({
      mode: "test",
      storeConnectionIds: new Set([99]),
    });

    const result = await harness.provider.quote(request());

    expect(result).toMatchObject({
      source: "legacy",
      decision: {
        mode: "test",
        reasonCode: "TEST_STORE_NOT_ALLOWED",
      },
      baseRateCents: 1000,
      currency: "USD",
      rateTableId: 33,
      zone: { zone: "zone-1", zoneRuleId: 5 },
      rateMatches: [{
        packageSequence: 1,
        rateCents: 1000,
      }],
    });
    expect(harness.legacy.requests).toHaveLength(1);
    expect(harness.shared.requests).toHaveLength(0);
  });

  it("uses the shipment-level shared quote for an allowed test store", async () => {
    const harness = createHarness({
      mode: "test",
      storeConnectionIds: new Set([22]),
    });

    const result = await harness.provider.quote(request());

    expect(result).toMatchObject({
      source: "shared",
      decision: {
        mode: "test",
        reasonCode: "TEST_STORE_ALLOWED",
      },
      baseRateCents: 800,
      currency: "USD",
      rateTableId: 44,
      quote: {
        selectedRate: {
          serviceLevelCode: "standard",
          totalCents: 800,
        },
      },
    });
    expect(harness.legacy.requests).toHaveLength(0);
    expect(harness.shared.requests).toHaveLength(1);
  });

  it("fails closed without a legacy fallback when shared coverage is unavailable", async () => {
    const harness = createHarness({
      mode: "live",
      storeConnectionIds: new Set(),
    }, {
      status: "unavailable",
      code: "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE",
      message: "No Standard rate.",
      warnings: ["no active rate covers the destination"],
      routing: { source: "channel_policy" },
    });

    await expect(harness.provider.quote(request())).rejects.toMatchObject({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE",
      context: {
        storeConnectionId: 22,
        sharedCode: "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE",
      },
    });
    expect(harness.legacy.requests).toHaveLength(0);
    expect(harness.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE",
    }));
  });

  it("classifies provider failures without exposing the internal error", async () => {
    const harness = createHarness({
      mode: "live",
      storeConnectionIds: new Set(),
    }, new Error("database password appeared in provider error"));

    await expect(harness.provider.quote(request())).rejects.toMatchObject({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED",
      message: "Shared shipping rate could not be calculated.",
      context: {
        storeConnectionId: 22,
        cutoverMode: "live",
      },
    });
    expect(harness.legacy.requests).toHaveLength(0);
    expect(harness.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED",
      context: expect.objectContaining({
        error: "database password appeared in provider error",
      }),
    }));
  });

  it("rejects an internally inconsistent shared rate without falling back", async () => {
    const invalidQuote = sharedQuote(800);
    invalidQuote.selectedRate.totalCents = 799;
    const harness = createHarness({
      mode: "live",
      storeConnectionIds: new Set(),
    }, invalidQuote);

    await expect(harness.provider.quote(request())).rejects.toMatchObject({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID",
    });
    expect(harness.legacy.requests).toHaveLength(0);
    expect(harness.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID",
    }));
  });
});

function createHarness(
  cutoverPolicy: {
    mode: "legacy" | "test" | "live";
    storeConnectionIds: ReadonlySet<number>;
  },
  sharedResult: DropshipSharedShippingQuoteResult | Error = sharedQuote(800),
) {
  const legacy = new FakeLegacyRateProvider();
  const shared = new FakeSharedQuoteProvider(sharedResult);
  const logs: DropshipLogEvent[] = [];
  const logger = {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
  const provider = new CutoverDropshipShippingPricingProvider({
    cutoverPolicy,
    legacyRateProvider: legacy,
    sharedQuoteProvider: shared,
    logger,
  });
  return { provider, legacy, shared, logs };
}

class FakeLegacyRateProvider implements DropshipShippingRateProvider {
  requests: DropshipShippingRateRequest[] = [];

  async quoteRates(
    input: DropshipShippingRateRequest,
  ): Promise<DropshipShippingRateResult> {
    this.requests.push(input);
    return {
      zone: { zone: "zone-1", zoneRuleId: 5 },
      rates: input.packages.map((carton) => ({
        packageSequence: carton.packageSequence,
        rateTableId: 33,
        carrier: "USPS",
        service: "Ground Advantage",
        currency: "USD",
        rateCents: 1000,
      })),
      provider: { name: "legacy_rates", version: "test" },
    };
  }
}

class FakeSharedQuoteProvider implements DropshipSharedShippingQuoteProvider {
  requests: DropshipSharedShippingQuoteRequest[] = [];

  constructor(
    private readonly result: DropshipSharedShippingQuoteResult | Error,
  ) {}

  async quote(
    input: DropshipSharedShippingQuoteRequest,
  ): Promise<DropshipSharedShippingQuoteResult> {
    this.requests.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function request(): DropshipShippingPricingRequest {
  return {
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
      placements: [{
        productVariantId: 101,
        sku: "SKU-101",
        unitSequence: 1,
        orientation: "LWH",
        xMm: 0,
        yMm: 0,
        zMm: 0,
        lengthMm: 100,
        widthMm: 75,
        heightMm: 20,
      }],
      productVariantId: 101,
      quantity: 1,
      boxId: 4,
      boxCode: "SMALL",
      weightGrams: 120,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 40,
      requestedCarrier: null,
      requestedService: null,
    }],
    cartonizationProvider: {
      name: "cardshellz-cartonize",
      version: "3.1.0",
    },
    quotedAt: new Date("2026-07-26T11:00:00.000Z"),
  };
}

function sharedQuote(
  baseRateCents: number,
): Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }> {
  return {
    status: "quoted",
    baseRateCents,
    currency: "USD",
    serviceLevelCode: "standard",
    rateBookId: 12,
    rateBookCode: "dropship-vendor-default",
    rateTableId: 44,
    resolvedZone: "PA",
    ratedWeightGrams: 120,
    rateProvider: {
      name: "cardshellz-rates",
      version: "2.0.0",
    },
    selectedRate: {
      serviceLevelId: 1,
      serviceLevelCode: "standard",
      displayName: "Standard Shipping",
      description: null,
      fulfillmentMode: "parcel",
      pricingBasis: "shipment_weight",
      totalCents: baseRateCents,
      currency: "USD",
      promiseMinBusinessDays: 3,
      promiseMaxBusinessDays: 7,
      ratedMeasure: 120,
      maxShipmentWeightGrams: null,
      chargeModel: "fixed_band",
      perStartedPoundCents: null,
      billablePounds: null,
      rateTableId: 44,
      productPolicyApplied: false,
      calculationTrace: [],
    },
    warnings: [],
    routing: {
      source: "channel_policy",
      mode: "engine_quoted",
      rateBookId: 12,
    },
  };
}
