import { describe, expect, it } from "vitest";
import {
  priceOrderEditDiscounts,
  type OrderEditDiscountEngineInput,
} from "../../domain/order-edit-discount-engine";

const percentageRule = (percentage = "10", key = "coupon") => ({
  key,
  label: key,
  value: { type: "percentage" as const, percentage },
});
const fixedRule = (amountCents = 2000, key = "reward") => ({
  key,
  label: key,
  value: { type: "fixed" as const, amountCents },
});
const items = (amountCents: number) => [
  { id: "item", subtotalCents: amountCents },
];

describe("order-edit discount engine", () => {
  it("rejects duplicate rule and item identities before allocating money", () => {
    expect(() =>
      priceOrderEditDiscounts({
        rules: [fixedRule(), fixedRule()],
        lines: items(10000),
      }),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID" }),
    );
    expect(() =>
      priceOrderEditDiscounts({
        rules: [],
        lines: [...items(10000), ...items(10000)],
      }),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID" }),
    );
  });
  it("handles large exact amounts, high-precision percentages and several fixed credits without losing a cent", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [percentageRule("100")],
        lines: items(Number.MAX_SAFE_INTEGER),
      }).orderDiscountCents,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      priceOrderEditDiscounts({
        rules: [
          percentageRule("0.0000000000000000000000000001"),
          fixedRule(1000, "a"),
          fixedRule(2000, "b"),
        ],
        lines: items(10000),
      }),
    ).toMatchObject({
      orderDiscountCents: 3000,
      subtotalAfterOrderDiscountsCents: 7000,
      unusedFixedCredits: [],
    });
  });
  it("recalculates a percentage while preserving one fixed reward budget", () => {
    const rules = [percentageRule(), fixedRule()];
    expect(
      priceOrderEditDiscounts({ rules, lines: items(10000) }),
    ).toMatchObject({
      orderDiscountCents: 3000,
      subtotalAfterOrderDiscountsCents: 7000,
      discounts: [{ amountCents: 1000 }, { amountCents: 2000 }],
    });
    expect(
      priceOrderEditDiscounts({ rules, lines: items(15000) }),
    ).toMatchObject({
      orderDiscountCents: 3500,
      subtotalAfterOrderDiscountsCents: 11500,
      discounts: [{ amountCents: 1500 }, { amountCents: 2000 }],
      unusedFixedCredits: [],
    });
  });
  it("uses the subtotal after product discounts and keeps shipping out of order discount arithmetic", () => {
    const result = priceOrderEditDiscounts({
      rules: [percentageRule()],
      lines: items(8000),
    });
    expect(result).toMatchObject({
      subtotalBeforeOrderDiscountsCents: 8000,
      orderDiscountCents: 800,
      subtotalAfterOrderDiscountsCents: 7200,
    });
  });
  it("calculates combined order percentages from one base instead of compounding them", () => {
    const result = priceOrderEditDiscounts({
      rules: [percentageRule("10", "a"), percentageRule("20", "b")],
      lines: items(10000),
    });
    expect(result.subtotalAfterOrderDiscountsCents).toBe(7000);
  });
  it("distributes exactly one fixed credit across all eligible items", () => {
    const result = priceOrderEditDiscounts({
      rules: [fixedRule()],
      lines: [
        { id: "a", subtotalCents: 5000 },
        { id: "b", subtotalCents: 10000 },
      ],
    });
    expect(result.allocations).toEqual([
      { lineId: "a", ruleKey: "reward", amountCents: 667 },
      { lineId: "b", ruleKey: "reward", amountCents: 1333 },
    ]);
    expect(result.orderDiscountCents).toBe(2000);
  });
  it("caps a credit at the revised eligible value and explicitly reports unused value", () => {
    expect(
      priceOrderEditDiscounts({ rules: [fixedRule()], lines: items(1500) }),
    ).toMatchObject({
      subtotalAfterOrderDiscountsCents: 0,
      orderDiscountCents: 1500,
      unusedFixedCredits: [
        { ruleKey: "reward", label: "reward", amountCents: 500 },
      ],
    });
  });
  it("caps fixed value after the accepted percentage discounts", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [percentageRule("10"), fixedRule()],
        lines: items(2000),
      }),
    ).toMatchObject({
      subtotalAfterOrderDiscountsCents: 0,
      unusedFixedCredits: [{ amountCents: 200 }],
    });
  });
  it("does not invent a priority when multiple credits exceed the revised subtotal", () => {
    expect(() =>
      priceOrderEditDiscounts({
        rules: [fixedRule(2000, "a"), fixedRule(2000, "b")],
        lines: items(3000),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ORDER_EDIT_FIXED_CREDIT_PRIORITY_REQUIRED",
      }),
    );
  });
  it.each([1199, 1200])(
    "accepts adjacent-cent native rounding totaling %s",
    (total) => {
      expect(
        priceOrderEditDiscounts({
          rules: [percentageRule()],
          lines: [
            { id: "a", subtotalCents: 1996 },
            { id: "b", subtotalCents: 9999 },
          ],
          observations: [
            { lineId: "a", ruleKey: "coupon", amountCents: 200 },
            { lineId: "b", ruleKey: "coupon", amountCents: total - 200 },
          ],
        }).orderDiscountCents,
      ).toBe(total);
    },
  );
  it.each([0, 999, 1002])(
    "rejects an incorrect percentage allocation of %s cents",
    (amountCents) => {
      expect(() =>
        priceOrderEditDiscounts({
          rules: [percentageRule()],
          lines: items(10000),
          observations: [{ lineId: "item", ruleKey: "coupon", amountCents }],
        }),
      ).toThrow(
        expect.objectContaining({
          code: "ORDER_EDIT_PERCENTAGE_DISCOUNT_MISMATCH",
        }),
      );
    },
  );
  it.each([0, 1000, 2001, 4000])(
    "rejects lost or multiplied fixed credit of %s cents",
    (amountCents) => {
      expect(() =>
        priceOrderEditDiscounts({
          rules: [fixedRule()],
          lines: items(10000),
          observations: [{ lineId: "item", ruleKey: "reward", amountCents }],
        }),
      ).toThrow(
        expect.objectContaining({ code: "ORDER_EDIT_FIXED_DISCOUNT_MISMATCH" }),
      );
    },
  );
  it("accepts Shopify's retained fixed allocation when the exact budget and line bounds hold", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [fixedRule()],
        lines: [
          { id: "a", subtotalCents: 5000 },
          { id: "b", subtotalCents: 10000 },
        ],
        observations: [
          { lineId: "a", ruleKey: "reward", amountCents: 1000 },
          { lineId: "b", ruleKey: "reward", amountCents: 1000 },
        ],
      }).orderDiscountCents,
    ).toBe(2000);
  });
  it.each([
    { lineId: "unknown", ruleKey: "coupon", amountCents: 1000 },
    { lineId: "item", ruleKey: "unknown", amountCents: 1000 },
  ])("rejects unknown item or discount identities", (entry) => {
    expect(() =>
      priceOrderEditDiscounts({
        rules: [percentageRule()],
        lines: items(10000),
        observations: [entry],
      }),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID" }),
    );
  });
  it("rejects duplicate evidence instead of summing it twice", () => {
    const entry = { lineId: "item", ruleKey: "coupon", amountCents: 1000 };
    expect(() =>
      priceOrderEditDiscounts({
        rules: [percentageRule()],
        lines: items(10000),
        observations: [entry, entry],
      }),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID" }),
    );
  });
  it("rejects combined allocations exceeding a line even when their order totals match", () => {
    expect(() =>
      priceOrderEditDiscounts({
        rules: [percentageRule(), fixedRule()],
        lines: [
          { id: "a", subtotalCents: 1000 },
          { id: "b", subtotalCents: 9000 },
        ],
        observations: [
          { lineId: "a", ruleKey: "coupon", amountCents: 100 },
          { lineId: "b", ruleKey: "coupon", amountCents: 900 },
          { lineId: "a", ruleKey: "reward", amountCents: 2000 },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_OVERALLOCATED" }),
    );
  });
  it.each(["-1", "101", "100.0001", "NaN", "Infinity", "1e2", "10%"])(
    "rejects invalid percentage %s",
    (percentage) => {
      expect(() =>
        priceOrderEditDiscounts({
          rules: [percentageRule(percentage)],
          lines: items(10000),
        }),
      ).toThrow();
    },
  );
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid money %s",
    (amountCents) => {
      expect(() =>
        priceOrderEditDiscounts({
          rules: [fixedRule(amountCents)],
          lines: items(10000),
        }),
      ).toThrow(
        expect.objectContaining({ code: "ORDER_EDIT_DISCOUNT_INPUT_INVALID" }),
      );
    },
  );
  it("supports exact decimal percentages without floating-point money", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [percentageRule("12.5")],
        lines: items(10000),
      }).orderDiscountCents,
    ).toBe(1250);
  });
  it("rejects sum overflow and over-100 combinations even on tiny amounts", () => {
    expect(() =>
      priceOrderEditDiscounts({
        rules: [],
        lines: [
          { id: "a", subtotalCents: Number.MAX_SAFE_INTEGER },
          { id: "b", subtotalCents: 1 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "ORDER_EDIT_MONEY_INVALID" }));
    expect(() =>
      priceOrderEditDiscounts({
        rules: [percentageRule("60", "a"), percentageRule("60", "b")],
        lines: items(1),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ORDER_EDIT_DISCOUNT_COMBINATION_INVALID",
      }),
    );
  });
  it("keeps a valid combined 100-percent discount within a one-cent item", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [percentageRule("50", "a"), percentageRule("50", "b")],
        lines: items(1),
      }).subtotalAfterOrderDiscountsCents,
    ).toBe(0);
  });
  it("accepts zero-valued items and credits without division by zero", () => {
    expect(
      priceOrderEditDiscounts({
        rules: [percentageRule("0"), fixedRule(0)],
        lines: items(0),
      }),
    ).toMatchObject({
      orderDiscountCents: 0,
      subtotalAfterOrderDiscountsCents: 0,
      unusedFixedCredits: [],
    });
  });
  it("is deterministic, preserves inputs and reconciles each allocated cent", () => {
    const input: OrderEditDiscountEngineInput = {
      rules: [percentageRule("12.5"), fixedRule(500)],
      lines: [
        { id: "b", subtotalCents: 2999 },
        { id: "a", subtotalCents: 1001 },
      ],
    };
    const before = structuredClone(input);
    const result = priceOrderEditDiscounts(input);
    expect(priceOrderEditDiscounts(input)).toEqual(result);
    expect(input).toEqual(before);
    const reversed = priceOrderEditDiscounts({
      ...input,
      lines: [...input.lines].reverse(),
      rules: [...input.rules].reverse(),
    });
    expect(reversed.discounts).toEqual(result.discounts);
    expect(
      reversed.allocations.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ).toEqual(
      [...result.allocations].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    );
    expect(
      result.allocations.reduce((sum, entry) => sum + entry.amountCents, 0),
    ).toBe(result.orderDiscountCents);
    expect(
      result.orderDiscountCents + result.subtotalAfterOrderDiscountsCents,
    ).toBe(result.subtotalBeforeOrderDiscountsCents);
  });
});
