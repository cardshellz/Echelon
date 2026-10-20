import { describe, expect, it } from "vitest";
import {
  priceOrderEditCodes,
  splitOrderEditCodeLine,
  presentOrderEditCodeFinancials,
} from "../../domain/order-edit-code-pricing";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";
import { presentOrderEditCodeBreakdown } from "../../application/order-edit-code-presentation";
import {
  allocateOrderEditNativeCodePricing,
  referenceOrderEditCodePricing,
} from "../../domain/order-edit-native-code-allocation";
import {
  orderEditCodePricingSchema,
  type OrderEditCodeRule,
} from "@shared/order-edits/order-edit-codes";

const reward: OrderEditCodeRule = {
  discountId: "gid://shopify/DiscountCodeNode/1",
  code: "SAVED-REWARD",
  classes: ["ORDER"],
  combinesWith: {
    productDiscounts: true,
    orderDiscounts: true,
    shippingDiscounts: true,
  },
  value: { type: "fixed", amountCents: 100 },
  fingerprint: "a".repeat(64),
  redemption: "club_reward",
  usageLimit: 1,
  appliesOncePerCustomer: true,
};
const original = {
  id: "original",
  variantId: "gid://shopify/ProductVariant/1",
  quantity: 1,
  grossCents: 279,
  productNetCents: 233,
};
const added = {
  id: "added",
  variantId: "gid://shopify/ProductVariant/2",
  quantity: 1,
  grossCents: 499,
  productNetCents: 449,
};
const price = (lines = [original, added], rules = [reward]) =>
  priceOrderEditCodes(
    lines,
    rules,
    rules.map((rule) => rule.code),
  );

describe("saved rewards alongside an already-used native reward", () => {
  const native = {
    ...original,
    productNetCents: 279,
    nativeDiscountCents: 279,
  };
  const extra = { ...added, grossCents: 279, productNetCents: 233 };
  const saved = {
    ...reward,
    value: { type: "fixed" as const, amountCents: 233 },
  };
  const retained = [
    {
      key: "code:ORIGINAL",
      label: "ORIGINAL",
      amountCents: 279,
      value: { type: "fixed" as const, amountCents: 723 },
    },
  ];
  const pricing = () =>
    allocateOrderEditNativeCodePricing(
      priceOrderEditCodes(
        [native, extra],
        [saved],
        [saved.code],
        undefined,
        retained,
      ),
      [],
    );

  it("keeps the original $2.79 allocation and applies only the saved $2.33 to added Club-priced merchandise", () => {
    const result = pricing();
    expect(result.lines).toMatchObject([
      {
        id: original.id,
        productNetCents: 279,
        nativeDiscountCents: 279,
        netCents: 0,
      },
      { id: added.id, productNetCents: 233, netCents: 0 },
    ]);
    expect(result.applications).toEqual([
      { code: saved.code, amountCents: 233 },
    ]);
    expect(result.rules).toEqual([saved]);
    expect(result.retainedNativeDiscounts).toEqual(retained);
    expect(splitOrderEditCodeLine(result.lines[0])).toEqual([
      { quantity: 1, unitCents: 279, productNetCents: 279, netCents: 0 },
    ]);
    expect(referenceOrderEditCodePricing(result)).toEqual(result);
  });

  it("shows both order discounts separately while keeping the Club product price", () => {
    const result = pricing();
    const financials = buildOrderEditFinancials({
      lines: [
        { id: original.id, grossCents: 279, netCents: 0 },
        { id: added.id, grossCents: 279, netCents: 0 },
      ],
      itemsNetCents: 0,
      itemDiscountLabels: [],
      shippingGrossCents: 549,
      shippingCents: 549,
      shippingDiscountLabels: [],
      taxCents: 33,
      taxesIncluded: false,
      totalCents: 582,
    });
    const shown = presentOrderEditCodeBreakdown(
      presentOrderEditCodeFinancials(financials, result),
      result,
    )!;
    expect(shown.orderDiscounts).toEqual([
      ...retained,
      {
        key: `code:${saved.code}`,
        label: saved.code,
        amountCents: 233,
        value: saved.value,
      },
    ]);
    expect(shown.lines.map((line) => line.productNetCents)).toEqual([279, 233]);
    expect(shown.itemDiscounts).toContainEqual({
      key: "product",
      label: "Product discounts",
      amountCents: 46,
      value: { type: "allocated" },
    });
  });

  it("never moves the old face value onto extra merchandise or spends it again", () => {
    expect(() =>
      priceOrderEditCodes([native], [saved], [saved.code], undefined, retained),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_CODE_UNUSED_CREDIT" }),
    );
    for (const mutate of [
      (value: ReturnType<typeof pricing>) => {
        value.retainedNativeDiscounts![0].amountCents = 723;
      },
      (value: ReturnType<typeof pricing>) => {
        delete value.lines[0].nativeDiscountCents;
      },
      (value: ReturnType<typeof pricing>) => {
        value.lines[0].replacesAutomaticDiscount = true;
      },
      (value: ReturnType<typeof pricing>) => {
        value.retainedNativeDiscounts![0].label = saved.code;
      },
    ]) {
      const forged = pricing();
      mutate(forged);
      expect(orderEditCodePricingSchema.safeParse(forged).success).toBe(false);
    }
  });

  it("does not discount an original native-discounted row when added merchandise cannot carry the new reward", () => {
    const partial = { ...native, nativeDiscountCents: 100 };
    const existing = [{ ...retained[0], amountCents: 100 }];
    const input = priceOrderEditCodes(
      [partial, { ...extra, productNetCents: 100 }],
      [saved],
      [saved.code],
      undefined,
      existing,
    );
    expect(() => allocateOrderEditNativeCodePricing(input, [])).toThrow(
      expect.objectContaining({
        code: "ORDER_EDIT_CODE_NATIVE_ALLOCATION_UNSUPPORTED",
      }),
    );
  });
});

describe("native order-discount allocation around automatic prices", () => {
  it("keeps the existing allocation when no original line is protected", () => {
    const input = price();
    expect(allocateOrderEditNativeCodePricing(input, [])).toEqual(input);
  });

  it("rejects a preserved-discount claim that is not bound to a protected original", () => {
    const protectedPricing = allocateOrderEditNativeCodePricing(price(), [
      "original",
    ]);
    expect(() =>
      allocateOrderEditNativeCodePricing(protectedPricing, []),
    ).toThrow(
      expect.objectContaining({
        code: "ORDER_EDIT_CODE_ALLOCATION_IDENTITY_INVALID",
      }),
    );
  });

  it("rejects conflicting variants or retail prices within the same logical item", () => {
    for (const override of [
      { variantId: original.variantId },
      { retailCents: 500 },
    ]) {
      const native = allocateOrderEditNativeCodePricing(
        price([
          original,
          { ...added, quantity: 3, grossCents: 1497, productNetCents: 1347 },
        ]),
        ["original"],
      );
      const split = {
        ...native,
        lines: native.lines.flatMap((line) =>
          splitOrderEditCodeLine(line).map((group, index) => ({
            ...line,
            quantity: group.quantity,
            productNetCents: group.productNetCents,
            netCents: group.netCents,
            id: `${line.id}-${index}`,
            ...(line.id === added.id && index === 1 ? override : {}),
          })),
        ),
      };
      expect(() => referenceOrderEditCodePricing(split)).toThrow(
        expect.objectContaining({
          code: "ORDER_EDIT_CODE_ALLOCATION_IDENTITY_INVALID",
        }),
      );
    }
  });

  it("preserves the $2.33 Club line and represents the full $1 on the added $4.49 item", () => {
    const input = price();
    const unchanged = structuredClone(input);
    const result = allocateOrderEditNativeCodePricing(input, ["original"]);
    expect(result.lines).toMatchObject([
      {
        id: "original",
        netCents: 233,
        productNetCents: 233,
        preserveAutomaticDiscount: true,
      },
      { id: "added", netCents: 349, productNetCents: 449 },
    ]);
    expect(result.applications).toEqual([
      { code: "SAVED-REWARD", amountCents: 100 },
    ]);
    expect(result.rules).toEqual(input.rules);
    expect(input).toEqual(unchanged);
    expect(referenceOrderEditCodePricing(result)).toEqual(input);
  });

  it("retains a percentage's approved order saving without recalculating it on a smaller base", () => {
    const coupon: OrderEditCodeRule = {
      ...reward,
      code: "TEN",
      value: { type: "percentage", percentage: "10" },
      redemption: "shopify_coupon",
      usageLimit: null,
      appliesOncePerCustomer: false,
    };
    const result = allocateOrderEditNativeCodePricing(
      price(undefined, [coupon]),
      ["original"],
    );
    expect(result.applications[0].amountCents).toBe(68);
    expect(result.lines.map((line) => line.netCents)).toEqual([233, 381]);
    expect(referenceOrderEditCodePricing(result).applications).toEqual(
      result.applications,
    );
  });

  it.each([
    { lines: [original] },
    { lines: [original, { ...added, grossCents: 99, productNetCents: 99 }] },
    { lines: [original, { ...added, grossCents: 0, productNetCents: 0 }] },
  ])(
    "explicitly replaces original variants when editable capacity cannot carry the full reward",
    ({ lines }) => {
      const input = price(lines);
      const result = allocateOrderEditNativeCodePricing(input, ["original"]);
      expect(result.lines[0]).toMatchObject({
        replacesAutomaticDiscount: true,
      });
      expect(result.lines[0].preserveAutomaticDiscount).toBeUndefined();
      expect(result.lines.map((line) => line.netCents)).toEqual(
        input.lines.map((line) => line.netCents),
      );
      expect(result.applications).toEqual([
        { code: reward.code, amountCents: 100 },
      ]);
    },
  );

  it("can use exact capacity without a negative price or partial reward", () => {
    const result = allocateOrderEditNativeCodePricing(
      price([original, { ...added, grossCents: 100, productNetCents: 100 }]),
      ["original"],
    );
    expect(result.lines.map((line) => line.netCents)).toEqual([233, 0]);
  });
  it("keeps both saved rewards at full value when merchandise covers their combined amount", () => {
    const other = {
      ...reward,
      code: "OTHER-REWARD",
      discountId: "gid://shopify/DiscountCodeNode/2",
      value: { type: "fixed" as const, amountCents: 366 },
    };
    const input = price(
      [{ ...original, quantity: 2, grossCents: 558, productNetCents: 466 }],
      [reward, other],
    );
    const result = allocateOrderEditNativeCodePricing(input, ["original"]);
    expect(result.applications).toEqual(
      expect.arrayContaining([
        { code: reward.code, amountCents: 100 },
        { code: other.code, amountCents: 366 },
      ]),
    );
    expect(result.lines).toMatchObject([
      { productNetCents: 466, netCents: 0, replacesAutomaticDiscount: true },
    ]);
  });

  it("keeps penny distribution deterministic regardless of input order", () => {
    const third = {
      ...added,
      id: "third",
      variantId: "gid://shopify/ProductVariant/3",
    };
    const input = price([original, added, third]);
    const first = allocateOrderEditNativeCodePricing(input, ["original"]);
    const second = allocateOrderEditNativeCodePricing(
      { ...input, lines: [...input.lines].reverse() },
      ["original"],
    );
    expect([...first.lines].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [...second.lines].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it("rebuilds tax-reference prices from logical items after exact-cent native splits", () => {
    const input = price([
      original,
      { ...added, quantity: 3, grossCents: 1497, productNetCents: 1347 },
    ]);
    const native = allocateOrderEditNativeCodePricing(input, ["original"]);
    const split = {
      ...native,
      lines: native.lines.flatMap((line) =>
        splitOrderEditCodeLine(line).map((group, index) => ({
          ...line,
          quantity: group.quantity,
          productNetCents: group.productNetCents,
          netCents: group.netCents,
          id: `${line.id}-${index}`,
        })),
      ),
    };
    expect(referenceOrderEditCodePricing(split)).toEqual(input);
  });

  it("does not label a further discounted line as preserving an automatic discount", () => {
    const invalid = price();
    invalid.lines[0].preserveAutomaticDiscount = true;
    expect(orderEditCodePricingSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates identities, scope and financial evidence", () => {
    expect(() =>
      allocateOrderEditNativeCodePricing(price(), ["original", "original"]),
    ).toThrow();
    const wrongScope = price();
    wrongScope.rules[0].classes = ["PRODUCT"];
    expect(() =>
      allocateOrderEditNativeCodePricing(wrongScope, ["original"]),
    ).toThrow(
      expect.objectContaining({
        code: "ORDER_EDIT_CODE_ALLOCATION_SCOPE_INVALID",
      }),
    );
    const invalid = price();
    invalid.lines[0].netCents = -1;
    expect(() =>
      allocateOrderEditNativeCodePricing(invalid, ["original"]),
    ).toThrow();
  });
});
