import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditCodes } from "../../infrastructure/shopify-order-edit-codes";
import { priceOrderEditCodes } from "../../domain/order-edit-code-pricing";
import {
  assertCouponAdjustmentSupported,
  requiresOrderEditCodeReceipt,
} from "../../domain/order-edit-coupon-boundary";
import { baseline } from "../fixtures/order-edit-service.fixture";
import type { OrderEditRewards } from "../../application/order-edit-rewards";
const code = "NOT-A-PREFIX-HEURISTIC";
function native() {
  return {
    codeDiscountNodeByCode: {
      id: "gid://shopify/DiscountCodeNode/1",
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Reward",
        status: "ACTIVE",
        startsAt: "2026-10-18T00:00:00Z",
        endsAt: "2026-10-20T00:00:00Z",
        usageLimit: 1,
        appliesOncePerCustomer: true,
        discountClasses: ["ORDER"],
        codes: { nodes: [{ code }], pageInfo: { hasNextPage: false } },
        combinesWith: {
          productDiscounts: true,
          orderDiscounts: true,
          shippingDiscounts: true,
        },
        context: {
          __typename: "DiscountCustomers",
          customers: [{ id: "gid://shopify/Customer/123" }],
        },
        customerGets: {
          items: { __typename: "AllDiscountItems", allItems: true },
          value: {
            __typename: "DiscountAmount",
            amount: { amount: "1.00", currencyCode: "USD" },
            appliesOnEachItem: false,
          },
        },
        minimumRequirement: null,
      },
    },
  };
}
function rewards(identified = [code]) {
  return {
    available: () => true,
    identify: vi.fn(async () => identified),
    verify: vi.fn(async () => {}),
  } satisfies OrderEditRewards;
}
const snapshot = () => ({
  ...baseline(),
  customerId: "gid://shopify/Customer/123",
});
describe("existing Club rewards in the order editor", () => {
  it("classifies a pasted reward only after canonical issuance lookup and verification", async () => {
    const club = rewards();
    const [rule] = await new ShopifyOrderEditCodes(
      async () => native(),
      club,
    ).rules(snapshot(), [code]);
    expect(rule.redemption).toBe("club_reward");
    expect(club.identify).toHaveBeenCalledWith({
      customerId: snapshot().customerId,
      codes: [code],
    });
    expect(club.verify).toHaveBeenCalledWith({
      customerId: snapshot().customerId,
      orderId: snapshot().orderId,
      rules: [rule],
    });
    expect(() => assertCouponAdjustmentSupported([rule])).not.toThrow();
    expect(
      requiresOrderEditCodeReceipt({
        rules: [rule],
        newCodes: [code],
      } as Parameters<typeof requiresOrderEditCodeReceipt>[0]),
    ).toBe(true);
  });
  it("keeps an ordinary customer-specific single-use coupon out of the rewards ledger", async () => {
    const club = rewards([]);
    const rules = await new ShopifyOrderEditCodes(
      async () => native(),
      club,
    ).rules(snapshot(), [code]);
    expect(rules[0].redemption).toBe("shopify_coupon");
    expect(club.verify).not.toHaveBeenCalled();
    expect(() => assertCouponAdjustmentSupported(rules)).toThrow(/usage limit/);
  });
  it("cannot bypass a used, expired or foreign reward with native eligibility alone", async () => {
    const club = rewards();
    club.verify.mockRejectedValue(new Error("canonical reward unavailable"));
    await expect(
      new ShopifyOrderEditCodes(async () => native(), club).rules(snapshot(), [
        code,
      ]),
    ).rejects.toThrow("canonical reward unavailable");
  });
  it("rejects changed single-use terms", async () => {
    const data = native();
    data.codeDiscountNodeByCode.codeDiscount.usageLimit = 2;
    await expect(
      new ShopifyOrderEditCodes(async () => data, rewards()).rules(snapshot(), [
        code,
      ]),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_REWARD_TERMS_CHANGED" });
  });
  it("does not lose unused credit when Shopify approves only part of the reward", async () => {
    const [rule] = await new ShopifyOrderEditCodes(
      async () => native(),
      rewards(),
    ).rules(snapshot(), [code]);
    const lines = [
      {
        id: "line",
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 1,
        grossCents: 200,
        productNetCents: 50,
      },
    ];
    expect(() =>
      priceOrderEditCodes(lines, [rule], [code], [{ code, amountCents: 50 }]),
    ).toThrow(/full rewards credit/);
    expect(
      priceOrderEditCodes(
        [{ ...lines[0], productNetCents: 200 }],
        [rule],
        [code],
        [{ code, amountCents: 100 }],
      ).applications,
    ).toEqual([{ code, amountCents: 100 }]);
  });
});
