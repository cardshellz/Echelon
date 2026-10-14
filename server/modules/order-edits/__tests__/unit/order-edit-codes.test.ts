import { describe, expect, it } from "vitest";
import { assertOrderEditCodeCombinations } from "../../domain/order-edit-code-combinations";
import {
  priceOrderEditCodes,
  splitOrderEditCodeLine,
} from "../../domain/order-edit-code-pricing";
import { readOrderEditCodeRule } from "../../infrastructure/shopify-order-edit-codes";
import { orderEditQuoteInputSchema } from "@shared/order-edits/order-edit.contract";
import {
  orderEditRequestedCodesSchema,
  type OrderEditCodeRule,
} from "@shared/order-edits/order-edit-codes";

const allow = {
  productDiscounts: true,
  orderDiscounts: true,
  shippingDiscounts: true,
};
const coupon: OrderEditCodeRule = {
  discountId: "gid://shopify/DiscountCodeNode/1",
  code: "TEN",
  classes: ["ORDER"],
  combinesWith: allow,
  value: { type: "percentage", percentage: "10" },
  fingerprint: "a".repeat(64),
  redemption: "unlimited",
};
const reward: OrderEditCodeRule = {
  ...coupon,
  discountId: "gid://shopify/DiscountCodeNode/2",
  code: "REWARD",
  value: { type: "fixed", amountCents: 1900 },
  redemption: "single_use_reward",
};
const product = {
  id: "product",
  label: "Member prices",
  classes: ["PRODUCT" as const],
  combinesWith: allow,
};
const order = {
  id: coupon.discountId,
  label: coupon.code,
  classes: coupon.classes,
  combinesWith: allow,
};
const now = new Date("2026-10-14T12:00:00Z");
function native() {
  return {
    codeDiscountNodeByCode: {
      id: coupon.discountId,
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Ten percent",
        status: "ACTIVE",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: null,
        usageLimit: null,
        appliesOncePerCustomer: false,
        asyncUsageCount: 0,
        discountClasses: ["ORDER"],
        codes: { nodes: [{ code: "TEN" }], pageInfo: { hasNextPage: false } },
        codesCount: { count: 1, precision: "EXACT" },
        combinesWith: { ...allow },
        context: { __typename: "DiscountBuyerSelectionAll" },
        customerGets: {
          items: { __typename: "AllDiscountItems", allItems: true },
          value: { __typename: "DiscountPercentage", percentage: 0.1 },
        },
        minimumRequirement: null,
      },
    },
  };
}
describe("new-code admission and exact pricing", () => {
  it("requires both sides of each combination", () => {
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [product],
        proposed: [order],
      }),
    ).not.toThrow();
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [
          { ...product, combinesWith: { ...allow, orderDiscounts: false } },
        ],
        proposed: [order],
      }),
    ).toThrow(/can't be combined/);
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [product],
        proposed: [
          { ...order, combinesWith: { ...allow, productDiscounts: false } },
        ],
      }),
    ).toThrow(/can't be combined/);
  });
  it("checks coupon/rewards pairs and all classes of a multi-class existing function", () => {
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [],
        proposed: [
          order,
          {
            ...order,
            id: "reward",
            label: "Reward",
            combinesWith: { ...allow, orderDiscounts: false },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [{ ...product, classes: ["PRODUCT", "SHIPPING"] }],
        proposed: [
          { ...order, combinesWith: { ...allow, shippingDiscounts: false } },
        ],
      }),
    ).toThrow();
  });
  it("never stacks two shipping discounts or unproved same-line product discounts", () => {
    for (const kind of ["SHIPPING", "PRODUCT"] as const)
      expect(() =>
        assertOrderEditCodeCombinations({
          existing: [{ ...product, classes: [kind] }],
          proposed: [{ ...order, classes: [kind] }],
        }),
      ).toThrow();
  });
  it("fails closed for missing metadata and duplicate native discount IDs", () => {
    expect(() =>
      assertOrderEditCodeCombinations({
        existing: [{ ...product, combinesWith: undefined }],
        proposed: [order],
      } as never),
    ).toThrow(/could not verify/);
    expect(() =>
      assertOrderEditCodeCombinations({ existing: [order], proposed: [order] }),
    ).toThrow(/already/);
  });
  it("keeps a fixed reward once while quantities and member savings scale", () => {
    const line = {
      id: "line",
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 2,
      grossCents: 29998,
      productNetCents: 23998,
    };
    const before = structuredClone(line);
    const result = priceOrderEditCodes(
      [line],
      [coupon, reward],
      ["TEN", "REWARD"],
    );
    expect(result.applications).toEqual(
      expect.arrayContaining([
        { code: "REWARD", amountCents: 1900 },
        { code: "TEN", amountCents: 2400 },
      ]),
    );
    expect(result.lines[0].netCents).toBe(19698);
    expect(line).toEqual(before);
    const doubled = priceOrderEditCodes(
      [{ ...line, quantity: 4, grossCents: 59996, productNetCents: 47996 }],
      [coupon, reward],
      [],
    );
    expect(
      doubled.applications.find((code) => code.code === "REWARD")?.amountCents,
    ).toBe(1900);
    expect(
      doubled.applications.find((code) => code.code === "TEN")?.amountCents,
    ).toBe(4800);
  });
  it("preserves every penny across native row splits and never invents product price fractions", () => {
    for (let quantity = 1; quantity <= 20; quantity++) {
      for (let saving = 0; saving < quantity; saving++) {
        const groups = splitOrderEditCodeLine({
          id: "line",
          sourceId: "line",
          variantId: "gid://shopify/ProductVariant/1",
          quantity,
          retailCents: 1000,
          productNetCents: quantity * 800,
          netCents: quantity * 800 - saving,
        });
        expect(groups.reduce((sum, group) => sum + group.quantity, 0)).toBe(
          quantity,
        );
        expect(groups.reduce((sum, group) => sum + group.netCents, 0)).toBe(
          quantity * 800 - saving,
        );
        expect(
          groups.reduce((sum, group) => sum + group.productNetCents, 0),
        ).toBe(quantity * 800);
        expect(groups.every((group) => group.quantity > 0)).toBe(true);
      }
    }
  });
  it("rejects zero savings, unused rewards, fractional amounts, and duplicate codes", () => {
    const line = {
      id: "line",
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 1,
      grossCents: 1000,
      productNetCents: 800,
    };
    expect(() => priceOrderEditCodes([line], [reward], [reward.code])).toThrow(
      /full rewards credit/,
    );
    expect(() =>
      priceOrderEditCodes(
        [line],
        [{ ...coupon, value: { type: "percentage", percentage: "0" } }],
        [coupon.code],
      ),
    ).toThrow();
    expect(() =>
      splitOrderEditCodeLine({
        ...line,
        sourceId: "line",
        retailCents: 1000,
        netCents: 0.5,
      }),
    ).toThrow();
    expect(
      orderEditRequestedCodesSchema.safeParse([" TEN ", "ten"]).success,
    ).toBe(false);
    expect(orderEditRequestedCodesSchema.safeParse(["A\nB"]).success).toBe(
      false,
    );
  });
  it("accepts a code-only plan without changing legacy request JSON", () => {
    const legacy = {
      connectionId: 1,
      omsOrderId: 1,
      expectedRevision: "revision",
      requestKey: "11111111-1111-4111-8111-111111111111",
      changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }],
      additions: [],
    };
    expect(JSON.stringify(orderEditQuoteInputSchema.parse(legacy))).toBe(
      JSON.stringify(legacy),
    );
    expect(
      orderEditQuoteInputSchema.safeParse({
        ...legacy,
        changes: [],
        discountCodes: ["TEN"],
      }).success,
    ).toBe(true);
    expect(
      orderEditQuoteInputSchema.safeParse({
        ...legacy,
        changes: [],
        discountCodes: [],
      }).success,
    ).toBe(false);
  });
  it("reads actual issued terms and hashes changes to combinability", () => {
    const input = native();
    const before = structuredClone(input);
    const first = readOrderEditCodeRule(
      input,
      "ten",
      "gid://shopify/Customer/1",
      now,
    );
    expect(first.value).toEqual({ type: "percentage", percentage: "10" });
    expect(first.redemption).toBe("unlimited");
    expect(input).toEqual(before);
    input.codeDiscountNodeByCode.codeDiscount.combinesWith.orderDiscounts = false;
    expect(
      readOrderEditCodeRule(input, "TEN", "gid://shopify/Customer/1", now)
        .fingerprint,
    ).not.toBe(first.fingerprint);
  });
  it.each([1, 10, 100])(
    "rejects shared finite usage limit %s",
    (usageLimit) => {
      const input = native();
      (
        input.codeDiscountNodeByCode.codeDiscount as Record<string, unknown>
      ).usageLimit = usageLimit;
      expect(() =>
        readOrderEditCodeRule(input, "TEN", "gid://shopify/Customer/1", now),
      ).toThrow(/usage limit/);
    },
  );
  it("rejects once-per-customer public codes, missing combinations, expired and unsupported scopes", () => {
    const cases = [native(), native(), native(), native()];
    cases[0].codeDiscountNodeByCode.codeDiscount.appliesOncePerCustomer = true;
    (
      cases[1].codeDiscountNodeByCode.codeDiscount as Record<string, unknown>
    ).combinesWith = null;
    cases[2].codeDiscountNodeByCode.codeDiscount.status = "EXPIRED";
    cases[3].codeDiscountNodeByCode.codeDiscount.discountClasses = ["PRODUCT"];
    for (const value of cases)
      expect(() =>
        readOrderEditCodeRule(value, "TEN", "gid://shopify/Customer/1", now),
      ).toThrow();
  });
});
