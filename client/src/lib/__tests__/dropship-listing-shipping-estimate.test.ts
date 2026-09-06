import { describe, expect, it } from "vitest";
import { buildListingShippingEstimateRequest, readListingShippingEstimateResponse } from "../dropship-listing-shipping-estimate";

const fields = { quantity: "1", country: "us", region: " PA ", postalCode: " 16066 " };
const request = buildListingShippingEstimateRequest(1, 2, fields);
function response() { return { estimate: { status: "estimated", storeConnectionId: 1, productVariantId: 2, quantity: 1,
  destination: { country: "US", region: "PA", postalCode: "16066" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [],
  warehouseId: 1, packageCount: 1, totalShippingCents: 615, currency: "USD",
  breakdown: { baseRateCents: 500, markupCents: 100, insurancePoolCents: 15, dunnageCents: 0 },
  rate: { source: "shared", rateTableIds: [1], rateBookId: 1, serviceLevelCode: "standard", displayName: "Standard Shipping" } } }; }
describe("shipping scenario boundary", () => {
  it("normalizes an explicit scenario and never includes stock quantity or quote idempotency", () => {
    expect(request).toEqual({ storeConnectionId: 1, productVariantId: 2, quantity: 1, destination: { country: "US", region: "PA", postalCode: "16066" } });
  });
  it.each(["", "-1", "0", "1.5", "1e3", "1001", "NaN", "9007199254740992"])("rejects invalid purchase quantity %s", (quantity) => {
    expect(() => buildListingShippingEstimateRequest(1, 2, { ...fields, quantity })).toThrow();
  });
  it("requires a postal code and a country, and rejects invalid store identity", () => {
    expect(() => buildListingShippingEstimateRequest(0, 2, fields)).toThrow();
    expect(() => buildListingShippingEstimateRequest(1, 2, { ...fields, postalCode: "" })).toThrow();
    expect(() => buildListingShippingEstimateRequest(1, 2, { ...fields, country: "USA" })).toThrow();
  });
  it("validates a success and preserves unavailable rather than showing a zero quote", () => {
    expect(readListingShippingEstimateResponse(response(), request)).toMatchObject({ status: "estimated", totalShippingCents: 615 });
    expect(readListingShippingEstimateResponse({ estimate: { status: "unavailable", storeConnectionId: 1, productVariantId: 2, quantity: 1,
      destination: { country: "US", region: "PA", postalCode: "16066" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [], code: "NO_RATE", message: "No applicable rate." } }, request)).toMatchObject({ status: "unavailable" });
  });
  it("rejects a different row, destination, quantity, malformed response or inconsistent amount", () => {
    for (const change of [{ productVariantId: 3 }, { storeConnectionId: 3 }, { quantity: 2 }, { totalShippingCents: 999 },
      { destination: { country: "US", region: "PA", postalCode: "90210" } },
      { destination: { country: "US", region: "CA", postalCode: "16066" } }]) {
      const next = response();
      Object.assign(next.estimate, change);
      expect(() => readListingShippingEstimateResponse(next, request)).toThrow();
    }
    expect(() => readListingShippingEstimateResponse({ secret: "wrong shape" }, request)).toThrow();
  });
});
