import { describe, expect, it, vi } from "vitest";
import type { RateQuoteLine } from "../../application/rate-quote.service";
import { parseCheckoutRateRolloutPolicy } from "../../domain/checkout-rate-rollout-policy";
import type { DeliveryWindow } from "../../domain/eta";
import { resolveShopifyCheckoutRateOwnership } from "../../domain/destination-rate-ownership";
import type {
  RuntimeChannelShippingResolution,
} from "../../application/channel-shipping-policy-runtime.service";
import {
  computeCheckoutRates,
  isCallbackTokenAuthorized,
  mapQuotesToShopifyRates,
  parseShopifyRateRequest,
  type CheckoutRateDependencies,
} from "../../interfaces/http/carrier-callback.routes";

describe("isCallbackTokenAuthorized", () => {
  it("requires the exact configured token", () => {
    expect(isCallbackTokenAuthorized(undefined, "anything")).toBe(false);
    expect(isCallbackTokenAuthorized("", "anything")).toBe(false);
    expect(isCallbackTokenAuthorized("secret-token", "secret-tokeN")).toBe(false);
    expect(isCallbackTokenAuthorized("secret-token", "secret-token")).toBe(true);
  });
});

function shopifyBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    rate: {
      origin: { postal_code: "89101", country: "US" },
      destination: { postal_code: "96813", country: "us", province: "hi" },
      items: [
        { name: "Sleeves", sku: "SLV-100", quantity: 2, grams: 120, price: 999 },
        { name: "Case", sku: " CASE-9 ", quantity: 1, grams: 2500, price: 4999 },
      ],
      currency: "USD",
      ...overrides,
    },
  };
}

function legacyRouting(
  mode: "engine_quoted" | "channel_managed",
): RuntimeChannelShippingResolution {
  return {
    ok: true,
    channel: null,
    decision: {
      ok: true,
      source: "legacy_profile",
      policyId: null,
      policyVersion: null,
      routeId: null,
      mode,
      eligibilityMode: mode === "engine_quoted" ? "engine" : "channel",
      rateBookId: null,
      legacyRateContext: mode === "engine_quoted"
        ? {
            pricingChannel: "shopify",
            purpose: "customer_checkout",
          }
        : null,
    },
  };
}

function canonicalRouting(
  mode: "engine_quoted" | "channel_managed" | "disabled",
): RuntimeChannelShippingResolution {
  return {
    ok: true,
    channel: {
      id: 36,
      provider: "shopify",
      status: "active",
      isDefault: 1,
    },
    decision: {
      ok: true,
      source: "channel_policy",
      policyId: 100,
      policyVersion: 3,
      routeId: 200,
      mode,
      eligibilityMode: mode === "disabled"
        ? "none"
        : mode === "channel_managed"
          ? "channel"
          : "intersection",
      rateBookId: mode === "engine_quoted" ? 300 : null,
      legacyRateContext: null,
    },
  };
}

describe("parseShopifyRateRequest", () => {
  it("normalizes destination and line identity", () => {
    const result = parseShopifyRateRequest(shopifyBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      destPostal: "96813",
      destCountry: "US",
      destRegion: "HI",
      items: [
        { sku: "SLV-100", quantity: 2, grams: 120, priceCents: 999 },
        { sku: "CASE-9", quantity: 1, grams: 2500, priceCents: 4999 },
      ],
    });
  });

  it("preserves SKU-less lines and normalizes missing weight", () => {
    const result = parseShopifyRateRequest(shopifyBody({
      items: [
        { sku: null, quantity: 3, grams: 50 },
        { quantity: 2, grams: 0 },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items).toEqual([
      { sku: null, quantity: 3, grams: 50, priceCents: null },
      { sku: null, quantity: 2, grams: null, priceCents: null },
    ]);
  });

  it("normalizes a full province name", () => {
    const result = parseShopifyRateRequest(shopifyBody({
      destination: { postal_code: "16066", country: "US", province: "Pennsylvania" },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.destRegion).toBe("PA");
  });

  it("rejects malformed requests and invalid quantities", () => {
    for (const body of [
      null,
      {},
      { rate: {} },
      shopifyBody({ items: [{ sku: "A", quantity: 0 }] }),
      shopifyBody({ items: [{ sku: "A", quantity: 1.5 }] }),
    ]) {
      expect(parseShopifyRateRequest(body).ok).toBe(false);
    }
  });
});

describe("Shopify checkout destination ownership", () => {
  it("assigns US rates to Echelon and all valid non-US countries to Shopify", () => {
    expect(resolveShopifyCheckoutRateOwnership("us")).toMatchObject({
      ok: true,
      countryCode: "US",
      owner: "echelon",
    });
    expect(resolveShopifyCheckoutRateOwnership("dk")).toMatchObject({
      ok: true,
      countryCode: "DK",
      owner: "shopify",
    });
    expect(resolveShopifyCheckoutRateOwnership("USA")).toMatchObject({
      ok: false,
      reasonCode: "INVALID_DESTINATION_COUNTRY",
    });
  });

  it("resolves policy authority but bypasses the quote pipeline for a Shopify-managed country", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => {
        throw new Error("rollout policy must not run for Shopify-managed destinations");
      }),
      loadCatalogWeightsBySku: vi.fn(async () => {
        throw new Error("catalog lookup must not run for Shopify-managed destinations");
      }),
      resolveChannelShipping: vi.fn(async () =>
        legacyRouting("channel_managed")),
      quoteShipment: vi.fn(async () => {
        throw new Error("Echelon quote must not run for Shopify-managed destinations");
      }),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    const rates = await computeCheckoutRates(shopifyBody({
      destination: { postal_code: "2100", country: "DK", province: null },
    }), dependencies);

    expect(rates).toEqual([]);
    expect(dependencies.originWarehouseId).toHaveBeenCalledOnce();
    expect(dependencies.resolveChannelShipping).toHaveBeenCalledOnce();
    expect(dependencies.rolloutPolicy).not.toHaveBeenCalled();
    expect(dependencies.loadCatalogWeightsBySku).not.toHaveBeenCalled();
    expect(dependencies.quoteShipment).not.toHaveBeenCalled();
    expect(persistSnapshot).toHaveBeenCalledOnce();
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "shopify_managed_destination",
      request: expect.objectContaining({ destCountry: "DK" }),
      shopifyRates: [],
      channelRouting: expect.objectContaining({ ok: true }),
    }));
  });

  it("bypasses every quote dependency for US traffic while rollout is off", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => parseCheckoutRateRolloutPolicy({ mode: "off" })),
      loadCatalogWeightsBySku: vi.fn(async () => {
        throw new Error("catalog lookup must not run while rollout is off");
      }),
      resolveChannelShipping: vi.fn(async () =>
        legacyRouting("engine_quoted")),
      quoteShipment: vi.fn(async () => {
        throw new Error("Echelon quote must not run while rollout is off");
      }),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    const rates = await computeCheckoutRates(shopifyBody(), dependencies);

    expect(rates).toEqual([]);
    expect(dependencies.rolloutPolicy).toHaveBeenCalledOnce();
    expect(dependencies.originWarehouseId).toHaveBeenCalledOnce();
    expect(dependencies.resolveChannelShipping).toHaveBeenCalledOnce();
    expect(dependencies.loadCatalogWeightsBySku).not.toHaveBeenCalled();
    expect(dependencies.quoteShipment).not.toHaveBeenCalled();
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "rollout_disabled",
      rolloutDecision: expect.objectContaining({
        shouldQuote: false,
        reasonCode: "ROLLOUT_DISABLED",
      }),
      shopifyRates: [],
    }));
  });

  it("bypasses the quote pipeline when a test cart contains a non-allowlisted SKU", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => parseCheckoutRateRolloutPolicy({
        mode: "test",
        testSkus: "SLV-100",
      })),
      loadCatalogWeightsBySku: vi.fn(async () => {
        throw new Error("catalog lookup must not run for a blocked test cart");
      }),
      resolveChannelShipping: vi.fn(async () =>
        legacyRouting("engine_quoted")),
      quoteShipment: vi.fn(async () => {
        throw new Error("Echelon quote must not run for a blocked test cart");
      }),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    const rates = await computeCheckoutRates(shopifyBody(), dependencies);

    expect(rates).toEqual([]);
    expect(dependencies.originWarehouseId).toHaveBeenCalledOnce();
    expect(dependencies.resolveChannelShipping).toHaveBeenCalledOnce();
    expect(dependencies.loadCatalogWeightsBySku).not.toHaveBeenCalled();
    expect(dependencies.quoteShipment).not.toHaveBeenCalled();
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "rollout_test_bypassed",
      rolloutDecision: expect.objectContaining({
        shouldQuote: false,
        reasonCode: "TEST_CART_SKU_NOT_ALLOWED",
        deniedSkus: ["CASE-9"],
      }),
      shopifyRates: [],
    }));
  });

  it("runs the quote pipeline when every test-cart SKU is allowlisted", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => parseCheckoutRateRolloutPolicy({
        mode: "test",
        testSkus: "SLV-100,CASE-9",
      })),
      loadCatalogWeightsBySku: vi.fn(async () => new Map([
        ["SLV-100", 120],
        ["CASE-9", 2_500],
      ])),
      resolveChannelShipping: vi.fn(async () =>
        legacyRouting("engine_quoted")),
      quoteShipment: vi.fn(async () => ({
        ok: false as const,
        code: "INVALID_SHIPMENT" as const,
        errors: ["intentional test quote failure"],
      })),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    const rates = await computeCheckoutRates(shopifyBody(), dependencies);

    expect(rates).toEqual([]);
    expect(dependencies.originWarehouseId).toHaveBeenCalledOnce();
    expect(dependencies.loadCatalogWeightsBySku).toHaveBeenCalledWith([
      "SLV-100",
      "CASE-9",
    ]);
    expect(dependencies.quoteShipment).toHaveBeenCalledOnce();
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "echelon_quote_unavailable",
      rolloutDecision: expect.objectContaining({
        shouldQuote: true,
        reasonCode: "TEST_CART_ALLOWED",
      }),
      shopifyRates: [],
    }));
  });

  it("passes the canonical policy pricing program into the quote pipeline", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => parseCheckoutRateRolloutPolicy({
        mode: "live",
      })),
      loadCatalogWeightsBySku: vi.fn(async () => new Map([
        ["SLV-100", 120],
        ["CASE-9", 2_500],
      ])),
      resolveChannelShipping: vi.fn(async () =>
        canonicalRouting("engine_quoted")),
      quoteShipment: vi.fn(async () => ({
        ok: false as const,
        code: "INVALID_SHIPMENT" as const,
        errors: ["intentional test quote failure"],
      })),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    await computeCheckoutRates(shopifyBody(), dependencies);

    expect(dependencies.quoteShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "shopify",
        rateBookId: 300,
        originWarehouseId: 1,
      }),
      expect.any(Object),
    );
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      channelRouting: expect.objectContaining({
        decision: expect.objectContaining({
          source: "channel_policy",
          rateBookId: 300,
        }),
      }),
    }));
  });

  it("routes a canonical non-US engine route instead of legacy delegation", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => parseCheckoutRateRolloutPolicy({
        mode: "live",
      })),
      loadCatalogWeightsBySku: vi.fn(async () => new Map([
        ["SLV-100", 120],
        ["CASE-9", 2_500],
      ])),
      resolveChannelShipping: vi.fn(async () =>
        canonicalRouting("engine_quoted")),
      quoteShipment: vi.fn(async () => ({
        ok: false as const,
        code: "INVALID_SHIPMENT" as const,
        errors: ["intentional test quote failure"],
      })),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    await computeCheckoutRates(shopifyBody({
      destination: {
        postal_code: "2100",
        country: "DK",
        province: null,
      },
    }), dependencies);

    expect(dependencies.quoteShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        rateBookId: 300,
        destination: {
          country: "DK",
          region: null,
          postalCode: "2100",
        },
      }),
      expect.any(Object),
    );
  });

  it.each([
    {
      mode: "channel_managed" as const,
      disposition: "shopify_managed_destination",
    },
    {
      mode: "disabled" as const,
      disposition: "channel_policy_disabled",
    },
  ])(
    "does not quote a canonical $mode route",
    async ({ mode, disposition }) => {
      const persistSnapshot = vi.fn(async () => undefined);
      const dependencies: CheckoutRateDependencies = {
        originWarehouseId: vi.fn(() => 1),
        rolloutPolicy: vi.fn(() => {
          throw new Error("rollout must not run for a non-engine route");
        }),
        loadCatalogWeightsBySku: vi.fn(async () => {
          throw new Error("catalog lookup must not run for a non-engine route");
        }),
        resolveChannelShipping: vi.fn(async () =>
          canonicalRouting(mode)),
        quoteShipment: vi.fn(async () => {
          throw new Error("quote must not run for a non-engine route");
        }),
        loadDeliveryEstimates: vi.fn(async () => new Map()),
        persistSnapshot,
      };

      const rates = await computeCheckoutRates(shopifyBody(), dependencies);

      expect(rates).toEqual([]);
      expect(dependencies.rolloutPolicy).not.toHaveBeenCalled();
      expect(dependencies.loadCatalogWeightsBySku).not.toHaveBeenCalled();
      expect(dependencies.quoteShipment).not.toHaveBeenCalled();
      expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        disposition,
        channelRouting: expect.objectContaining({ ok: true }),
      }));
    },
  );

  it("fails closed when canonical policy resolution fails", async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    const dependencies: CheckoutRateDependencies = {
      originWarehouseId: vi.fn(() => 1),
      rolloutPolicy: vi.fn(() => {
        throw new Error("rollout must not run after policy failure");
      }),
      loadCatalogWeightsBySku: vi.fn(async () => {
        throw new Error("catalog lookup must not run after policy failure");
      }),
      resolveChannelShipping: vi.fn(async () => ({
        ok: false as const,
        code: "NO_MATCHING_ROUTE" as const,
        message: "active policy has no matching route",
        channel: {
          id: 36,
          provider: "shopify",
          status: "active",
          isDefault: 1,
        },
        decision: {
          ok: false as const,
          code: "NO_MATCHING_ROUTE" as const,
          message: "active policy has no matching route",
        },
      })),
      quoteShipment: vi.fn(async () => {
        throw new Error("quote must not run after policy failure");
      }),
      loadDeliveryEstimates: vi.fn(async () => new Map()),
      persistSnapshot,
    };

    const rates = await computeCheckoutRates(shopifyBody(), dependencies);

    expect(rates).toEqual([]);
    expect(dependencies.quoteShipment).not.toHaveBeenCalled();
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "channel_policy_unavailable",
      warnings: ["active policy has no matching route"],
    }));
  });
});

const QUOTES: RateQuoteLine[] = [
  {
    serviceLevelId: 1,
    serviceLevelCode: "standard",
    displayName: "Standard Shipping",
    description: null,
    fulfillmentMode: "parcel",
    pricingBasis: "shipment_weight",
    totalCents: 899,
    currency: "USD",
    promiseMinBusinessDays: 3,
    promiseMaxBusinessDays: 7,
    ratedMeasure: 500,
    maxShipmentWeightGrams: null,
  },
  {
    serviceLevelId: 2,
    serviceLevelCode: "expedited",
    displayName: "Priority Shipping",
    description: "Faster parcel delivery",
    fulfillmentMode: "parcel",
    pricingBasis: "shipment_weight",
    totalCents: 1299,
    currency: "USD",
    promiseMinBusinessDays: 2,
    promiseMaxBusinessDays: 3,
    ratedMeasure: 500,
    maxShipmentWeightGrams: null,
  },
];

describe("mapQuotesToShopifyRates", () => {
  it("maps internal service-level charges directly", () => {
    expect(mapQuotesToShopifyRates(QUOTES)).toEqual([
      {
        service_name: "Standard Shipping",
        service_code: "standard",
        total_price: "899",
        currency: "USD",
      },
      {
        service_name: "Priority Shipping",
        service_code: "expedited",
        total_price: "1299",
        currency: "USD",
        description: "Faster parcel delivery",
      },
    ]);
  });

  it("stringifies zero-value charges for Shopify", () => {
    const rates = mapQuotesToShopifyRates([{ ...QUOTES[0], totalCents: 0 }]);
    expect(rates[0].total_price).toBe("0");
  });

  it("attaches promise dates by service-level identity", () => {
    const standard: DeliveryWindow = { minDate: "2026-07-10", maxDate: "2026-07-15" };
    const priority: DeliveryWindow = { minDate: "2026-07-09", maxDate: "2026-07-13" };
    const rates = mapQuotesToShopifyRates(
      QUOTES,
      new Map([[1, standard], [2, priority]]),
    );
    expect(rates.map((rate) => [
      rate.service_code,
      rate.min_delivery_date,
      rate.max_delivery_date,
    ])).toEqual([
      ["standard", "2026-07-10", "2026-07-15"],
      ["expedited", "2026-07-09", "2026-07-13"],
    ]);
  });

  it("omits delivery dates when no promise window is available", () => {
    const rates = mapQuotesToShopifyRates(QUOTES);
    expect(rates[0]).not.toHaveProperty("min_delivery_date");
  });
});
