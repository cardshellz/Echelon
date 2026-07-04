import { describe, expect, it } from "vitest";
import {
  isCallbackTokenAuthorized,
  mapQuotesToShopifyRates,
  parseShopifyRateRequest,
  type ActiveServiceLevelMethod,
} from "../../interfaces/http/carrier-callback.routes";
import type { RateQuoteLine } from "../../application/rate-quote.service";

// ---------------------------------------------------------------------------
// Token gate
// ---------------------------------------------------------------------------

describe("isCallbackTokenAuthorized", () => {
  it("rejects when no expected token is configured (endpoint does not exist)", () => {
    expect(isCallbackTokenAuthorized(undefined, "anything")).toBe(false);
    expect(isCallbackTokenAuthorized("", "anything")).toBe(false);
    expect(isCallbackTokenAuthorized("   ", "anything")).toBe(false);
  });

  it("rejects a wrong token, including different-length tokens", () => {
    expect(isCallbackTokenAuthorized("secret-token", "secret-tokeN")).toBe(false);
    expect(isCallbackTokenAuthorized("secret-token", "secret")).toBe(false);
    expect(isCallbackTokenAuthorized("secret-token", "")).toBe(false);
  });

  it("accepts the exact configured token", () => {
    expect(isCallbackTokenAuthorized("secret-token", "secret-token")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function shopifyBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    rate: {
      origin: { postal_code: "89101", country: "US" },
      destination: { postal_code: "96813", country: "us" },
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
  it("parses destination, uppercases country, trims SKUs", () => {
    const result = parseShopifyRateRequest(shopifyBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.destPostal).toBe("96813");
    expect(result.request.destCountry).toBe("US");
    expect(result.request.items).toEqual([
      { sku: "SLV-100", quantity: 2, grams: 120 },
      { sku: "CASE-9", quantity: 1, grams: 2500 },
    ]);
    expect(result.request.skippedNoSkuCount).toBe(0);
  });

  it("skips SKU-less lines and counts them", () => {
    const result = parseShopifyRateRequest(shopifyBody({
      items: [
        { sku: "SLV-100", quantity: 1, grams: 100 },
        { sku: null, quantity: 3, grams: 50 },
        { quantity: 2 },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items).toHaveLength(1);
    expect(result.request.skippedNoSkuCount).toBe(2);
  });

  it("rejects when no line has a SKU", () => {
    const result = parseShopifyRateRequest(shopifyBody({
      items: [{ quantity: 1, grams: 100 }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no items with a SKU");
  });

  it("rejects malformed bodies without throwing", () => {
    for (const body of [null, undefined, {}, { rate: {} }, { rate: { destination: {}, items: [] } }, "junk", 42]) {
      const result = parseShopifyRateRequest(body);
      expect(result.ok).toBe(false);
    }
  });

  it("normalizes non-positive grams to null", () => {
    const result = parseShopifyRateRequest(shopifyBody({
      items: [{ sku: "A-1", quantity: 1, grams: 0 }, { sku: "B-2", quantity: 1 }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items.map((i) => i.grams)).toEqual([null, null]);
  });

  it("rejects non-integer or non-positive quantities", () => {
    const zeroQty = parseShopifyRateRequest(shopifyBody({ items: [{ sku: "A-1", quantity: 0 }] }));
    expect(zeroQty.ok).toBe(false);
    const fractional = parseShopifyRateRequest(shopifyBody({ items: [{ sku: "A-1", quantity: 1.5 }] }));
    expect(fractional.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Response mapping through active service levels
// ---------------------------------------------------------------------------

const QUOTES: RateQuoteLine[] = [
  { carrier: "USPS", serviceCode: "usps_ground_advantage", totalCents: 899, currency: "USD", perParcelCents: [899] },
  { carrier: "UPS", serviceCode: "ups_ground", totalCents: 1099, currency: "USD", perParcelCents: [1099] },
  { carrier: "USPS", serviceCode: "usps_priority_mail", totalCents: 1299, currency: "USD", perParcelCents: [1299] },
];

function method(overrides: Partial<ActiveServiceLevelMethod>): ActiveServiceLevelMethod {
  return {
    levelCode: "standard",
    displayName: "Standard Shipping",
    description: null,
    sortOrder: 0,
    carrier: "USPS",
    serviceCode: "usps_ground_advantage",
    ...overrides,
  };
}

describe("mapQuotesToShopifyRates", () => {
  it("returns [] when no service levels are active (shadow-safe default)", () => {
    expect(mapQuotesToShopifyRates(QUOTES, [])).toEqual([]);
  });

  it("returns [] when there are no quotes", () => {
    expect(mapQuotesToShopifyRates([], [method({})])).toEqual([]);
  });

  it("excludes quotes whose carrier/service is not attached to an active level", () => {
    const rates = mapQuotesToShopifyRates(QUOTES, [method({})]);
    expect(rates).toEqual([{
      service_name: "Standard Shipping",
      service_code: "standard",
      total_price: "899",
      currency: "USD",
    }]);
  });

  it("picks the cheapest qualifying method per level", () => {
    const rates = mapQuotesToShopifyRates(QUOTES, [
      method({ carrier: "UPS", serviceCode: "ups_ground" }),
      method({ carrier: "USPS", serviceCode: "usps_ground_advantage" }),
    ]);
    expect(rates).toHaveLength(1);
    expect(rates[0].total_price).toBe("899");
  });

  it("matches carrier/serviceCode case-insensitively", () => {
    const rates = mapQuotesToShopifyRates(QUOTES, [
      method({ carrier: "usps", serviceCode: "USPS_GROUND_ADVANTAGE" }),
    ]);
    expect(rates).toHaveLength(1);
    expect(rates[0].total_price).toBe("899");
  });

  it("orders levels by sortOrder and includes descriptions when present", () => {
    const rates = mapQuotesToShopifyRates(QUOTES, [
      method({
        levelCode: "expedited", displayName: "Expedited", sortOrder: 1,
        carrier: "USPS", serviceCode: "usps_priority_mail",
        description: "2-3 business days",
      }),
      method({ sortOrder: 0 }),
    ]);
    expect(rates.map((r) => r.service_code)).toEqual(["standard", "expedited"]);
    expect(rates[1]).toMatchObject({
      service_name: "Expedited",
      total_price: "1299",
      description: "2-3 business days",
    });
    expect(rates[0]).not.toHaveProperty("description");
  });

  it("stringifies totals in cents (Shopify contract)", () => {
    const rates = mapQuotesToShopifyRates(
      [{ carrier: "USPS", serviceCode: "s", totalCents: 0, currency: "USD", perParcelCents: [0] }],
      [method({ serviceCode: "s" })],
    );
    expect(rates[0].total_price).toBe("0");
    expect(typeof rates[0].total_price).toBe("string");
  });
});
