import { describe, expect, it } from "vitest";
import {
  extractOrderFromWebhookPayload,
  type ShopifyAddress,
  type ShopifyOrder,
} from "../../../integrations/shopify";

function payload(address: Partial<ShopifyAddress> | null): ShopifyOrder {
  return {
    id: 1,
    order_number: 1,
    name: "#1",
    email: "fixture@example.test",
    customer: null,
    line_items: [],
    tags: "",
    fulfillment_status: null,
    financial_status: "paid",
    note: null,
    created_at: "2026-09-01T12:00:00.000Z",
    cancelled_at: null,
    currency: "USD",
    total_price: "0.00",
    subtotal_price: "0.00",
    total_tax: "0.00",
    total_discounts: "0.00",
    billing_address: null,
    shipping_lines: [],
    discount_codes: [],
    shipping_address:
      address === null
        ? null
        : {
            first_name: null,
            last_name: null,
            company: null,
            address1: null,
            address2: null,
            city: null,
            province: null,
            zip: null,
            country: null,
            country_code: null,
            phone: null,
            ...address,
          },
  };
}

describe("legacy Shopify operational order country extraction", () => {
  it.each([
    [{ country_code: " us ", country: "United States" }, "US"],
    [{ country_code: " ", country: "Canada" }, "CA"],
    [{ country: "United States" }, "US"],
    [{ country_code: "GB", country: "unrecognized translated label" }, "GB"],
    [null, null],
    [{}, null],
  ])("normalizes provider address %j to %s", (address, expected) => {
    const input = payload(address);
    const before = structuredClone(input);
    expect(extractOrderFromWebhookPayload(input).shippingCountry).toBe(
      expected,
    );
    expect(input).toEqual(before);
  });
  // Exercise the runtime boundary even when a provider violates its declared type.
  it.each([
    { country_code: "ZZ", country: "United States" },
    { country: "Atlantis" },
    { country_code: 123 as unknown as string },
  ])(
    "rejects bad provider country instead of falling back or persisting it: %j",
    (address) => {
      expect(() => extractOrderFromWebhookPayload(payload(address))).toThrow(
        expect.objectContaining({ code: "ORDER_COUNTRY_INVALID" }),
      );
    },
  );
});
