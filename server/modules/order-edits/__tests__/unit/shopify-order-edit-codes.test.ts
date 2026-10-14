import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditCodes } from "../../infrastructure/shopify-order-edit-codes";
import { priceOrderEditCodes } from "../../domain/order-edit-code-pricing";
import { baseline } from "../fixtures/order-edit-service.fixture";
import type { OrderEditCodeRule } from "@shared/order-edits/order-edit-codes";

const rule: OrderEditCodeRule = {
  code: "FIVE",
  discountId: "gid://shopify/DiscountCodeNode/1",
  classes: ["ORDER"],
  combinesWith: {
    productDiscounts: true,
    shippingDiscounts: true,
    orderDiscounts: true,
  },
  value: { type: "percentage", percentage: "5" },
  fingerprint: "a".repeat(64),
  redemption: "unlimited",
};
const bag = (amount: string) => ({
  shopMoney: { amount, currencyCode: "USD" },
  presentmentMoney: { amount, currencyCode: "USD" },
});
const lines = [
  {
    id: "line",
    variantId: "gid://shopify/ProductVariant/10",
    quantity: 1,
    grossCents: 279,
    productNetCents: 233,
  },
];
function harness() {
  // Captured response shape from a calculation-only request on #64043:
  // line discount base $2.33, platform saving $0.11, final subtotal $2.22.
  const calculation = {
    lineItems: [
      {
        variant: { id: lines[0].variantId },
        quantity: 1,
        discountedTotalSet: bag("2.33"),
      },
    ],
    platformDiscounts: [
      {
        code: "FIVE",
        discountClasses: ["ORDER"],
        totalAmountPriceSet: bag("0.11"),
      },
    ],
    lineItemsSubtotalPrice: bag("2.33"),
    subtotalPriceSet: bag("2.22"),
  };
  const request = vi.fn(
    async (_query: string, _variables: Record<string, unknown>) => ({
      draftOrderCalculate: {
        userErrors: [],
        calculatedDraftOrder: calculation,
      },
    }),
  );
  const codes = new ShopifyOrderEditCodes(
    request,
    () => new Date("2026-10-14T12:00:00Z"),
    {
      available: () => true,
      validate: async () => {},
      reserve: async () => {},
      finalize: async () => {},
      release: async () => {},
    },
  );
  return { codes, request, calculation };
}
describe("new-code native calculation totals", () => {
  it("uses the native approved cent while separately proving product prices and the post-code subtotal", async () => {
    const h = harness();
    const approved = await h.codes.verifyNativeCalculation(baseline(), lines, [
      rule,
    ]);
    expect(approved).toEqual([{ code: "FIVE", amountCents: 11 }]);
    const priced = priceOrderEditCodes(lines, [rule], [rule.code], approved);
    expect(priced.lines[0].netCents).toBe(222);
    expect(priced.applications).toEqual(approved);
    expect(h.request.mock.calls[0][0]).toContain("draftOrderCalculate");
    expect(h.request.mock.calls[0][0]).not.toContain("draftOrderCreate");
  });
  it("requires the exact reviewed native saving again before commit", async () => {
    const h = harness();
    await expect(
      h.codes.verifyNativeCalculation(
        baseline(),
        lines,
        [rule],
        [{ code: "FIVE", amountCents: 12 }],
      ),
    ).rejects.toThrow(/complete code savings/);
  });
  it.each(["subtotal", "product_base", "currency", "identity", "missing_code"])(
    "rejects contradictory %s evidence",
    async (failure) => {
      const h = harness();
      if (failure === "subtotal") h.calculation.subtotalPriceSet = bag("2.21");
      if (failure === "product_base")
        h.calculation.lineItems[0].discountedTotalSet = bag("2.32");
      if (failure === "currency")
        h.calculation.subtotalPriceSet.presentmentMoney.currencyCode = "CAD";
      if (failure === "identity")
        h.calculation.lineItems[0].variant.id =
          "gid://shopify/ProductVariant/11";
      if (failure === "missing_code") h.calculation.platformDiscounts = [];
      await expect(
        h.codes.verifyNativeCalculation(baseline(), lines, [rule]),
      ).rejects.toThrow();
    },
  );
  it("accepts only adjacent percentage cents and the exact fixed credit budget", () => {
    for (const amount of [11, 12])
      expect(
        priceOrderEditCodes(
          lines,
          [rule],
          [rule.code],
          [{ code: rule.code, amountCents: amount }],
        ).applications[0].amountCents,
      ).toBe(amount);
    for (const amount of [10, 13, 233])
      expect(() =>
        priceOrderEditCodes(
          lines,
          [rule],
          [rule.code],
          [{ code: rule.code, amountCents: amount }],
        ),
      ).toThrow(/rounding bounds/);
    const fixed = {
      ...rule,
      value: { type: "fixed" as const, amountCents: 50 },
    };
    expect(() =>
      priceOrderEditCodes(
        lines,
        [fixed],
        [fixed.code],
        [{ code: fixed.code, amountCents: 49 }],
      ),
    ).toThrow(/single credit budget/);
  });
});
