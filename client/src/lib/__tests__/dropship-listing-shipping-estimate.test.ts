import { describe, expect, it } from "vitest";
import { LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } from "@shared/dropship/listing-shipping-estimate";
import { buildListingShippingEstimateRequest, readListingShippingEstimateResponse } from "../dropship-listing-shipping-estimate";

const fields = { quantity: "1", country: "us", region: " PA ", postalCode: " 16066 " };
const request = buildListingShippingEstimateRequest(1, 2, fields);
function response() { return { estimate: { status: "estimated", storeConnectionId: 1, productVariantId: 2, quantity: 1,
  destination: { country: "US", region: "PA", postalCode: "16066" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [],
  totalShippingCents: 615, currency: "USD" } }; }
describe("shipping scenario boundary", () => {
  it.each(["", "P", "Pennsylvania", "12"])("requires an explicit valid region: %s", (region) => {
    expect(() => buildListingShippingEstimateRequest(1, 2, { ...fields, region })).toThrow("two-letter state or region");
  });
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
      destination: { country: "US", region: "PA", postalCode: "16066" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [], code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE } }, request)).toMatchObject({ status: "unavailable" });
  });
  it("accepts valid server-calculated totals without receiving private fee arithmetic", () => {
    for (const totalShippingCents of [0, 824, 999]) {
      const next = response();
      next.estimate.totalShippingCents = totalShippingCents;
      expect(readListingShippingEstimateResponse(next, request)).toMatchObject({ totalShippingCents });
    }
  });
  it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cents %s", (totalShippingCents) => {
    expect(() => readListingShippingEstimateResponse({ estimate: { ...response().estimate, totalShippingCents } }, request)).toThrow();
  });
  it.each([
    { breakdown: { markupCents: 100 } }, { rate: { rateTableIds: [1] } }, { warehouseId: 1 },
    { packageCount: 1 }, { warnings: ["Private provider calculation"] },
  ])("rejects private diagnostics in the public response: %j", (privateFields) => {
    expect(() => readListingShippingEstimateResponse({ estimate: { ...response().estimate, ...privateFields } }, request)).toThrow();
  });
  it("rejects a different row, destination, quantity or malformed response", () => {
    for (const change of [{ productVariantId: 3 }, { storeConnectionId: 3 }, { quantity: 2 },
      { destination: { country: "US", region: "PA", postalCode: "90210" } },
      { destination: { country: "US", region: "CA", postalCode: "16066" } }]) {
      const next = response();
      Object.assign(next.estimate, change);
      expect(() => readListingShippingEstimateResponse(next, request)).toThrow();
    }
    expect(() => readListingShippingEstimateResponse({ secret: "wrong shape" }, request)).toThrow();
  });
});
