import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditShippingCalculator } from "../../infrastructure/shopify-order-edit-shipping.calculator";
import { orderEditSnapshotSchema } from "../../application/order-edit-provider.schema";
import type { OrderEditSnapshot } from "../../application/order-edit-provider";

const variantId = "gid://shopify/ProductVariant/10";
const money = (amount: string) => ({ amount, currencyCode: "USD" });
const bag = (amount: string) => ({
  shopMoney: money(amount),
  presentmentMoney: money(amount),
});
const snapshot = (): OrderEditSnapshot =>
  orderEditSnapshotSchema.parse({
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/100",
    name: "#100",
    customerId: "gid://shopify/Customer/1",
    currency: "USD",
    updatedAt: "2026-10-08T18:00:00.000Z",
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: 549,
    outstandingCents: 0,
    subtotalCents: 0,
    taxCents: 0,
    netPaidCents: 549,
    capturableCents: 0,
    shippingCents: 549,
    paymentUrl: null,
    memberPlan: "plan",
    memberPricingEnabled: true,
    discountsPresent: false,
    lines: [],
    transactions: [],
    refunds: [],
    contentFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    evidence: {
      shippingAddressFingerprint: "c".repeat(64),
      countryCode: "US",
      discountApplications: [],
      unsupportedPaymentTerms: false,
    },
    financials: {
      itemsGrossCents: 0,
      itemsDiscountCents: 0,
      itemsNetCents: 0,
      itemDiscountLabels: [],
      shippingGrossCents: 549,
      shippingDiscountCents: 0,
      shippingCents: 549,
      shippingDiscountLabels: [],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: 549,
      lines: [],
    },
    shippingContext: {
      address: {
        address1: "100 Test St",
        address2: null,
        city: "Test",
        provinceCode: "PA",
        zip: "16066",
        countryCodeV2: "US",
      },
      lines: [
        {
          id: "gid://shopify/ShippingLine/1",
          title: "Standard Shipping",
          code: "standard",
          source: "Echelon Shipping",
          grossCents: 549,
          netCents: 549,
        },
      ],
    },
  });
const rate = {
  handle: "opaque-native-rate",
  title: "Standard Shipping",
  code: "standard",
  source: "Echelon Shipping",
  price: money("7.99"),
};
const options = (rates = [rate]) => ({
  draftOrderAvailableDeliveryOptions: { availableShippingRates: rates },
});
function calculation(net = "0.00", itemNet = "93.20") {
  return {
    draftOrderCalculate: {
      userErrors: [],
      calculatedDraftOrder: {
        currencyCode: "USD",
        presentmentCurrencyCode: "USD",
        acceptAutomaticDiscounts: true,
        taxesIncluded: false,
        lineItems: [
          {
            quantity: 40,
            variant: { id: variantId },
            discountedTotalSet: bag(itemNet),
          },
        ],
        shippingLine: {
          title: rate.title,
          originalPriceSet: bag("7.99"),
          currentDiscountedPriceSet: bag(net),
        },
        platformDiscounts:
          net === "0.00"
            ? [
                {
                  title: "Member free shipping",
                  code: null,
                  discountClasses: ["SHIPPING"],
                  totalAmountPriceSet: bag("7.99"),
                },
              ]
            : [],
      },
    },
  };
}
const items = [{ variantId, quantity: 40, netCents: 9320 }];
const GENERAL = "gid://shopify/DeliveryProfile/1";
const BOXES = "gid://shopify/DeliveryProfile/2";
const boxVariantId = "gid://shopify/ProductVariant/20";
const group = (id: string, profile: string | null, label: string | null) => ({
  id,
  deliveryProfile: profile ? { id: profile } : null,
  product: { shippingGroup: label === null ? null : { value: label } },
});
const catalog = [
  group(variantId, GENERAL, "protection"),
  group(boxVariantId, BOXES, "storage_boxes"),
];
/** `request` records pricing requests only; the delivery-group lookup is answered from `groups` and recorded in `lookup`. */
function harness(responses: unknown[], groups = catalog) {
  const request = vi.fn(
    async (
      _snapshot: OrderEditSnapshot,
      _query: string,
      _variables: Record<string, unknown>,
    ) => responses.shift(),
  );
  const lookup = vi.fn(async (ids: string[]) => ({
    nodes: ids.map((id) => groups.find((entry) => entry.id === id) ?? null),
  }));
  return {
    request,
    lookup,
    calculator: new ShopifyOrderEditShippingCalculator(
      (snapshot, query, variables) =>
        query.includes("EchelonEditDeliveryGroups")
          ? lookup(variables.ids as string[])
          : request(snapshot, query, variables),
    ),
  };
}
describe("native checkout shipping calculation", () => {
  it("uses original service, current variant quantities/weights and exact post-discount amounts; reevaluates the shipping Function", async () => {
    const h = harness([options(), calculation()]);
    expect(await h.calculator.calculate(snapshot(), items)).toEqual({
      title: rate.title,
      code: rate.code,
      source: rate.source,
      grossCents: 799,
      discountCents: 799,
      netCents: 0,
      discountLabels: ["Member free shipping"],
    });
    expect(h.request.mock.calls[0]).toHaveLength(3);
    const [bound, query, variables] = h.request.mock.calls[0] as unknown as [
      OrderEditSnapshot,
      string,
      { input: unknown },
    ];
    expect(bound.channelId).toBe(36);
    expect(query).toContain("draftOrderAvailableDeliveryOptions");
    expect(variables.input).toMatchObject({
      lineItems: [
        {
          variantId,
          quantity: 40,
          priceOverride: { amount: "2.33", currencyCode: "USD" },
        },
      ],
      acceptAutomaticDiscounts: false,
      purchasingEntity: { customerId: "gid://shopify/Customer/1" },
    });
    expect(h.request.mock.calls[1][1]).toContain("draftOrderCalculate");
    expect(h.request.mock.calls[1][2]).toMatchObject({
      input: {
        acceptAutomaticDiscounts: true,
        shippingLine: { shippingRateHandle: rate.handle },
        customAttributes: [
          { key: "csz_suppress_member_pricing", value: "true" },
        ],
      },
    });
    expect(
      h.request.mock.calls.every(
        (call) => !String(call[1]).includes("draftOrderCreate"),
      ),
    ).toBe(true);
  });
  it("preserves paid shipping, including destination-specific lack of free-shipping eligibility", async () => {
    const input = snapshot();
    input.shippingContext!.address.provinceCode = "AK";
    const h = harness([options(), calculation("7.99")]);
    expect(await h.calculator.calculate(input, items)).toMatchObject({
      grossCents: 799,
      netCents: 799,
      discountCents: 0,
    });
    expect(h.request.mock.calls[0][2]).toMatchObject({
      input: { shippingAddress: { provinceCode: "AK" } },
    });
  });
  it("matches a replaced custom shipping line by unique title on the next edit", async () => {
    const input = snapshot();
    input.shippingContext!.lines[0].code = null;
    input.shippingContext!.lines[0].source = null;
    expect(
      await harness([options(), calculation()]).calculator.calculate(
        input,
        items,
      ),
    ).toMatchObject({ netCents: 0 });
  });
  it.each(
    [
      [],
      [rate, { ...rate, handle: "duplicate" }],
      [{ ...rate, code: "express" }],
      [{ ...rate, source: "wrong-account" }],
    ].map((rates) => ({ rates })),
  )(
    "rejects absent, duplicate or different delivery service",
    async ({ rates }) => {
      const h = harness([options(rates)]);
      await expect(
        h.calculator.calculate(snapshot(), items),
      ).rejects.toMatchObject({ code: "SHIPPING_SERVICE_UNAVAILABLE" });
      expect(h.request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects an additional item discount or changed quantity instead of rerunning coupons twice", async () => {
    const h = harness([options(), calculation("0.00", "90.00")]);
    await expect(
      h.calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_ITEMS_CHANGED" });
  });
  it.each([
    "product discount",
    "quantity",
    "tax context",
    "presentment amount",
  ])("rejects a calculation with changed %s", async (kind) => {
    const result = calculation();
    const calculated = result.draftOrderCalculate.calculatedDraftOrder;
    if (kind === "product discount")
      calculated.platformDiscounts.push({
        title: "Unexpected item benefit",
        code: null,
        discountClasses: ["PRODUCT"],
        totalAmountPriceSet: bag("1.00"),
      });
    if (kind === "quantity") calculated.lineItems[0].quantity = 39;
    if (kind === "tax context") calculated.taxesIncluded = true;
    if (kind === "presentment amount")
      calculated.shippingLine.currentDiscountedPriceSet.presentmentMoney.amount =
        "0.01";
    const code =
      kind === "tax context"
        ? "SHIPPING_TAX_CONTEXT_CHANGED"
        : kind === "presentment amount"
          ? "SHIPPING_CURRENCY_MISMATCH"
          : "SHIPPING_ITEMS_CHANGED";
    await expect(
      harness([options(), result]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code });
  });
  it("validates persisted shipping identities and amounts against the financial snapshot without throwing on fractions", () => {
    const input = snapshot();
    expect(
      orderEditSnapshotSchema.safeParse({
        ...input,
        shippingContext: { ...input.shippingContext!, lines: [] },
      }).success,
    ).toBe(false);
    const duplicate = structuredClone(input);
    duplicate.shippingContext!.lines.push({
      ...duplicate.shippingContext!.lines[0],
      grossCents: 0,
      netCents: 0,
    });
    expect(orderEditSnapshotSchema.safeParse(duplicate).success).toBe(false);
    const wrongGross = structuredClone(input);
    wrongGross.shippingContext!.lines[0].grossCents = 550;
    expect(orderEditSnapshotSchema.safeParse(wrongGross).success).toBe(false);
    const wrongNet = structuredClone(input);
    wrongNet.shippingContext!.lines[0].netCents = 548;
    expect(orderEditSnapshotSchema.safeParse(wrongNet).success).toBe(false);
    const fraction = structuredClone(input);
    fraction.shippingContext!.lines[0].netCents = 1.5;
    expect(orderEditSnapshotSchema.safeParse(fraction).success).toBe(false);
  });
  it("rejects missing platform shipping benefit amounts even when the native net price is zero", async () => {
    const result = calculation();
    result.draftOrderCalculate.calculatedDraftOrder.platformDiscounts = [];
    await expect(
      harness([options(), result]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_DISCOUNT_UNVERIFIED" });
  });
  it("carries original shipping coupon codes without reapplying already allocated item rewards", async () => {
    const input = snapshot();
    input.discountRules = [
      {
        index: 0,
        type: "DiscountCodeApplication",
        targetType: "SHIPPING_LINE",
        allocationMethod: "EACH",
        targetSelection: "ALL",
        label: "FREESHIP",
        value: { type: "percentage", percentage: 100 },
      },
      {
        index: 1,
        type: "DiscountCodeApplication",
        targetType: "LINE_ITEM",
        allocationMethod: "ACROSS",
        targetSelection: "ALL",
        label: "REWARD19",
        value: { type: "fixed", amountCents: 1900 },
      },
    ];
    const h = harness([options(), calculation()]);
    await h.calculator.calculate(input, items);
    expect(h.request.mock.calls[0][2]).toMatchObject({
      input: { discountCodes: ["FREESHIP"] },
    });
  });
  it.each(["SHIPPING_ADDRESS_INVALID", "SHIPPING_CONTEXT_UNAVAILABLE"])(
    "fails before requests for invalid context %s",
    async (code) => {
      const input = snapshot();
      if (code === "SHIPPING_ADDRESS_INVALID")
        input.shippingContext!.address.countryCodeV2 = "CA";
      else input.shippingContext = undefined;
      const h = harness([]);
      await expect(h.calculator.calculate(input, items)).rejects.toMatchObject({
        code,
      });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.lookup).not.toHaveBeenCalled();
    },
  );
  it("rejects provider user errors, malformed money, currency mismatch and stale handles", async () => {
    const errors = {
      draftOrderCalculate: {
        userErrors: [
          { field: ["shippingLine"], message: "Rate no longer available" },
        ],
        calculatedDraftOrder: null,
      },
    };
    await expect(
      harness([options(), errors]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_CALCULATION_REJECTED" });
    const wrongMoney = calculation();
    wrongMoney.draftOrderCalculate.calculatedDraftOrder.shippingLine.originalPriceSet =
      bag("7.991");
    await expect(
      harness([options(), wrongMoney]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_MONEY_INVALID" });
    const wrongRate = calculation();
    wrongRate.draftOrderCalculate.calculatedDraftOrder.shippingLine.originalPriceSet =
      bag("9.00");
    await expect(
      harness([options(), wrongRate]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_RATE_CHANGED" });
    const currency = calculation();
    currency.draftOrderCalculate.calculatedDraftOrder.presentmentCurrencyCode =
      "CAD";
    await expect(
      harness([options(), currency]).calculator.calculate(snapshot(), items),
    ).rejects.toMatchObject({ code: "SHIPPING_RESPONSE_INVALID" });
  });
});

describe("preview checkout tax and total proof", () => {
  it("reuses native shipping benefits and reconciles tax to exact net item prices", async () => {
    const value = calculation();
    const draft = {
      ...value.draftOrderCalculate.calculatedDraftOrder,
      totalTaxSet: bag("5.59"),
      taxLines: [{ title: "State tax", ratePercentage: 6, priceSet: bag("5.59") }],
      totalPriceSet: bag("98.79"),
    };
    const h = harness([
      options(),
      {
        draftOrderCalculate: {
          ...value.draftOrderCalculate,
          calculatedDraftOrder: draft,
        },
      },
    ]);
    const result = await h.calculator.calculatePreview(snapshot(), items);
    expect(result.taxCents).toBe(559);
    expect(result.taxLines).toEqual([{ title: "State tax", ratePercentage: 6, amountCents: 559 }]);
    expect(result.totalCents).toBe(9879);
    expect(result.shippingRepricing.netCents).toBe(0);
    expect(h.request.mock.calls[1][1]).toContain("draftOrderCalculate");
    expect(h.request.mock.calls[1][1]).toContain("taxLines { title ratePercentage priceSet");
    expect(
      h.request.mock.calls.some((r) =>
        /draftOrderCreate|orderEdit|refundCreate/.test(r[1]),
      ),
    ).toBe(false);
  });
  it("rejects missing or unreconciled taxes and total rather than inventing a tax estimate", async () => {
    const missing = harness([options(), calculation()]);
    await expect(
      missing.calculator.calculatePreview(snapshot(), items),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_PREVIEW_TOTALS_MISSING" });
    const value = calculation();
    const bad = {
      ...value.draftOrderCalculate.calculatedDraftOrder,
      totalTaxSet: bag("5.59"),
      totalPriceSet: bag("98.78"),
    };
    const h = harness([
      options(),
      {
        draftOrderCalculate: {
          ...value.draftOrderCalculate,
          calculatedDraftOrder: bad,
        },
      },
    ]);
    await expect(
      h.calculator.calculatePreview(snapshot(), items),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_PREVIEW_TOTALS_MISMATCH" });
  });
});

describe("orders with more than one delivery group", () => {
  const boxItems = [{ variantId: boxVariantId, quantity: 1, netCents: 4599 }];
  const mixed = [...items, ...boxItems];
  /** Observed shape of #65955: both charges are the same service, with nothing linking a charge to its group. */
  const twoCharges = () => {
    const input = snapshot();
    input.shippingContext!.lines = [
      { ...input.shippingContext!.lines[0], grossCents: 1199, netCents: 0 },
      {
        ...input.shippingContext!.lines[0],
        id: "gid://shopify/ShippingLine/2",
        grossCents: 1199,
        netCents: 1199,
      },
    ];
    input.shippingCents = 1199;
    input.totalCents = 1199;
    input.netPaidCents = 1199;
    input.financials = {
      ...input.financials!,
      shippingGrossCents: 2398,
      shippingDiscountCents: 1199,
      shippingCents: 1199,
      shippingDiscountLabels: ["Member free shipping"],
      totalCents: 1199,
    };
    return orderEditSnapshotSchema.parse(input);
  };
  const boxRate = { ...rate, handle: "box-rate", price: money("11.99") };
  function boxCalculation(extra: Record<string, unknown> = {}) {
    return {
      draftOrderCalculate: {
        userErrors: [],
        calculatedDraftOrder: {
          currencyCode: "USD",
          presentmentCurrencyCode: "USD",
          acceptAutomaticDiscounts: true,
          taxesIncluded: false,
          lineItems: [
            {
              quantity: 1,
              variant: { id: boxVariantId },
              discountedTotalSet: bag("45.99"),
            },
          ],
          shippingLine: {
            title: rate.title,
            originalPriceSet: bag("11.99"),
            currentDiscountedPriceSet: bag("11.99"),
          },
          platformDiscounts: [],
          ...extra,
        },
      },
    };
  }
  const expected = {
    title: rate.title,
    code: rate.code,
    source: rate.source,
    grossCents: 1998,
    discountCents: 799,
    netCents: 1199,
    discountLabels: ["Member free shipping"],
    groups: [
      {
        deliveryProfileId: GENERAL,
        title: rate.title,
        code: rate.code,
        source: rate.source,
        grossCents: 799,
        discountCents: 799,
        netCents: 0,
        discountLabels: ["Member free shipping"],
      },
      {
        deliveryProfileId: BOXES,
        title: rate.title,
        code: rate.code,
        source: rate.source,
        grossCents: 1199,
        discountCents: 0,
        netCents: 1199,
        discountLabels: [],
      },
    ],
  };

  it("prices each delivery group in its own checkout calculation and reports one charge per group", async () => {
    const h = harness([
      options(),
      calculation(),
      options([boxRate]),
      boxCalculation(),
    ]);
    // Items arrive in any order; each group sees only its own items.
    expect(
      await h.calculator.calculate(twoCharges(), [...boxItems, ...items]),
    ).toEqual(expected);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(4);
    const lineItems = (call: number) =>
      (
        h.request.mock.calls[call][2] as {
          input: { lineItems: Array<{ variantId: string }> };
        }
      ).input.lineItems.map((line) => line.variantId);
    expect(lineItems(0)).toEqual([variantId]);
    expect(lineItems(1)).toEqual([variantId]);
    expect(lineItems(2)).toEqual([boxVariantId]);
    expect(lineItems(3)).toEqual([boxVariantId]);
    expect(h.request.mock.calls[3][2]).toMatchObject({
      input: { shippingLine: { shippingRateHandle: "box-rate" } },
    });
  });
  it("adds a second delivery charge when an order with one charge gains an item from another group", async () => {
    const h = harness([
      options(),
      calculation(),
      options([boxRate]),
      boxCalculation(),
    ]);
    expect(await h.calculator.calculate(snapshot(), mixed)).toEqual(expected);
  });
  it("returns a single charge when the edit leaves only one delivery group", async () => {
    const h = harness([options(), calculation()]);
    const result = await h.calculator.calculate(twoCharges(), items);
    expect(result).toEqual({
      title: rate.title,
      code: rate.code,
      source: rate.source,
      grossCents: 799,
      discountCents: 799,
      netCents: 0,
      discountLabels: ["Member free shipping"],
    });
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("adds each group's tax and total, and merges the same tax across groups", async () => {
    const general = calculation();
    const h = harness([
      options(),
      {
        draftOrderCalculate: {
          ...general.draftOrderCalculate,
          calculatedDraftOrder: {
            ...general.draftOrderCalculate.calculatedDraftOrder,
            totalTaxSet: bag("5.59"),
            taxLines: [
              { title: "State tax", ratePercentage: 6, priceSet: bag("5.59") },
            ],
            totalPriceSet: bag("98.79"),
          },
        },
      },
      options([boxRate]),
      boxCalculation({
        totalTaxSet: bag("3.48"),
        taxLines: [
          { title: "State tax", ratePercentage: 6, priceSet: bag("2.76") },
          { title: "County tax", ratePercentage: 1, priceSet: bag("0.72") },
        ],
        totalPriceSet: bag("61.46"),
      }),
    ]);
    const result = await h.calculator.calculatePreview(twoCharges(), mixed);
    expect(result.shippingRepricing).toEqual(expected);
    expect(result.taxCents).toBe(907);
    expect(result.totalCents).toBe(16025);
    expect(result.taxLines).toEqual([
      { title: "State tax", ratePercentage: 6, amountCents: 835 },
      { title: "County tax", ratePercentage: 1, amountCents: 72 },
    ]);
  });
  it("fails closed when one group's total does not reconcile", async () => {
    const h = harness([
      options(),
      calculation(),
      options([boxRate]),
      boxCalculation({
        totalTaxSet: bag("3.48"),
        totalPriceSet: bag("61.46"),
      }),
    ]);
    await expect(
      h.calculator.calculatePreview(twoCharges(), mixed),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_PREVIEW_TOTALS_MISSING" });
  });
  it.each([
    [
      "one free-shipping label ships in two delivery groups",
      [
        group(variantId, GENERAL, "protection"),
        group(boxVariantId, BOXES, "protection"),
      ],
    ],
    [
      "unlabelled items ship in two delivery groups",
      [group(variantId, GENERAL, null), group(boxVariantId, BOXES, " ")],
    ],
    [
      "an item has no shipping profile",
      [group(variantId, GENERAL, "protection"), group(boxVariantId, null, null)],
    ],
  ])("sends the order to staff when %s", async (_name, groups) => {
    const h = harness([], groups);
    await expect(
      h.calculator.calculate(twoCharges(), mixed),
    ).rejects.toMatchObject({ code: "SHIPPING_GROUPS_UNSUPPORTED" });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("prices a labelled and an unlabelled item together when they share one delivery group", async () => {
    const h = harness(
      [options(), calculation()],
      [group(variantId, GENERAL, null)],
    );
    expect(await h.calculator.calculate(snapshot(), items)).toMatchObject({
      netCents: 0,
    });
  });
  it("sends a shipping code on a multi-group order to staff", async () => {
    const input = twoCharges();
    input.discountRules = [
      {
        index: 0,
        type: "DiscountCodeApplication",
        targetType: "SHIPPING_LINE",
        allocationMethod: "EACH",
        targetSelection: "ALL",
        label: "FREESHIP",
        value: { type: "percentage", percentage: 100 },
      },
    ];
    const h = harness([]);
    await expect(h.calculator.calculate(input, mixed)).rejects.toMatchObject({
      code: "SHIPPING_GROUPS_UNSUPPORTED",
    });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses original charges that name different delivery services, before any request", async () => {
    const input = twoCharges();
    input.shippingContext!.lines[1].code = "express";
    const h = harness([]);
    await expect(h.calculator.calculate(input, mixed)).rejects.toMatchObject({
      code: "SHIPPING_SERVICE_UNAVAILABLE",
    });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses a group whose current rates no longer offer the original service", async () => {
    const h = harness([
      options(),
      calculation(),
      options([{ ...boxRate, code: "express" }]),
    ]);
    await expect(
      h.calculator.calculate(twoCharges(), mixed),
    ).rejects.toMatchObject({ code: "SHIPPING_SERVICE_UNAVAILABLE" });
  });
  it("rejects a lookup that does not return every revised item", async () => {
    const h = harness([], [group(variantId, GENERAL, "protection")]);
    await expect(
      h.calculator.calculate(twoCharges(), mixed),
    ).rejects.toMatchObject({ code: "SHIPPING_RESPONSE_INVALID" });
    expect(h.request).not.toHaveBeenCalled();
  });
});
