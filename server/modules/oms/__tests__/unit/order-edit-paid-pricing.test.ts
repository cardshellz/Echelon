import { describe, expect, it } from "vitest";
import {
  buildOrderEditPaidPricing,
  type OrderEditPaidPricingInput,
} from "../../order-edit-paid-pricing";
import { paidRewardFixture } from "../../../order-edits/__tests__/fixtures/order-edit-paid-reward.fixture";

function incident(): OrderEditPaidPricingInput {
  return {
    lines: [
      {
        id: "original",
        variantId: "variant-1",
        quantity: 1,
        originalUnitPriceCents: 279,
        totalCents: 279,
      },
      {
        id: "added",
        variantId: "variant-2",
        quantity: 1,
        originalUnitPriceCents: 499,
        totalCents: 216,
      },
    ],
    originalLineIds: ["original"],
    subtotalCents: 216,
    shippingCents: 649,
    taxCents: 52,
    totalCents: 917,
    productPrices: [
      {
        id: "original",
        variantId: "variant-1",
        quantity: 1,
        retailCents: 279,
        productNetCents: 279,
        netCents: 0,
      },
      {
        id: "added",
        variantId: "variant-2",
        quantity: 1,
        retailCents: 499,
        productNetCents: 449,
        netCents: 216,
      },
    ],
    financials: {
      itemsGrossCents: 778,
      itemsDiscountCents: 562,
      itemsNetCents: 216,
      itemDiscountLabels: [],
      shippingGrossCents: 649,
      shippingDiscountCents: 0,
      shippingCents: 649,
      shippingDiscountLabels: [],
      taxCents: 52,
      taxesIncluded: false,
      totalCents: 917,
      lines: [
        { id: "original", grossCents: 279, discountCents: 279, netCents: 0 },
        { id: "added", grossCents: 499, discountCents: 283, netCents: 216 },
      ],
    },
  };
}
describe("paid-current projection prices", () => {
  it("accepts a schema-verified native reward quote and paid snapshot", () => {
    const current = paidRewardFixture(
      "00000000-0000-4000-8000-000000000001",
      new Date("2026-10-05T23:00:00Z"),
    ).lastSnapshot!;
    const result = buildOrderEditPaidPricing({
      ...current,
      originalLineIds: [current.lines[0].id],
      productPrices: current.codePricing?.lines,
    });
    expect([...result.lines.values()].map((price) => price.netCents)).toEqual([
      0, 216,
    ]);
  });
  it("uses native financial allocations and keeps the new reward out of member-price savings", () => {
    const input = incident();
    const before = structuredClone(input);
    const result = buildOrderEditPaidPricing(input);
    expect(result.grossCents).toBe(778);
    expect(result.discountCents).toBe(562);
    expect(result.lines.get("original")).toEqual({
      netCents: 0,
      unitNetCents: 0,
      discountCents: 279,
      planDiscountCents: 0,
      couponDiscountCents: 279,
    });
    expect(result.lines.get("added")).toEqual({
      netCents: 216,
      unitNetCents: 216,
      discountCents: 283,
      planDiscountCents: 50,
      couponDiscountCents: 233,
    });
    expect(input).toEqual(before);
  });
  it("retains reconciling legacy evidence without inventing a native allocation", () => {
    const result = buildOrderEditPaidPricing({
      lines: [
        {
          id: "old",
          variantId: "variant",
          quantity: 1,
          originalUnitPriceCents: 279,
          totalCents: 233,
        },
      ],
      originalLineIds: ["old"],
      subtotalCents: 233,
      shippingCents: 549,
      taxCents: 47,
      totalCents: 829,
    });
    expect(result.lines.get("old")).toMatchObject({
      netCents: 233,
      couponDiscountCents: 46,
      planDiscountCents: 0,
    });
  });
  it("fails closed when legacy raw line amounts cannot prove the native discount", () => {
    const input = incident();
    delete input.financials;
    expect(() => buildOrderEditPaidPricing(input)).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_PROJECTION_TOTALS_INVALID" }),
    );
  });
  it("does not add tax again to tax-inclusive financial evidence", () => {
    const input = incident();
    input.totalCents = 865;
    input.financials = {
      ...input.financials!,
      totalCents: 865,
      taxesIncluded: true,
    };
    expect(buildOrderEditPaidPricing(input).lines.get("added")?.netCents).toBe(
      216,
    );
  });
  it("retains an exact uneven line net while rounding only the average unit price", () => {
    const result = buildOrderEditPaidPricing({
      lines: [
        {
          id: "line",
          variantId: "variant",
          quantity: 2,
          originalUnitPriceCents: 279,
          totalCents: 465,
        },
      ],
      originalLineIds: [],
      subtotalCents: 465,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 465,
    });
    expect(result.lines.get("line")).toMatchObject({
      netCents: 465,
      unitNetCents: 233,
      discountCents: 93,
    });
  });
  it("supports a removed zero-quantity line without a surviving catalog variant", () => {
    const result = buildOrderEditPaidPricing({
      lines: [
        {
          id: "removed",
          variantId: "",
          quantity: 0,
          originalUnitPriceCents: 279,
          totalCents: 0,
        },
      ],
      originalLineIds: ["removed"],
      subtotalCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
    expect(result.lines.get("removed")?.unitNetCents).toBe(0);
  });
  it("treats code retail prices as unit prices and product nets as line totals", () => {
    const result = buildOrderEditPaidPricing({
      lines: [
        {
          id: "line",
          variantId: "variant",
          quantity: 2,
          originalUnitPriceCents: 279,
          totalCents: 366,
        },
      ],
      originalLineIds: [],
      subtotalCents: 366,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 366,
      productPrices: [
        {
          id: "line",
          variantId: "variant",
          quantity: 2,
          retailCents: 279,
          productNetCents: 466,
          netCents: 366,
        },
      ],
    });
    expect(result.lines.get("line")).toEqual({
      netCents: 366,
      unitNetCents: 183,
      discountCents: 192,
      planDiscountCents: 92,
      couponDiscountCents: 100,
    });
  });
  it.each([
    [
      "missing financial binding",
      (v: OrderEditPaidPricingInput) => {
        v.financials!.lines[0].id = "wrong";
      },
    ],
    [
      "invalid raw line amount",
      (value: OrderEditPaidPricingInput) => { value.lines[0].totalCents = Number.NaN; },
    ],
    [
      "missing product binding",
      (v: OrderEditPaidPricingInput) => {
        v.productPrices = v.productPrices!.slice(1);
      },
    ],
    [
      "duplicate product binding",
      (v: OrderEditPaidPricingInput) => {
        v.productPrices = [...v.productPrices!, v.productPrices![0]];
      },
    ],
    [
      "different variant",
      (v: OrderEditPaidPricingInput) => {
        v.productPrices = v.productPrices!.map((p, i) =>
          i === 0 ? { ...p, variantId: "wrong" } : p,
        );
      },
    ],
    [
      "different product net",
      (v: OrderEditPaidPricingInput) => {
        v.productPrices = v.productPrices!.map((p, i) =>
          i === 0 ? { ...p, netCents: 1 } : p,
        );
      },
    ],
    [
      "invalid total",
      (v: OrderEditPaidPricingInput) => {
        v.totalCents = 918;
      },
    ],
    [
      "invalid financial sum",
      (v: OrderEditPaidPricingInput) => {
        v.financials!.lines[0].netCents = 1;
      },
    ],
    [
      "negative amount",
      (v: OrderEditPaidPricingInput) => {
        v.subtotalCents = -1;
      },
    ],
    [
      "fractional amount",
      (v: OrderEditPaidPricingInput) => {
        v.subtotalCents = 216.5;
      },
    ],
    [
      "overflow",
      (v: OrderEditPaidPricingInput) => {
        v.lines = [
          {
            ...v.lines[0],
            quantity: 2,
            originalUnitPriceCents: Number.MAX_SAFE_INTEGER,
          },
        ];
        delete v.financials;
        delete v.productPrices;
      },
    ],
  ])("rejects %s", (_name, change) => {
    const input = incident();
    change(input);
    expect(() => buildOrderEditPaidPricing(input)).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_PROJECTION_TOTALS_INVALID" }),
    );
  });
});
