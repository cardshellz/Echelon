import { test, expect } from "vitest";
import { extractShopifySalesFinancials } from "../../archon-sales-financials";
import { extractShopifyDiscountEvidence } from "../../archon-discount-evidence";
const raw = {
  id: 101,
  currency: "USD",
  updated_at: "2026-09-23T14:00:00-04:00",
  taxes_included: false,
  subtotal_price: "80.00",
  total_price: "91.00",
  total_tax: "4.00",
  original_total_duties_set: null,
  original_total_additional_fees_set: null,
  total_tip_received: "0.00",
  line_items: [
    {
      price: "100.00",
      quantity: 1,
      discount_allocations: [
        { amount: "20.00", discount_application_index: 0 },
      ],
    },
  ],
  shipping_lines: [
    {
      price: "10.00",
      discounted_price: "7.00",
      discount_allocations: [{ amount: "3.00", discount_application_index: 1 }],
    },
  ],
  discount_applications: [
    { type: "discount_code", code: "SAVE", target_type: "line_item" },
    { type: "discount_code", code: "SHIP", target_type: "shipping_line" },
  ],
};
const extract = (input: unknown) =>
  extractShopifySalesFinancials(
    input,
    extractShopifyDiscountEvidence(input, "USD"),
    "101",
    "USD",
  );
test("one provider snapshot reconciles merchandise, shipping discounts, added tax and total", () => {
  const f = extract(raw);
  expect(f).toMatchObject({
    grossMerchandiseCents: 10000,
    merchandiseDiscountCents: 2000,
    netMerchandiseCents: 8000,
    grossShippingCents: 1000,
    shippingDiscountCents: 300,
    netShippingCents: 700,
    taxAddedCents: 400,
    taxIncludedCents: 0,
    orderTotalCents: 9100,
  });
  expect(extract({ order: raw })).toEqual(f);
});
test("tax already included in prices is not added twice; duties, fees and tips reconcile", () => {
  const input = {
    ...raw,
    taxes_included: true,
    total_price: "93.16",
    original_total_duties_set: {
      shop_money: { amount: "4.16", currency_code: "USD" },
    },
    original_total_additional_fees_set: {
      shop_money: { amount: "1.00", currency_code: "USD" },
    },
    total_tip_received: "1.00",
  };
  expect(extract(input)).toMatchObject({
    taxAddedCents: 0,
    taxIncludedCents: 400,
    dutiesCents: 416,
    feesCents: 100,
    tipsCents: 100,
    orderTotalCents: 9316,
  });
});
test("absent fields, unknown tax semantics, bad identity/currency, removed lines and mismatches are unavailable", () => {
  for (const key of [
    "updated_at",
    "taxes_included",
    "subtotal_price",
    "total_price",
    "total_tax",
    "original_total_duties_set",
    "original_total_additional_fees_set",
    "total_tip_received",
    "shipping_lines",
  ]) {
    const input = { ...raw } as Record<string, unknown>;
    delete input[key];
    expect(extract(input), key).toBeUndefined();
  }
  for (const change of [
    { id: 102 },
    { currency: "CAD" },
    { total_price: "90.99" },
    { subtotal_price: "100.00" },
    { total_tax: "4.001" },
    { taxes_included: "false" },
    { updated_at: "invalid" },
    { shipping_lines: [{ ...raw.shipping_lines[0], is_removed: true }] },
    {
      shipping_lines: [{ ...raw.shipping_lines[0], discounted_price: "10.00" }],
    },
  ])
    expect(extract({ ...raw, ...change })).toBeUndefined();
});
test("current after-refund fields never replace original order fields", () => {
  expect(
    extract({
      ...raw,
      current_total_price: "1.00",
      current_subtotal_price: "1.00",
      current_total_tax: "0.00",
    }),
  ).toEqual(extract(raw));
});
