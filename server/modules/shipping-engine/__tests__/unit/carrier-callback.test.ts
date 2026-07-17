import { describe, expect, it } from "vitest";
import type { RateQuoteLine } from "../../application/rate-quote.service";
import type { DeliveryWindow } from "../../domain/eta";
import {
  isCallbackTokenAuthorized,
  mapQuotesToShopifyRates,
  parseShopifyRateRequest,
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
        { sku: "SLV-100", quantity: 2, grams: 120 },
        { sku: "CASE-9", quantity: 1, grams: 2500 },
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
      { sku: null, quantity: 3, grams: 50 },
      { sku: null, quantity: 2, grams: null },
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
