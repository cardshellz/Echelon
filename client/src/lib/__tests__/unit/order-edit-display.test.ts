import { describe, expect, it } from "vitest";
import {
  exactOrderEditUnitPrice,
  groupOrderEditDisplayLines,
  orderEditTaxDisplay,
  orderEditDiscountBreakdown,
} from "../../order-edit-display";
import { orderEditFinancialsSchema } from "@shared/order-edits/order-edit-financials";
import {
  orderEditOperationSchema,
  type OrderEditOperation,
} from "@shared/order-edits/order-edit.contract";

type Line = OrderEditOperation["lines"][number];

describe("Club pricing before separately allocated order codes", () => {
  const discount = (key: string, amountCents: number) => ({
    key,
    label: key === "club" ? "Shellz Club savings" : key,
    amountCents,
    value: { type: "allocated" as const },
  });
  function financials(quantity = 1, orderAmounts = [100, 100, 23]) {
    const orderDiscounts = orderAmounts.map((amount, index) =>
      discount(`code:${index}`, amount),
    );
    const orderSaving = orderAmounts.reduce((sum, value) => sum + value, 0);
    const net = 233 * quantity - orderSaving;
    return orderEditFinancialsSchema.parse({
      itemsGrossCents: 279 * quantity,
      itemsDiscountCents: 46 * quantity + orderSaving,
      itemsNetCents: net,
      itemDiscountLabels: [
        "Shellz Club savings",
        ...orderDiscounts.map((entry) => entry.label),
      ],
      // Deliberately interleave the source allocations. Presentation must use
      // the explicit orderDiscounts contract, not array order or a code prefix.
      itemDiscounts: [
        orderDiscounts[0],
        discount("club", 46 * quantity),
        ...orderDiscounts.slice(1),
      ].filter(Boolean),
      orderDiscounts,
      shippingGrossCents: 0,
      shippingDiscountCents: 0,
      shippingCents: 0,
      shippingDiscountLabels: [],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: net,
      lines: [
        {
          id: "sleeves",
          grossCents: 279 * quantity,
          discountCents: 46 * quantity + orderSaving,
          netCents: net,
          productNetCents: 233 * quantity,
        },
      ],
    });
  }

  it("keeps Club savings first and each reward/coupon allocation independent", () => {
    const evidence = financials();
    const before = structuredClone(evidence);
    expect(orderEditDiscountBreakdown(evidence)).toEqual({
      kind: "separate",
      productDiscounts: [discount("club", 46)],
      orderDiscounts: [
        discount("code:0", 100),
        discount("code:1", 100),
        discount("code:2", 23),
      ],
      subtotalBeforeOrderDiscountsCents: 233,
    });
    expect(evidence).toEqual(before);
  });

  it.each<{ quantity: number; amounts: number[]; expected: number }>([
    { quantity: 1, amounts: [233], expected: 233 },
    { quantity: 4, amounts: [100, 300], expected: 932 },
    { quantity: 1, amounts: [], expected: 233 },
  ])(
    "retains Club item prices for quantity $quantity and codes $amounts",
    ({ quantity, amounts, expected }) => {
      const result = orderEditDiscountBreakdown(financials(quantity, amounts));
      expect(result.kind).toBe("separate");
      if (result.kind !== "separate")
        throw new Error("Expected verified stages");
      expect(result.subtotalBeforeOrderDiscountsCents).toBe(expected);
      expect(
        exactOrderEditUnitPrice(
          result.subtotalBeforeOrderDiscountsCents,
          quantity,
        ),
      ).toBe(233);
    },
  );

  it("keeps unverifiable legacy breakdowns intact rather than relabeling rewards as Club savings", () => {
    const { orderDiscounts: _orders, ...legacy } = financials();
    expect(orderEditDiscountBreakdown(legacy)).toEqual({
      kind: "aggregate",
      discounts: legacy.itemDiscounts,
    });
    const { itemDiscounts: _items, ...aggregate } = legacy;
    expect(orderEditDiscountBreakdown(aggregate)).toEqual({
      kind: "aggregate",
      discounts: [
        {
          key: "aggregate",
          label: aggregate.itemDiscountLabels.join(", "),
          amountCents: 269,
          value: { type: "allocated" },
        },
      ],
    });
  });

  it("rejects incomplete or inconsistent stage evidence at the response boundary", () => {
    const evidence = financials();
    for (const invalid of [
      { ...evidence, orderDiscounts: evidence.orderDiscounts!.slice(1) },
      { ...evidence, lines: [{ ...evidence.lines[0], productNetCents: 279 }] },
      {
        ...evidence,
        itemDiscounts: [...evidence.itemDiscounts!, evidence.itemDiscounts![0]],
      },
    ])
      expect(orderEditFinancialsSchema.safeParse(invalid).success).toBe(false);
  });

  it.each([
    { gross: 279, saving: 100, subtotal: 279 },
    { gross: 0, saving: 0, subtotal: 0 },
    {
      gross: Number.MAX_SAFE_INTEGER,
      saving: Number.MAX_SAFE_INTEGER,
      subtotal: Number.MAX_SAFE_INTEGER,
    },
  ])(
    "retains exact non-member, zero and maximum-safe amounts: $gross / $saving",
    ({ gross, saving, subtotal }) => {
      const orders = saving ? [discount("ordinary-code", saving)] : [];
      const value = orderEditFinancialsSchema.parse({
        ...financials(1, []),
        itemsGrossCents: gross,
        itemsDiscountCents: saving,
        itemsNetCents: gross - saving,
        itemDiscounts: orders,
        orderDiscounts: orders,
        itemDiscountLabels: orders.map((entry) => entry.label),
        totalCents: gross - saving,
        lines: [
          {
            id: "non-member",
            grossCents: gross,
            discountCents: saving,
            netCents: gross - saving,
            productNetCents: gross,
          },
        ],
      });
      expect(orderEditDiscountBreakdown(value)).toEqual({
        kind: "separate",
        productDiscounts: [],
        orderDiscounts: orders,
        subtotalBeforeOrderDiscountsCents: subtotal,
      });
    },
  );
});

describe("verified tax rate presentation", () => {
  it.each([6, 8.875, 0])(
    "shows Shopify's %s percent rate without inferring a taxable basis",
    (ratePercentage) => {
      expect(
        orderEditTaxDisplay({
          taxesIncluded: false,
          taxLines: [{ title: "State tax", ratePercentage, amountCents: 877 }],
        }),
      ).toEqual({ label: `Tax (${ratePercentage}%)`, details: [] });
    },
  );
  it("keeps included taxes and missing legacy rates explicit", () => {
    expect(orderEditTaxDisplay({ taxesIncluded: false })).toEqual({
      label: "Tax",
      details: [],
    });
    expect(orderEditTaxDisplay({ taxesIncluded: true, taxLines: [] })).toEqual({
      label: "Tax (included)",
      details: [],
    });
    expect(
      orderEditTaxDisplay({
        taxesIncluded: false,
        taxLines: [{ title: "Tax", ratePercentage: null, amountCents: 877 }],
      }),
    ).toEqual({ label: "Tax", details: [] });
    expect(
      orderEditTaxDisplay({
        taxesIncluded: true,
        taxLines: [{ title: "Tax", ratePercentage: 6, amountCents: 877 }],
      }),
    ).toEqual({ label: "Tax (6%, included)", details: [] });
  });
  it("names multiple tax rates rather than claiming they have the same taxable basis", () => {
    expect(
      orderEditTaxDisplay({
        taxesIncluded: false,
        taxLines: [
          { title: "State", ratePercentage: 6, amountCents: 600 },
          { title: "County", ratePercentage: 1, amountCents: 48 },
          { title: "Other tax", ratePercentage: null, amountCents: 5 },
        ],
      }),
    ).toEqual({
      label: "Tax",
      details: ["State 6%", "County 1%", "Other tax"],
    });
  });
});

describe("exact net unit price presentation", () => {
  it.each([
    [233, 1, 233],
    [932, 4, 233],
    [0, 3, 0],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
  ])(
    "uses the verified %i-cent net total for %i units",
    (total, quantity, expected) => {
      expect(exactOrderEditUnitPrice(total, quantity)).toBe(expected);
    },
  );
  it.each([
    [700, 3],
    [233, 0],
    [233, -1],
    [-1, 1],
    [1.5, 1],
    [233, 1.5],
    [NaN, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])(
    "never invents a rounded unit price for total %s and quantity %s",
    (total, quantity) => {
      expect(exactOrderEditUnitPrice(total, quantity)).toBeNull();
    },
  );
});
const line: Line = {
  id: "original",
  variantId: "gid://shopify/ProductVariant/10",
  title: "Sleeves",
  variantTitle: "Pack of 100",
  quantity: 1,
  totalCents: 233,
  added: false,
};

describe("order edit display grouping", () => {
  it("shows the original pack and three added packs as quantity four with their exact net total", () => {
    const input = [
      line,
      { ...line, id: "increase", quantity: 3, totalCents: 699 },
    ];
    const before = structuredClone(input);
    expect(groupOrderEditDisplayLines(input)).toEqual([
      {
        key: `variant:${line.variantId}`,
        sourceLineIds: ["original", "increase"],
        title: "Sleeves",
        variantTitle: "Pack of 100",
        quantity: 4,
        totalCents: 932,
        added: false,
      },
    ]);
    expect(input).toEqual(before);
  });

  it("preserves a fixed reward used on only one of two differently priced lines", () => {
    const result = groupOrderEditDisplayLines([
      { ...line, totalCents: 10099 },
      { ...line, id: "increase", totalCents: 11999 },
    ]);
    expect(result).toMatchObject([{ quantity: 2, totalCents: 22098 }]);
  });

  it("keeps different pack and box variants separate even if their labels match", () => {
    const result = groupOrderEditDisplayLines([
      line,
      {
        ...line,
        id: "box",
        variantId: "gid://shopify/ProductVariant/11",
        added: true,
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.added)).toEqual([false, true]);
  });

  it("never guesses identity for null IDs or older responses missing variant IDs", () => {
    const { variantId: _variantId, ...legacy } = line;
    const result = groupOrderEditDisplayLines([
      { ...line, variantId: null },
      { ...legacy, id: "legacy" },
      { ...legacy, id: "legacy-2" },
    ]);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((row) => row.key)).size).toBe(3);
  });

  it("marks a wholly new variant added, while a quantity increase on an original variant is not a new product", () => {
    const newVariant = groupOrderEditDisplayLines([
      { ...line, added: true },
      { ...line, id: "second", added: true },
    ]);
    expect(newVariant[0].added).toBe(true);
    const increasedVariant = groupOrderEditDisplayLines([
      line,
      { ...line, id: "second", added: true },
    ]);
    expect(increasedVariant[0].added).toBe(false);
  });

  it.each(["quantity", "totalCents"] as const)(
    "keeps exact individual rows if grouped %s would exceed safe integer precision",
    (field) => {
      const inputs = [
        { ...line, [field]: Number.MAX_SAFE_INTEGER },
        { ...line, id: "second", [field]: 1 },
      ];
      const result = groupOrderEditDisplayLines(inputs);
      expect(result).toHaveLength(2);
      expect(result.map((row) => row[field])).toEqual([
        Number.MAX_SAFE_INTEGER,
        1,
      ]);
    },
  );

  it("preserves zero values and stable first-seen product ordering", () => {
    const result = groupOrderEditDisplayLines([
      { ...line, quantity: 0, totalCents: 0 },
      {
        ...line,
        id: "new",
        variantId: "gid://shopify/ProductVariant/11",
        totalCents: 0,
      },
      { ...line, id: "increase" },
    ]);
    expect(result.map((row) => row.sourceLineIds)).toEqual([
      ["original", "increase"],
      ["new"],
    ]);
    expect(result.map((row) => row.totalCents)).toEqual([233, 0]);
  });
});

describe("display metadata boundary", () => {
  const lineSchema = orderEditOperationSchema.shape.lines.element;
  it("accepts both new identity metadata and legacy lines", () => {
    expect(lineSchema.parse(line)).toEqual(line);
    const { variantId: _id, added: _added, ...legacy } = line;
    expect(lineSchema.parse(legacy)).toEqual(legacy);
  });
  it("rejects incorrect variant identity and unsafe quantities", () => {
    expect(
      lineSchema.safeParse({
        ...line,
        variantId: "gid://shopify/Product/10",
      }).success,
    ).toBe(false);
    expect(
      lineSchema.safeParse({
        ...line,
        quantity: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });
});
