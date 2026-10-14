import { describe, expect, it } from "vitest";
import {
  orderEditCodeRuleSchema,
  type OrderEditCodeRule,
} from "@shared/order-edits/order-edit-codes";
import {
  assertCouponAdjustmentSupported,
  requiresLegacyCodeReceipt,
} from "../../domain/order-edit-coupon-boundary";
import { priceOrderEditCodes } from "../../domain/order-edit-code-pricing";

const coupon: OrderEditCodeRule = {
  discountId: "gid://shopify/DiscountCodeNode/1",
  code: "TEN",
  classes: ["ORDER"],
  combinesWith: {
    productDiscounts: true,
    orderDiscounts: true,
    shippingDiscounts: true,
  },
  value: { type: "percentage", percentage: "10" },
  fingerprint: "a".repeat(64),
  redemption: "shopify_coupon",
  usageLimit: null,
  appliesOncePerCustomer: false,
};
const lines = [
  {
    id: "line",
    variantId: "gid://shopify/ProductVariant/1",
    quantity: 1,
    grossCents: 1000,
    productNetCents: 800,
  },
];

describe("Shopify coupon / points-accounting boundary", () => {
  it.each([
    { usageLimit: null, appliesOncePerCustomer: false },
    { usageLimit: 1, appliesOncePerCustomer: false },
    { usageLimit: null, appliesOncePerCustomer: true },
  ])("never routes ordinary coupons to a points receipt: %j", (limits) => {
    const pricing = priceOrderEditCodes(
      lines,
      [{ ...coupon, ...limits }],
      [coupon.code],
    );
    expect(requiresLegacyCodeReceipt(pricing)).toBe(false);
  });
  it("preserves recovery of legacy reward receipts and ignores retained codes", () => {
    const legacy = {
      ...coupon,
      redemption: "single_use_reward" as const,
      value: { type: "fixed" as const, amountCents: 100 },
    };
    expect(
      requiresLegacyCodeReceipt(
        priceOrderEditCodes(lines, [legacy], [legacy.code]),
      ),
    ).toBe(true);
    expect(
      requiresLegacyCodeReceipt(priceOrderEditCodes(lines, [legacy], [])),
    ).toBe(false);
    expect(requiresLegacyCodeReceipt(undefined)).toBe(false);
  });
  it("preserves unlimited-campaign adjustments without a rewards record", () => {
    expect(() => assertCouponAdjustmentSupported([coupon])).not.toThrow();
  });
  it.each([
    { ...coupon, code: "ten" },
    { ...coupon, code: "HOLIDAY-ALIAS" },
    { ...coupon, discountId: "gid://shopify/DiscountCodeNode/2" },
  ])("rejects an already applied coupon by code or campaign identity: $code", (candidate) => {
    expect(() => assertCouponAdjustmentSupported([candidate], [coupon])).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_CODE_ALREADY_APPLIED" }),
    );
  });
  it("retains an existing adjustment without treating it as a fresh redemption", () => {
    const retained = { ...coupon, appliesOncePerCustomer: true };
    const before = structuredClone(retained);
    expect(() => assertCouponAdjustmentSupported([], [retained])).not.toThrow();
    expect(retained).toEqual(before);
  });
  it("does not impose a points-credit consumption rule on a fixed Shopify coupon", () => {
    const fixedCoupon: OrderEditCodeRule = {
      ...coupon,
      value: { type: "fixed", amountCents: 1900 },
    };
    const pricing = priceOrderEditCodes(
      lines,
      [fixedCoupon],
      [fixedCoupon.code],
      [{ code: fixedCoupon.code, amountCents: 800 }],
    );
    expect(pricing.lines[0].netCents).toBe(0);
    expect(pricing.applications).toEqual([
      { code: fixedCoupon.code, amountCents: 800 },
    ]);
    expect(requiresLegacyCodeReceipt(pricing)).toBe(false);
  });
  it.each([
    { usageLimit: 1, appliesOncePerCustomer: false },
    { usageLimit: 10, appliesOncePerCustomer: false },
    { usageLimit: null, appliesOncePerCustomer: true },
    { usageLimit: 100, appliesOncePerCustomer: true },
  ])(
    "does not mistake calculation for native coupon redemption: %j",
    (limits) => {
      expect(() =>
        assertCouponAdjustmentSupported([{ ...coupon, ...limits }]),
      ).toThrow(
        expect.objectContaining({
          code: "ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE",
        }),
      );
    },
  );
  it("rejects missing native usage metadata and preserves old persisted schemas", () => {
    const {
      usageLimit: _limit,
      appliesOncePerCustomer: _once,
      ...incomplete
    } = coupon;
    expect(orderEditCodeRuleSchema.safeParse(incomplete).success).toBe(false);
    expect(
      orderEditCodeRuleSchema.safeParse({
        ...incomplete,
        redemption: "single_use_reward",
      }).success,
    ).toBe(true);
  });
});
