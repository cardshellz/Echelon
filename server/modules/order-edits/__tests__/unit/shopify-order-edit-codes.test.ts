import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditCodes } from "../../infrastructure/shopify-order-edit-codes";
import { priceOrderEditCodes } from "../../domain/order-edit-code-pricing";
import { baseline } from "../fixtures/order-edit-service.fixture";
import type { OrderEditCodeRule } from "@shared/order-edits/order-edit-codes";
import type { OrderEditSnapshot } from "../../application/order-edit-provider";

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

describe("reward-only admission beside a native checkout reward", () => {
  const allow = {
    productDiscounts: true,
    orderDiscounts: true,
    shippingDiscounts: true,
  };
  const snapshot = (): OrderEditSnapshot => ({
    ...baseline(),
    customerId: "gid://shopify/Customer/123",
    discountRules: [
      {
        index: 0,
        type: "DiscountCodeApplication",
        targetType: "LINE_ITEM",
        allocationMethod: "ACROSS",
        targetSelection: "ALL",
        label: "ORIGINAL",
        value: { type: "fixed", amountCents: 723 },
      },
    ],
  });
  function setup() {
    const terms = new Map(
      ["ORIGINAL", "SAVED"].map((code, index) => [
        code,
        {
          codeDiscountNodeByCode: {
            id: `gid://shopify/DiscountCodeNode/${index + 1}`,
            codeDiscount: {
              __typename: "DiscountCodeBasic",
              title: code,
              status: "ACTIVE",
              startsAt: "2026-01-01T00:00:00Z",
              endsAt: null,
              usageLimit: 1 as number | null,
              appliesOncePerCustomer: true,
              discountClasses: ["ORDER"],
              codes: { nodes: [{ code }], pageInfo: { hasNextPage: false } },
              combinesWith: { ...allow },
              context: {
                __typename: "DiscountCustomers",
                customers: [{ id: snapshot().customerId }],
              },
              customerGets: {
                items: { __typename: "AllDiscountItems", allItems: true },
                value: {
                  __typename: "DiscountAmount",
                  amount: {
                    amount: index ? "2.33" : "7.23",
                    currencyCode: "USD",
                  },
                  appliesOnEachItem: false,
                },
              },
              minimumRequirement: null,
            },
          },
        },
      ]),
    );
    const rewards = {
      available: () => true,
      identify: vi.fn(async ({ codes }: { codes: string[] }) =>
        codes.map((code) => code.toUpperCase()),
      ),
      verify: vi.fn(async () => {}),
    };
    const request = vi.fn(
      async (
        query: string,
        variables: Record<string, unknown>,
      ): Promise<unknown> => {
        if (query.includes("EchelonEditCombinationRules"))
          return {
            shopifyFunctions: { nodes: [], pageInfo: { hasNextPage: false } },
            discountNodes: { nodes: [], pageInfo: { hasNextPage: false } },
          };
        if (query.includes("EchelonEditCodeCalculate"))
          return {
            draftOrderCalculate: {
              userErrors: [],
              calculatedDraftOrder: {
                lineItems: [
                  {
                    variant: { id: lines[0].variantId },
                    quantity: 1,
                    discountedTotalSet: bag("2.33"),
                  },
                ],
                platformDiscounts: [
                  {
                    code: "SAVED",
                    discountClasses: ["ORDER"],
                    totalAmountPriceSet: bag("2.33"),
                  },
                ],
                lineItemsSubtotalPrice: bag("2.33"),
                subtotalPriceSet: bag("0.00"),
              },
            },
          };
        return terms.get(String(variables.code).toUpperCase());
      },
    );
    return {
      terms,
      rewards,
      request,
      gateway: new ShopifyOrderEditCodes(request, rewards),
    };
  }

  it("verifies only the unused reward and preserves the original through current combination rules", async () => {
    const h = setup();
    const rules = await h.gateway.rules(snapshot(), ["SAVED"]);
    expect(rules).toMatchObject([{ code: "SAVED", redemption: "club_reward" }]);
    expect(h.rewards.verify).toHaveBeenCalledExactlyOnceWith({
      customerId: snapshot().customerId,
      orderId: snapshot().orderId,
      rules,
    });
    await expect(
      h.gateway.assertCombinations(snapshot(), rules, false, []),
    ).resolves.toBeUndefined();
    expect(
      h.rewards.verify.mock.calls.flatMap((call) => call),
    ).not.toContainEqual(
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({ code: "ORIGINAL" }),
        ]),
      }),
    );
  });

  it.each(["ORIGINAL", "SAVED"])(
    "still enforces %s's order-combination restriction without product discounts",
    async (code) => {
      const h = setup();
      h.terms.get(
        code,
      )!.codeDiscountNodeByCode.codeDiscount.combinesWith.orderDiscounts =
        false;
      const rules = await h.gateway.rules(snapshot(), ["SAVED"]);
      await expect(
        h.gateway.assertCombinations(snapshot(), rules, false, []),
      ).rejects.toMatchObject({
        code: "ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED",
      });
    },
  );

  it.each(["ORIGINAL", "SAVED"])(
    "does not identify %s as a reward from its name or single-use restrictions",
    async (unowned) => {
      const h = setup();
      h.rewards.identify.mockImplementation(async ({ codes }) =>
        codes.filter((code) => code !== unowned),
      );
      await expect(
        h.gateway.rules(snapshot(), ["SAVED"]),
      ).rejects.toMatchObject({
        code: "ORDER_EDIT_CODE_EXISTING_NATIVE_UNSUPPORTED",
      });
      expect(h.rewards.verify).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary coupon stacking rejected on a reward order", async () => {
    const h = setup();
    h.rewards.identify.mockImplementation(async ({ codes }) =>
      codes.filter((code) => code !== "SAVED"),
    );
    const coupon = h.terms.get("SAVED")!.codeDiscountNodeByCode.codeDiscount;
    coupon.usageLimit = null;
    coupon.appliesOncePerCustomer = false;
    await expect(h.gateway.rules(snapshot(), ["SAVED"])).rejects.toMatchObject({
      code: "ORDER_EDIT_CODE_EXISTING_NATIVE_UNSUPPORTED",
    });
  });

  it("never treats the original used code as another redeemable reward", async () => {
    const h = setup();
    await expect(
      h.gateway.rules(snapshot(), ["ORIGINAL"]),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_CODE_ALREADY_APPLIED" });
    expect(h.rewards.verify).not.toHaveBeenCalled();
  });

  it("verifies the new code on the added real variant without resubmitting the used checkout reward", async () => {
    const h = setup();
    const rules = await h.gateway.rules(snapshot(), ["SAVED"]);
    const amounts = await h.gateway.verifyNativeCalculation(
      snapshot(),
      [
        {
          ...lines[0],
          id: "original",
          productNetCents: 279,
          nativeDiscountCents: 279,
        },
        { ...lines[0], id: "added" },
      ],
      rules,
    );
    expect(amounts).toEqual([{ code: "SAVED", amountCents: 233 }]);
    expect(
      h.request.mock.calls.find(([query]) =>
        query.includes("EchelonEditCodeCalculate"),
      )?.[1],
    ).toEqual({
      input: {
        purchasingEntity: { customerId: snapshot().customerId },
        presentmentCurrencyCode: "USD",
        acceptAutomaticDiscounts: true,
        discountCodes: ["SAVED"],
        lineItems: [{ variantId: lines[0].variantId, quantity: 1 }],
      },
    });
  });

  it("reads a canonically issued reward's sole code without Shopify's lagging nested search index", async () => {
    const h = setup();
    const read = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (query, variables) => {
      const result = await read(query, variables);
      if (variables.code === "SAVED" && variables.search !== null)
        return {
          ...h.terms.get("SAVED"),
          codeDiscountNodeByCode: {
            ...h.terms.get("SAVED")!.codeDiscountNodeByCode,
            codeDiscount: {
              ...h.terms.get("SAVED")!.codeDiscountNodeByCode.codeDiscount,
              codes: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        };
      return result;
    });
    await expect(h.gateway.rules(snapshot(), ["SAVED"])).resolves.toMatchObject(
      [{ code: "SAVED" }],
    );
    expect(
      h.request.mock.calls
        .filter(([query]) => query.includes("query EchelonEditCode("))
        .map(([, variables]) => variables.search),
    ).toEqual([null, null]);
  });

  it("does not accept multiple redeem codes on a canonical single-reward node", async () => {
    const h = setup();
    h.terms.get("SAVED")!.codeDiscountNodeByCode.codeDiscount.codes.nodes.push({
      code: "ANOTHER",
    });
    await expect(h.gateway.rules(snapshot(), ["SAVED"])).rejects.toMatchObject({
      code: "ORDER_EDIT_CODE_IDENTITY_MISMATCH",
    });
  });

  it.each(["PRODUCT", "SHIPPING"])(
    "also respects the original reward's %s combination setting",
    async (kind) => {
      const h = setup();
      h.terms.get("ORIGINAL")!.codeDiscountNodeByCode.codeDiscount.combinesWith[
        kind === "PRODUCT" ? "productDiscounts" : "shippingDiscounts"
      ] = false;
      const request = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (query, variables) => {
        if (query.includes("EchelonEditCombinationRules"))
          return {
            shopifyFunctions: {
              nodes: [
                {
                  id: "fn",
                  handle:
                    kind === "PRODUCT"
                      ? "cardshellz-pricing-discount"
                      : "cardshellz-shipping-discount",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
            discountNodes: {
              nodes: [
                {
                  id: "automatic",
                  discount: {
                    __typename: "DiscountAutomaticApp",
                    title: "Member",
                    status: "ACTIVE",
                    discountClasses: [kind],
                    combinesWith: allow,
                    appDiscountType: { functionId: "fn" },
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        return request(query, variables);
      });
      const rules = await h.gateway.rules(snapshot(), ["SAVED"]);
      await expect(
        h.gateway.assertCombinations(
          snapshot(),
          rules,
          kind === "PRODUCT",
          kind === "SHIPPING" ? ["Member free shipping"] : [],
        ),
      ).rejects.toMatchObject({
        code: "ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED",
      });
    },
  );

  it("retains the existing nested search path for ordinary Shopify coupons", async () => {
    const h = setup();
    const coupon = h.terms.get("SAVED")!.codeDiscountNodeByCode.codeDiscount;
    coupon.usageLimit = null;
    coupon.appliesOncePerCustomer = false;
    await expect(
      new ShopifyOrderEditCodes(h.request).rules(
        { ...snapshot(), discountRules: [] },
        ["SAVED"],
      ),
    ).resolves.toMatchObject([{ redemption: "shopify_coupon" }]);
    expect(h.request.mock.calls[0][1].search).toBe('"SAVED"');
  });
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
  const platformDiscounts: Array<{
    code: string | null;
    discountClasses: string[];
    totalAmountPriceSet: ReturnType<typeof bag>;
  }> = [
    {
      code: "FIVE",
      discountClasses: ["ORDER"],
      totalAmountPriceSet: bag("0.11"),
    },
  ];
  const calculation = {
    lineItems: [
      {
        variant: { id: lines[0].variantId },
        quantity: 1,
        discountedTotalSet: bag("2.33"),
      },
    ],
    platformDiscounts,
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
  const codes = new ShopifyOrderEditCodes(request);
  return { codes, request, calculation };
}
describe("new-code native calculation totals", () => {
  it("sends the real customer and variants to Shopify with automatic discounts enabled", async () => {
    const h = harness();
    const nativeRule: OrderEditCodeRule = {
      ...rule,
      redemption: "shopify_coupon",
      usageLimit: null,
      appliesOncePerCustomer: false,
    };
    const snapshot = {
      ...baseline(),
      customerId: "gid://shopify/Customer/123",
    };
    await h.codes.verifyNativeCalculation(snapshot, lines, [nativeRule]);
    expect(h.request.mock.calls[0][1]).toEqual({
      input: {
        purchasingEntity: { customerId: snapshot.customerId },
        presentmentCurrencyCode: "USD",
        acceptAutomaticDiscounts: true,
        discountCodes: ["FIVE"],
        lineItems: [{ variantId: lines[0].variantId, quantity: 1 }],
      },
    });
  });
  it("accepts Shopify's automatic member savings alongside an approved coupon", async () => {
    const h = harness();
    h.calculation.platformDiscounts.push({
      code: null,
      discountClasses: ["PRODUCT"],
      totalAmountPriceSet: bag("0.46"),
    });
    expect(
      await h.codes.verifyNativeCalculation(baseline(), lines, [
        {
          ...rule,
          redemption: "shopify_coupon",
          usageLimit: 1,
          appliesOncePerCustomer: false,
        },
      ]),
    ).toEqual([{ code: "FIVE", amountCents: 11 }]);
  });
  it("reports Shopify's rejection without inventing a rewards eligibility error", async () => {
    const h = harness();
    h.calculation.platformDiscounts = [];
    await expect(
      h.codes.verifyNativeCalculation(baseline(), lines, [
        {
          ...rule,
          redemption: "shopify_coupon",
          usageLimit: 1,
          appliesOncePerCustomer: false,
        },
      ]),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_CODE_INELIGIBLE" });
  });
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
