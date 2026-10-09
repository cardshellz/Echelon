import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
import { isUnpaidRecoveryRestored } from "../../application/order-edit-evidence";
import { orderEditQuoteSchema } from "../../application/order-edit-provider.schema";
import type { OrderEditShippingCalculator } from "../../application/order-edit-shipping";
import {
  OrderEditCommitNotSentError,
  type OrderEditQuote,
  type OrderEditSnapshot,
} from "../../application/order-edit-provider";

const NOW = new Date("2026-10-05T18:00:00.000Z");
const id = (kind: string, value: number) => `gid://shopify/${kind}/${value}`;
const bag = (amount: string) => ({
  presentmentMoney: { amount, currencyCode: "USD" },
  shopMoney: { amount, currencyCode: "USD" },
});
interface DiscountAllocationFixture {
  allocatedAmountSet: ReturnType<typeof bag>;
  discountApplication: {
    __typename: string;
    code?: string;
    id: string;
    allocationMethod: string;
    appliedTo: string;
    targetType: string;
    targetSelection: string;
    description: string | null;
    value:
      | { __typename: "MoneyV2"; amount: string; currencyCode: string }
      | { __typename: "PricingPercentageValue"; percentage: number };
  };
}
const cents = (price: string) => {
  const [whole, fraction = ""] = price.split(".");
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
};
const decimal = (result: bigint) => {
  const magnitude = result < BigInt(0) ? -result : result;
  return `${result < BigInt(0) ? "-" : ""}${magnitude / BigInt(100)}.${String(magnitude % BigInt(100)).padStart(2, "0")}`;
};
const lineAmount = (price: string, quantity: number) => {
  const result = cents(price) * BigInt(quantity);
  return `${result / BigInt(100)}.${String(result % BigInt(100)).padStart(2, "0")}`;
};
const tx = (
  value = 1,
  amount = "20.00",
  kind = "SALE",
  status = "SUCCESS",
  parent: number | null = null,
) => ({
  id: id("OrderTransaction", value),
  kind,
  status,
  gateway: "shopify_payments",
  manualPaymentGateway: false,
  processedAt: NOW.toISOString(),
  parentTransaction:
    parent === null ? null : { id: id("OrderTransaction", parent) },
  amountSet: bag(amount),
});
const line = (value = 1, variant = 10, quantity = 2, price = "10.00") => ({
  id: id("LineItem", value),
  title: "Test product",
  variantTitle: null,
  sku: "TEST",
  currentQuantity: quantity,
  unfulfilledQuantity: quantity,
  unfulfilledDiscountedTotalSet: bag(lineAmount(price, quantity)),
  originalUnitPriceSet: bag(price),
  discountedUnitPriceSet: bag(price),
  priceAfterAllDiscountsBeforeTaxesSet: bag(lineAmount(price, quantity)),
  merchantEditable: true,
  requiresShipping: true,
  isGiftCard: false,
  sellingPlan: null,
  lineItemGroup: null,
  variant: { id: id("ProductVariant", variant) },
  discountAllocations: [],
});
function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    shop: {
      currencyCode: "USD",
      primaryDomain: { host: "test.example.com" },
      transformEnabled: { value: "true" },
    },
    order: {
      id: id("Order", 100),
      name: "#100",
      updatedAt: NOW.toISOString(),
      merchantEditable: true,
      merchantEditableErrors: [],
      cancelledAt: null,
      closed: false,
      fullyPaid: true,
      capturable: false,
      taxesIncluded: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      currentTotalPriceSet: bag("20.00"),
      totalOutstandingSet: bag("0.00"),
      netPaymentSet: bag("20.00"),
      totalCapturableSet: bag("0.00"),
      currentShippingPriceSet: bag("0.00"),
      currentSubtotalPriceSet: bag("20.00"),
      currentTotalTaxSet: bag("0.00"),
      paymentCollectionDetails: { additionalPaymentCollectionUrl: null },
      paymentTerms: null,
      purchasingEntity: null,
      disputes: [],
      customAttributes: [],
      shippingAddress: {
        address1: "Test street",
        address2: null,
        city: "Test",
        provinceCode: "PA",
        zip: "15000",
        countryCodeV2: "US",
      },
      customer: { id: id("Customer", 1), tags: [], membershipPlan: null },
      discountApplications: { nodes: [], pageInfo: { hasNextPage: false } },
      shippingLines: { nodes: [], pageInfo: { hasNextPage: false } },
      lineItems: { nodes: [line()], pageInfo: { hasNextPage: false } },
      transactions: [tx()],
      transactionsCount: { count: 1, precision: "EXACT" },
      refunds: [],
      ...overrides,
    },
  };
}
const calcLine = (
  value = 1,
  variant = 10,
  quantity = 2,
  price = "10.00",
  discounted = price,
) => ({
  id: id("CalculatedLineItem", value),
  title: "Test product",
  variantTitle: null,
  quantity,
  editableQuantityBeforeChanges: quantity,
  variant: { id: id("ProductVariant", variant) },
  editableSubtotalSet: bag(lineAmount(discounted, quantity)),
  originalUnitPriceSet: bag(price),
  discountedUnitPriceSet: bag(discounted),
  calculatedDiscountAllocations: (price === discounted
    ? []
    : [
        {
          allocatedAmountSet: bag(
            decimal((cents(price) - cents(discounted)) * BigInt(quantity)),
          ),
          discountApplication: {
            __typename: "CalculatedManualDiscountApplication",
            id: id("CalculatedDiscountApplication", value),
            allocationMethod: "EACH",
            appliedTo: "LINE",
            targetType: "LINE_ITEM",
            targetSelection: "EXPLICIT",
            description: "Echelon member pricing",
            value: {
              __typename: "MoneyV2",
              amount: decimal(cents(price) - cents(discounted)),
              currencyCode: "USD",
            },
          },
        },
      ]) as DiscountAllocationFixture[],
});
function calculated(
  total = "20.00",
  outstanding = "0.00",
  lines = [calcLine()],
  added: ReturnType<typeof calcLine>[] = [],
) {
  return {
    id: id("CalculatedOrder", 100),
    originalOrder: { id: id("Order", 100) },
    totalPriceSet: bag(total),
    totalOutstandingSet: bag(outstanding),
    subtotalPriceSet: bag(total),
    cartDiscountAmountSet: null,
    taxLines: [],
    shippingLines: [],
    lineItems: { nodes: lines, pageInfo: { hasNextPage: false } },
    addedLineItems: { nodes: added, pageInfo: { hasNextPage: false } },
  };
}
const begin = (value: unknown = calculated()) => ({
  orderEditBegin: {
    userErrors: [],
    calculatedOrder: value,
    orderEditSession: { id: id("OrderEditSession", 100) },
  },
});
const quantity = (value: unknown) => ({
  orderEditSetQuantity: { userErrors: [], calculatedOrder: value },
});
const variant = (
  value = 20,
  price = "5.00",
  planPrices: string | null = null,
) => ({
  id: id("ProductVariant", value),
  title: "Single",
  displayName: "Added item",
  sku: "ADD",
  price,
  requiresComponents: false,
  availableForSale: true,
  inventoryPolicy: "DENY",
  sellableOnlineQuantity: 100,
  inventoryItem: { requiresShipping: true, tracked: true },
  product: { status: "ACTIVE", isGiftCard: false, requiresSellingPlan: false },
  membershipVariant: null,
  planPrices: planPrices === null ? null : { value: planPrices },
});
const refundCapacity = (amount = "20.00", gateway = "shopify_payments") => ({
  order: {
    id: id("Order", 100),
    suggestedRefund: {
      maximumRefundableSet: bag(amount),
      suggestedTransactions: [
        {
          kind: "SUGGESTED_REFUND",
          gateway,
          parentTransaction: { id: id("OrderTransaction", 1) },
          maximumRefundableSet: bag(amount),
        },
      ],
    },
  },
});

function shippingOrder(
  total = "26.50",
  shipping = "5.00",
  tax = "1.50",
  subtotal = "20.00",
  outstanding = "0.00",
  orderLines = [line()],
) {
  return rawOrder({
    currentTotalPriceSet: bag(total),
    currentSubtotalPriceSet: bag(subtotal),
    currentTotalTaxSet: bag(tax),
    currentShippingPriceSet: bag(shipping),
    netPaymentSet: bag("26.50"),
    totalOutstandingSet: bag(outstanding),
    fullyPaid: outstanding === "0.00",
    transactions: [tx(1, "26.50")],
    lineItems: { nodes: orderLines, pageInfo: { hasNextPage: false } },
    shippingLines: {
      nodes: [
        {
          id: id("ShippingLine", shipping === "5.00" ? 1 : 2),
          title: "Standard Shipping",
          code: shipping === "5.00" ? "standard" : null,
          source: shipping === "5.00" ? "Echelon Shipping" : null,
          isRemoved: false,
          originalPriceSet: bag(shipping),
          currentDiscountedPriceSet: bag(shipping),
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  });
}
function shippingCalculated(
  total = "26.50",
  shipping = "5.00",
  tax = "1.50",
  subtotal = "20.00",
  outstanding = "0.00",
  lines = [calcLine()],
  added: ReturnType<typeof calcLine>[] = [],
  stagedStatus = "NONE",
) {
  return {
    ...calculated(total, outstanding, lines, added),
    subtotalPriceSet: bag(subtotal),
    taxLines: [{ priceSet: bag(tax) }],
    shippingLines: [
      {
        id: id("CalculatedShippingLine", 1),
        title: "Standard Shipping",
        price: bag(shipping),
        stagedStatus,
      },
    ],
  };
}

function harness(
  responses: Array<unknown>,
  credentialOverrides: Record<string, unknown> = {},
  shippingCalculator: OrderEditShippingCalculator = {
    calculate: async (snapshot) => ({
      title: snapshot.shippingContext?.lines[0]?.title ?? "Standard Shipping",
      code: "standard",
      source: "Echelon Shipping",
      grossCents:
        snapshot.financials?.shippingGrossCents ?? snapshot.shippingCents,
      netCents: snapshot.shippingCents,
      discountCents:
        (snapshot.financials?.shippingGrossCents ?? snapshot.shippingCents) -
        snapshot.shippingCents,
      discountLabels: snapshot.financials?.shippingDiscountLabels ?? [],
    }),
  },
) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> =
    [];
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (response instanceof Response) return response;
      if (response === undefined) throw new Error("Unexpected request");
      return new Response(JSON.stringify({ data: response }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const reports =
    vi.fn<(event: { operationId: string; code: string }) => void>();
  const provider = new ShopifyOrderEditProvider({
    shippingCalculator,
    clock: () => NOW,
    fetch: fetchImpl as typeof fetch,
    report: reports,
    credentials: {
      get: async () => ({
        connectionId: 4,
        channelId: 36,
        shopDomain: "test.myshopify.com",
        accessToken: "not-a-real-secret",
        ...credentialOverrides,
      }),
    },
  });
  return { provider, requests, fetchImpl, reports };
}
async function reduction() {
  const h = harness([
    rawOrder(),
    rawOrder(),
    begin(),
    quantity(calculated("10.00", "-10.00", [calcLine(1, 10, 1)])),
    refundCapacity(),
  ]);
  const snapshot = await h.provider.readOrder(4, "100");
  const quote = await h.provider.quote(
    4,
    snapshot,
    { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
    "edit-1",
  );
  return { snapshot, quote };
}

// The observed #63909 pricing combination, with synthetic identities and no live mutations.
function codeOrder(
  itemQuantity = 4,
  lineNet = "17.96",
  total = "107.96",
  secondNet = "90.00",
) {
  const first = line(1, 10, itemQuantity, "4.99");
  const second = line(2, 20, 1, "99.99");
  const original = rawOrder();
  return {
    ...original,
    order: {
      ...original.order,
      name: "#63909",
      fullyPaid: total === "107.96",
      currentSubtotalPriceSet: bag(total),
      currentTotalPriceSet: bag(total),
      netPaymentSet: bag("107.96"),
      totalOutstandingSet: bag(decimal(cents(total) - cents("107.96"))),
      transactions: [tx(1, "107.96")],
      discountApplications: {
        nodes: [
          {
            __typename: "AutomaticDiscountApplication",
            index: 0,
            targetType: "SHIPPING_LINE",
            allocationMethod: "EACH",
            targetSelection: "ALL",
            title: "Free shipping",
            value: { __typename: "PricingPercentageValue", percentage: 100 },
          },
          {
            __typename: "DiscountCodeApplication",
            index: 1,
            targetType: "LINE_ITEM",
            allocationMethod: "ACROSS",
            targetSelection: "ALL",
            code: "AMAZZIN'",
            value: { __typename: "PricingPercentageValue", percentage: 10 },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      shippingLines: {
        nodes: [
          {
            id: id("ShippingLine", 1),
            isRemoved: false,
            originalPriceSet: bag("12.99"),
            currentDiscountedPriceSet: bag("0.00"),
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      lineItems: {
        nodes: [
          {
            ...first,
            priceAfterAllDiscountsBeforeTaxesSet: bag(lineNet),
            discountAllocations: [
              {
                allocatedAmountSet: bag(
                  decimal(
                    cents(lineAmount("4.99", itemQuantity)) - cents(lineNet),
                  ),
                ),
                discountApplication: { index: 1 },
              },
            ],
          },
          {
            ...second,
            priceAfterAllDiscountsBeforeTaxesSet: bag(secondNet),
            discountAllocations: [
              {
                allocatedAmountSet: bag(
                  decimal(cents("99.99") - cents(secondNet)),
                ),
                discountApplication: { index: 1 },
              },
            ],
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
function codeCalculated(
  itemQuantity = 4,
  firstDiscount = "2.00",
  total = "107.96",
  applicationId = 1,
) {
  const application: DiscountAllocationFixture["discountApplication"] = {
    __typename: "CalculatedDiscountCodeApplication",
    code: "AMAZZIN'",
    id: id("CalculatedDiscountApplication", applicationId),
    appliedTo: "ORDER",
    allocationMethod: "ACROSS",
    targetType: "LINE_ITEM",
    targetSelection: "ALL",
    description: "AMAZZIN'",
    value: { __typename: "PricingPercentageValue", percentage: 10 },
  };
  const lines = [
    {
      ...calcLine(1, 10, itemQuantity, "4.99"),
      calculatedDiscountAllocations: [
        {
          allocatedAmountSet: bag(firstDiscount),
          discountApplication: application,
        },
      ],
    },
    {
      ...calcLine(2, 20, 1, "99.99"),
      calculatedDiscountAllocations: [
        { allocatedAmountSet: bag("9.99"), discountApplication: application },
      ],
    },
  ];
  return {
    ...calculated(total, decimal(cents(total) - cents("107.96")), lines),
    cartDiscountAmountSet: bag(decimal(cents(firstDiscount) + cents("9.99"))),
    shippingLines: [
      {
        id: id("CalculatedShippingLine", 1),
        price: bag("12.99"),
        stagedStatus: "NONE",
      },
    ],
  };
}
async function codeIncrease() {
  const h = harness([
    codeOrder(),
    codeOrder(),
    { nodes: [variant(10, "4.99")] },
    begin(codeCalculated()),
    quantity(codeCalculated(5, "2.50", "112.45")),
  ]);
  const snapshot = await h.provider.readOrder(4, "100");
  const quote = await h.provider.quote(
    4,
    snapshot,
    { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
    "edit-1",
  );
  return { h, snapshot, quote };
}
interface OriginalCodeFixture {
  __typename: string;
  index: number;
  code: string;
  targetType: string;
  targetSelection: string;
  allocationMethod: string;
  value: DiscountAllocationFixture["discountApplication"]["value"];
}

// Fixed credit fixtures retain one original $20 code; they never mint a reward.
function fixedOrder(
  firstQuantity = 1,
  firstDiscount = "10.00",
  secondDiscount = "10.00",
) {
  const firstGross = cents("50.00") * BigInt(firstQuantity);
  const total = decimal(
    firstGross + cents("50.00") - cents(firstDiscount) - cents(secondDiscount),
  );
  const original = rawOrder();
  const application: OriginalCodeFixture = {
    __typename: "DiscountCodeApplication",
    index: 0,
    code: "REWARD20",
    targetType: "LINE_ITEM",
    targetSelection: "ALL",
    allocationMethod: "ACROSS",
    value: { __typename: "MoneyV2", amount: "20.00", currencyCode: "USD" },
  };
  return {
    ...original,
    order: {
      ...original.order,
      fullyPaid: total === "80.00",
      currentSubtotalPriceSet: bag(total),
      currentTotalPriceSet: bag(total),
      netPaymentSet: bag("80.00"),
      transactions: [tx(1, "80.00")],
      totalOutstandingSet: bag(decimal(cents(total) - cents("80.00"))),
      discountApplications: {
        nodes: [application],
        pageInfo: { hasNextPage: false },
      },
      lineItems: {
        nodes: [
          {
            ...line(1, 10, firstQuantity, "50.00"),
            priceAfterAllDiscountsBeforeTaxesSet: bag(
              decimal(firstGross - cents(firstDiscount)),
            ),
            discountAllocations: [
              {
                allocatedAmountSet: bag(firstDiscount),
                discountApplication: { index: 0 },
              },
            ],
          },
          {
            ...line(2, 20, 1, "50.00"),
            priceAfterAllDiscountsBeforeTaxesSet: bag(
              decimal(cents("50.00") - cents(secondDiscount)),
            ),
            discountAllocations: [
              {
                allocatedAmountSet: bag(secondDiscount),
                discountApplication: { index: 0 },
              },
            ],
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
function fixedCalculated(
  firstQuantity = 1,
  firstDiscount = "10.00",
  secondDiscount = "10.00",
) {
  const application: DiscountAllocationFixture["discountApplication"] = {
    __typename: "CalculatedDiscountCodeApplication",
    id: id("CalculatedDiscountApplication", 1),
    code: "REWARD20",
    description: "REWARD20",
    appliedTo: "ORDER",
    targetType: "LINE_ITEM",
    targetSelection: "ALL",
    allocationMethod: "ACROSS",
    value: { __typename: "MoneyV2", amount: "20.00", currencyCode: "USD" },
  };
  const total = decimal(
    cents("50.00") * BigInt(firstQuantity + 1) -
      cents(firstDiscount) -
      cents(secondDiscount),
  );
  return calculated(total, decimal(cents(total) - cents("80.00")), [
    {
      ...calcLine(1, 10, firstQuantity, "50.00"),
      calculatedDiscountAllocations: [
        {
          allocatedAmountSet: bag(firstDiscount),
          discountApplication: application,
        },
      ],
    },
    {
      ...calcLine(2, 20, 1, "50.00"),
      calculatedDiscountAllocations: [
        {
          allocatedAmountSet: bag(secondDiscount),
          discountApplication: application,
        },
      ],
    },
  ]);
}
async function fixedIncrease() {
  const h = harness([
    fixedOrder(),
    fixedOrder(),
    { nodes: [variant(10, "50.00")] },
    begin(fixedCalculated()),
    quantity(fixedCalculated(2)),
  ]);
  const snapshot = await h.provider.readOrder(4, "100");
  const quote = await h.provider.quote(
    4,
    snapshot,
    {
      changes: [{ lineItemId: "1", quantity: 2 }],
      additions: [],
    },
    "fixed-edit",
  );
  return { h, snapshot, quote };
}

// Observed #63980 order/preview amounts, with synthetic identities. The approved
// 2026-10-07 preview returned a 9.99 cart summary with no product allocations.
function shippingOnlyOrder() {
  return rawOrder({
    name: "#63980",
    currentTotalPriceSet: bag("187.98"),
    currentSubtotalPriceSet: bag("187.98"),
    netPaymentSet: bag("187.98"),
    transactions: [tx(1, "187.98")],
    lineItems: {
      nodes: [line(1, 10, 1, "47.99"), line(2, 20, 1, "139.99")],
      pageInfo: { hasNextPage: false },
    },
    discountApplications: {
      nodes: [
        {
          __typename: "AutomaticDiscountApplication",
          index: 0,
          targetType: "SHIPPING_LINE",
          allocationMethod: "EACH",
          targetSelection: "ALL",
          title: "Member free shipping",
          value: { __typename: "PricingPercentageValue", percentage: 100 },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    shippingLines: {
      nodes: [
        {
          id: id("ShippingLine", 1),
          isRemoved: false,
          originalPriceSet: bag("9.99"),
          currentDiscountedPriceSet: bag("0.00"),
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  });
}

function shippingOnlyCalculated(
  firstQuantity: number,
  cartDiscount: string | null,
) {
  const total = decimal(
    cents("47.99") * BigInt(firstQuantity) + cents("139.99"),
  );
  return {
    ...calculated(total, decimal(cents(total) - cents("187.98")), [
      calcLine(1, 10, firstQuantity, "47.99"),
      calcLine(2, 20, 1, "139.99"),
    ]),
    cartDiscountAmountSet: cartDiscount === null ? null : bag(cartDiscount),
    taxLines: [] as Array<{ priceSet: ReturnType<typeof bag> }>,
    shippingLines: [
      {
        id: id("CalculatedShippingLine", 1),
        price: bag("9.99"),
        stagedStatus: "NONE",
      },
    ],
  };
}

describe("shipping repricing, commit and payment recovery", () => {
  const freeShipping = {
    title: "Standard Shipping",
    code: "standard",
    source: "Echelon Shipping",
    grossCents: 800,
    netCents: 0,
    discountCents: 800,
    discountLabels: ["Member free shipping"],
  };
  async function increase(
    shippingCalculator: OrderEditShippingCalculator,
    extra: unknown[] = [],
  ) {
    const afterItems = shippingCalculated(
      "36.50",
      "5.00",
      "1.50",
      "30.00",
      "10.00",
      [calcLine()],
      [calcLine(2, 10, 1)],
    );
    const removed = shippingCalculated(
      "31.80",
      "5.00",
      "1.80",
      "30.00",
      "5.30",
      [calcLine()],
      [calcLine(2, 10, 1)],
      "REMOVED",
    );
    const final = {
      ...removed,
      shippingLines: [
        ...removed.shippingLines,
        {
          id: id("CalculatedShippingLine", 2),
          title: "Standard Shipping",
          price: bag("0.00"),
          stagedStatus: "ADDED",
        },
      ],
    };
    const h = harness(
      [
        shippingOrder(),
        shippingOrder(),
        { nodes: [variant(10, "10.00")] },
        begin(shippingCalculated()),
        {
          orderEditAddVariant: {
            userErrors: [],
            calculatedLineItem: { id: id("CalculatedLineItem", 2) },
            calculatedOrder: afterItems,
          },
        },
        {
          orderEditRemoveShippingLine: {
            userErrors: [],
            calculatedOrder: removed,
          },
        },
        {
          orderEditAddShippingLine: { userErrors: [], calculatedOrder: final },
        },
        ...extra,
      ],
      {},
      shippingCalculator,
    );
    const baseline = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      baseline,
      { changes: [], additions: [{ variantId: "10", quantity: 1 }] },
      "edit-shipping",
    );
    return { ...h, baseline, quote };
  }
  it("recalculates shipping and tax after an increase and includes the fee reduction in the payment difference", async () => {
    const calculate = vi.fn(async () => freeShipping);
    const h = await increase({ calculate });
    expect(h.quote).toMatchObject({
      totalCents: 3180,
      outstandingCents: 530,
      deltaCents: 530,
      shippingCents: 0,
      shippingRepricing: freeShipping,
      financials: {
        itemsNetCents: 3000,
        shippingGrossCents: 0,
        shippingCents: 0,
        shippingDiscountCents: 0,
        taxCents: 180,
      },
    });
    // The checkout benefit is audited separately: Shopify receives its exact net charge, not an invented shipping allocation.
    expect(calculate).toHaveBeenCalledWith(h.baseline, [
      { variantId: id("ProductVariant", 10), quantity: 2, netCents: 2000 },
      { variantId: id("ProductVariant", 10), quantity: 1, netCents: 1000 },
    ]);
    expect(
      h.requests.find((request) =>
        request.query.includes("orderEditAddShippingLine"),
      )?.variables.shippingLine,
    ).toEqual({
      title: "Standard Shipping",
      price: { amount: "0.00", currencyCode: "USD" },
    });
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
  });
  it("checks the current shipping rate again before committing and verifies the observed charge", async () => {
    const calculate = vi.fn(async () => freeShipping);
    const pending = shippingOrder("31.80", "0.00", "1.80", "30.00", "5.30", [
      line(),
      line(2, 10, 1),
    ]);
    const h = await increase({ calculate }, [
      shippingOrder(),
      { nodes: [variant(10, "10.00")] },
      { orderEditCommit: { userErrors: [], order: { id: id("Order", 100) } } },
      pending,
    ]);
    expect(
      (await h.provider.commit(4, h.quote, "edit-shipping")).shippingCents,
    ).toBe(0);
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(
      h.requests.find((request) => request.query.includes("orderEditCommit"))
        ?.query,
    ).toContain("notifyCustomer: false");
  });
  it("proves no commit was sent when the reviewed shipping rate or benefits become stale", async () => {
    let calls = 0;
    const h = await increase(
      {
        calculate: async () =>
          ++calls === 1
            ? freeShipping
            : { ...freeShipping, grossCents: 900, discountCents: 900 },
      },
      [shippingOrder()],
    );
    await expect(
      h.provider.commit(4, h.quote, "edit-shipping"),
    ).rejects.toBeInstanceOf(OrderEditCommitNotSentError);
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
  });
  it("blocks a legacy unsubmitted quote while keeping its cancellation and recovery contract readable", async () => {
    const source = harness([rawOrder()]);
    const baseline = await source.provider.readOrder(4, "100");
    const quote = additionQuote(baseline);
    const h = harness([rawOrder(), { nodes: [variant()] }]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toMatchObject({
      code: "SHIPPING_REVIEW_REQUIRED",
      name: "OrderEditCommitNotSentError",
    });
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
    expect(orderEditQuoteSchema.safeParse(quote).success).toBe(true);
  });
  it("accounts for a higher shipping charge and Shopify's revised tax in a reduction's refund preflight", async () => {
    const reduced = shippingCalculated(
      "16.50",
      "5.00",
      "1.50",
      "10.00",
      "-10.00",
      [calcLine(1, 10, 1)],
    );
    const removed = shippingCalculated(
      "11.50",
      "5.00",
      "1.50",
      "10.00",
      "-15.00",
      [calcLine(1, 10, 1)],
      [],
      "REMOVED",
    );
    const final = shippingCalculated(
      "19.80",
      "8.00",
      "1.80",
      "10.00",
      "-6.70",
      [calcLine(1, 10, 1)],
      [],
      "ADDED",
    );
    const h = harness(
      [
        shippingOrder(),
        shippingOrder(),
        begin(shippingCalculated()),
        quantity(reduced),
        {
          orderEditRemoveShippingLine: {
            userErrors: [],
            calculatedOrder: removed,
          },
        },
        {
          orderEditAddShippingLine: { userErrors: [], calculatedOrder: final },
        },
        refundCapacity("26.50"),
      ],
      {},
      {
        calculate: async () => ({
          ...freeShipping,
          netCents: 800,
          discountCents: 0,
          discountLabels: [],
        }),
      },
    );
    const baseline = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      baseline,
      { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
      "shipping-reduction",
    );
    expect(quote).toMatchObject({
      totalCents: 1980,
      deltaCents: -670,
      shippingCents: 800,
      financials: { shippingGrossCents: 800, taxCents: 180 },
    });
    expect(h.requests.at(-1)?.query).toContain("suggestedRefund");
    expect(
      h.requests.some((request) => request.query.includes("refundCreate")),
    ).toBe(false);
  });
  it("restores saved shipping and tax on unpaid expiry without rerating the old cart or requesting a refund", async () => {
    const original = await increase({ calculate: async () => freeShipping });
    const pending = shippingOrder("31.80", "0.00", "1.80", "30.00", "5.30", [
      line(),
      line(2, 10, 1),
    ]);
    const currentCalc = shippingCalculated(
      "31.80",
      "0.00",
      "1.80",
      "30.00",
      "5.30",
      [calcLine(), calcLine(2, 10, 1)],
    );
    const quantitiesRestored = shippingCalculated(
      "21.50",
      "0.00",
      "1.50",
      "20.00",
      "-5.00",
      [calcLine(), calcLine(2, 10, 0)],
    );
    const shippingRemoved = {
      ...quantitiesRestored,
      shippingLines: quantitiesRestored.shippingLines.map((line) => ({
        ...line,
        stagedStatus: "REMOVED",
      })),
    };
    const restoredCalc = shippingCalculated(
      "26.50",
      "5.00",
      "1.50",
      "20.00",
      "0.00",
      [calcLine(), calcLine(2, 10, 0)],
      [],
      "ADDED",
    );
    const restored = shippingOrder("26.50", "5.00", "1.50", "20.00", "0.00", [
      line(),
      line(2, 10, 0),
    ]);
    const calculate = vi.fn(async () => {
      throw new Error("Recovery must use saved original shipping");
    });
    const h = harness(
      [
        pending,
        begin(currentCalc),
        quantity(quantitiesRestored),
        {
          orderEditRemoveShippingLine: {
            userErrors: [],
            calculatedOrder: shippingRemoved,
          },
        },
        {
          orderEditAddShippingLine: {
            userErrors: [],
            calculatedOrder: restoredCalc,
          },
        },
        pending,
        {
          orderEditCommit: { userErrors: [], order: { id: id("Order", 100) } },
        },
        restored,
      ],
      {},
      { calculate },
    );
    const result = await h.provider.recoverUnpaid(
      4,
      original.baseline,
      original.quote,
      "shipping-expiry",
    );
    expect(result).toMatchObject({
      totalCents: 2650,
      shippingCents: 500,
      taxCents: 150,
      outstandingCents: 0,
      netPaidCents: 2650,
    });
    expect(calculate).not.toHaveBeenCalled();
    expect(
      h.requests.find((request) =>
        request.query.includes("orderEditAddShippingLine"),
      )?.variables.shippingLine,
    ).toEqual({
      title: "Standard Shipping",
      price: { amount: "5.00", currencyCode: "USD" },
    });
    expect(
      h.requests.some((request) =>
        /refundCreate|suggestedRefund|draftOrderCalculate|orderEditAddVariant/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });
  it("recovers a free-to-paid shipping change using the saved original net fee, with strict proof of every cent and the replaced shipping lineage", async () => {
    const title = "Standard Shipping";
    const base = rawOrder({
      discountApplications: {
        nodes: [
          {
            __typename: "AutomaticDiscountApplication",
            index: 0,
            targetType: "SHIPPING_LINE",
            allocationMethod: "EACH",
            targetSelection: "ALL",
            title: "Member free shipping",
            value: { __typename: "PricingPercentageValue", percentage: 100 },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      shippingLines: {
        nodes: [
          {
            id: id("ShippingLine", 1),
            title,
            code: "standard",
            source: "Echelon Shipping",
            isRemoved: false,
            originalPriceSet: bag("5.00"),
            currentDiscountedPriceSet: bag("0.00"),
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const withShipping = (
      total: string,
      outstanding: string,
      subtotal: string,
      shipping: string,
      lines: ReturnType<typeof calcLine>[],
      added: ReturnType<typeof calcLine>[] = [],
      stagedStatus = "NONE",
    ) => ({
      ...calculated(total, outstanding, lines, added),
      subtotalPriceSet: bag(subtotal),
      shippingLines: [
        {
          id: id("CalculatedShippingLine", 1),
          title,
          price: bag(shipping),
          stagedStatus,
        },
      ],
    });
    const initial = withShipping("20.00", "0.00", "20.00", "5.00", [
      calcLine(),
    ]);
    const itemsChanged = withShipping(
      "25.00",
      "5.00",
      "25.00",
      "5.00",
      [calcLine()],
      [calcLine(2, 20, 1, "5.00")],
    );
    const removed = withShipping(
      "25.00",
      "5.00",
      "25.00",
      "5.00",
      [calcLine()],
      [calcLine(2, 20, 1, "5.00")],
      "REMOVED",
    );
    const repriced = withShipping(
      "33.00",
      "13.00",
      "25.00",
      "8.00",
      [calcLine()],
      [calcLine(2, 20, 1, "5.00")],
      "ADDED",
    );
    const h = harness(
      [
        base,
        base,
        { nodes: [variant()] },
        begin(initial),
        {
          orderEditAddVariant: {
            userErrors: [],
            calculatedLineItem: { id: id("CalculatedLineItem", 2) },
            calculatedOrder: itemsChanged,
          },
        },
        {
          orderEditRemoveShippingLine: {
            userErrors: [],
            calculatedOrder: removed,
          },
        },
        {
          orderEditAddShippingLine: {
            userErrors: [],
            calculatedOrder: repriced,
          },
        },
      ],
      {},
      {
        calculate: async () => ({
          ...freeShipping,
          netCents: 800,
          discountCents: 0,
          discountLabels: [],
        }),
      },
    );
    const baseline = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      baseline,
      { changes: [], additions: [{ variantId: "20", quantity: 1 }] },
      "edit-free-to-paid",
    );
    expect(quote.deltaCents).toBe(1300);
    const pending = rawOrder({
      fullyPaid: false,
      currentTotalPriceSet: bag("33.00"),
      currentSubtotalPriceSet: bag("25.00"),
      currentShippingPriceSet: bag("8.00"),
      totalOutstandingSet: bag("13.00"),
      lineItems: {
        nodes: [line(), line(2, 20, 1, "5.00")],
        pageInfo: { hasNextPage: false },
      },
      shippingLines: {
        nodes: [
          {
            id: id("ShippingLine", 2),
            title,
            code: null,
            source: null,
            isRemoved: false,
            originalPriceSet: bag("8.00"),
            currentDiscountedPriceSet: bag("8.00"),
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const restored = rawOrder({
      lineItems: {
        nodes: [line(), line(2, 20, 0, "5.00")],
        pageInfo: { hasNextPage: false },
      },
      shippingLines: {
        nodes: [
          {
            id: id("ShippingLine", 3),
            title,
            code: null,
            source: null,
            isRemoved: false,
            originalPriceSet: bag("0.00"),
            currentDiscountedPriceSet: bag("0.00"),
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const current = withShipping("33.00", "13.00", "25.00", "8.00", [
      calcLine(),
      calcLine(2, 20, 1, "5.00"),
    ]);
    const quantityRestored = withShipping("28.00", "8.00", "20.00", "8.00", [
      calcLine(),
      calcLine(2, 20, 0, "5.00"),
    ]);
    const shippingRemoved = withShipping(
      "20.00",
      "0.00",
      "20.00",
      "8.00",
      [calcLine(), calcLine(2, 20, 0, "5.00")],
      [],
      "REMOVED",
    );
    const final = withShipping(
      "20.00",
      "0.00",
      "20.00",
      "0.00",
      [calcLine(), calcLine(2, 20, 0, "5.00")],
      [],
      "ADDED",
    );
    const recovery = harness([
      pending,
      begin(current),
      quantity(quantityRestored),
      {
        orderEditRemoveShippingLine: {
          userErrors: [],
          calculatedOrder: shippingRemoved,
        },
      },
      { orderEditAddShippingLine: { userErrors: [], calculatedOrder: final } },
      pending,
      { orderEditCommit: { userErrors: [], order: { id: id("Order", 100) } } },
      restored,
      restored,
    ]);
    const observed = await recovery.provider.recoverUnpaid(
      4,
      baseline,
      quote,
      "expire-free-to-paid",
    );
    expect(observed).toMatchObject({
      totalCents: 2000,
      netPaidCents: 2000,
      shippingCents: 0,
      outstandingCents: 0,
      financials: { shippingGrossCents: 0, shippingDiscountCents: 0 },
    });
    expect(isUnpaidRecoveryRestored(observed, baseline, quote)).toBe(true);
    expect(isUnpaidRecoveryRestored(observed, baseline)).toBe(false);
    expect(
      isUnpaidRecoveryRestored(
        { ...observed, shippingCents: 1 },
        baseline,
        quote,
      ),
    ).toBe(false);
    expect(
      (
        await recovery.provider.reconcileRecovery(
          4,
          baseline,
          "expire-free-to-paid",
          quote,
        )
      ).status,
    ).toBe("restored");
  });
});

describe("ShopifyOrderEditProvider", () => {
  it.each(["missing code", "duplicate index", "unknown index"])(
    "rejects %s in original allocation evidence before starting an edit",
    async (problem) => {
      const order = fixedOrder();
      if (problem === "missing code")
        order.order.discountApplications.nodes[0].code = "";
      if (problem === "duplicate index")
        order.order.discountApplications.nodes.push(
          structuredClone(order.order.discountApplications.nodes[0]),
        );
      if (problem === "unknown index")
        order.order.lineItems.nodes[0].discountAllocations[0].discountApplication.index = 99;
      const h = harness([order]);
      await expect(h.provider.readOrder(4, "100")).rejects.toThrow();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].query).not.toContain("mutation");
    },
  );
  it("keeps an original fixed credit once when quantity increases and records its value separately", async () => {
    const { h, snapshot, quote } = await fixedIncrease();
    expect(snapshot.financials?.itemDiscounts).toEqual([
      {
        key: "code:REWARD20",
        label: "REWARD20",
        amountCents: 2000,
        value: { type: "fixed", amountCents: 2000 },
      },
    ]);
    expect(quote).toMatchObject({
      totalCents: 13000,
      deltaCents: 5000,
      outstandingCents: 5000,
      financials: {
        itemsGrossCents: 15000,
        itemsDiscountCents: 2000,
        itemsNetCents: 13000,
        itemDiscounts: snapshot.financials?.itemDiscounts,
      },
    });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|refundCreate|orderEditAddLineItemDiscount|discountCodeBasicCreate/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });
  it("does not invent a named discount amount from stale original allocations after an earlier edit", async () => {
    const order = fixedOrder();
    order.order.lineItems.nodes[0].discountAllocations[0].allocatedAmountSet =
      bag("20.00");
    const h = harness([order]);
    const snapshot = await h.provider.readOrder(4, "100");
    expect(snapshot.financials?.itemsDiscountCents).toBe(2000);
    expect(snapshot.financials?.itemDiscounts).toBeUndefined();
    expect(snapshot.financials?.itemDiscountLabels).toEqual(["REWARD20"]);
  });

  it("allows removal when Shopify preserves the full fixed credit on the remaining eligible item", async () => {
    const h = harness([
      fixedOrder(),
      fixedOrder(),
      begin(fixedCalculated()),
      quantity(fixedCalculated(0, "0.00", "20.00")),
      refundCapacity("80.00"),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      {
        changes: [{ lineItemId: "1", quantity: 0 }],
        additions: [],
      },
      "fixed-edit",
    );
    expect(quote).toMatchObject({
      totalCents: 3000,
      deltaCents: -5000,
      outstandingCents: -5000,
      financials: {
        itemsGrossCents: 5000,
        itemsDiscountCents: 2000,
        itemsNetCents: 3000,
      },
      evidence: { refundPreflight: { amountCents: 5000 } },
    });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|refundCreate|orderEditAddLineItemDiscount/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });

  it("adds an eligible product without spending the same fixed reward a second time", async () => {
    const added = calcLine(3, 30, 1, "5.00");
    const changed = {
      ...fixedCalculated(),
      subtotalPriceSet: bag("85.00"),
      totalPriceSet: bag("85.00"),
      totalOutstandingSet: bag("5.00"),
      addedLineItems: { nodes: [added], pageInfo: { hasNextPage: false } },
    };
    const h = harness([
      fixedOrder(),
      fixedOrder(),
      { nodes: [variant(30)] },
      begin(fixedCalculated()),
      {
        orderEditAddVariant: {
          userErrors: [],
          calculatedLineItem: { id: added.id },
          calculatedOrder: changed,
        },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [], additions: [{ variantId: "30", quantity: 1 }] },
      "fixed-edit",
    );
    expect(quote).toMatchObject({
      totalCents: 8500,
      deltaCents: 500,
      financials: { itemsDiscountCents: 2000 },
    });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|refundCreate|orderEditAddLineItemDiscount|discountCodeBasicCreate/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });

  it("preserves an accepted percentage plus fixed credit combination and rejects shifted per-code readback", async () => {
    const order = fixedOrder();
    order.order.discountApplications.nodes.push({
      ...order.order.discountApplications.nodes[0],
      index: 1,
      code: "TEN",
      value: { __typename: "PricingPercentageValue", percentage: 10 },
    });
    order.order.lineItems.nodes.forEach((entry) => {
      entry.priceAfterAllDiscountsBeforeTaxesSet = bag("35.00");
      entry.discountAllocations.push({
        allocatedAmountSet: bag("5.00"),
        discountApplication: { index: 1 },
      });
    });
    Object.assign(order.order, {
      currentSubtotalPriceSet: bag("70.00"),
      currentTotalPriceSet: bag("70.00"),
      netPaymentSet: bag("70.00"),
      transactions: [tx(1, "70.00")],
    });
    const calculatedOrder = (firstQuantity: number) => {
      const result = fixedCalculated(firstQuantity);
      result.lineItems.nodes.forEach((entry, index) => {
        const fixedApplication =
          entry.calculatedDiscountAllocations[0].discountApplication;
        entry.calculatedDiscountAllocations.push({
          allocatedAmountSet: bag(
            index === 0 && firstQuantity === 2 ? "10.00" : "5.00",
          ),
          discountApplication: {
            ...fixedApplication,
            id: id("CalculatedDiscountApplication", 2),
            code: "TEN",
            description: "TEN",
            value: { __typename: "PricingPercentageValue", percentage: 10 },
          },
        });
      });
      const total = firstQuantity === 1 ? "70.00" : "115.00";
      Object.assign(result, {
        subtotalPriceSet: bag(total),
        totalPriceSet: bag(total),
        totalOutstandingSet: bag(firstQuantity === 1 ? "0.00" : "45.00"),
      });
      return result;
    };
    const h = harness([
      order,
      order,
      { nodes: [variant(10, "50.00")] },
      begin(calculatedOrder(1)),
      quantity(calculatedOrder(2)),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
      "stacked-edit",
    );
    expect(quote).toMatchObject({
      totalCents: 11500,
      deltaCents: 4500,
      financials: {
        itemsGrossCents: 15000,
        itemsDiscountCents: 3500,
        itemDiscounts: [
          {
            key: "code:REWARD20",
            amountCents: 2000,
            value: { type: "fixed", amountCents: 2000 },
          },
          {
            key: "code:TEN",
            amountCents: 1500,
            value: { type: "percentage", percentage: "10" },
          },
        ],
      },
    });
    const after = structuredClone(order);
    const first = after.order.lineItems.nodes[0];
    first.currentQuantity = 2;
    first.unfulfilledQuantity = 2;
    first.unfulfilledDiscountedTotalSet = bag("100.00");
    first.priceAfterAllDiscountsBeforeTaxesSet = bag("80.00");
    first.discountAllocations[1].allocatedAmountSet = bag("10.00");
    Object.assign(after.order, {
      fullyPaid: false,
      currentSubtotalPriceSet: bag("115.00"),
      currentTotalPriceSet: bag("115.00"),
      totalOutstandingSet: bag("45.00"),
    });
    const commit = {
      orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] },
    };
    const good = harness([
      order,
      { nodes: [variant(10, "50.00")] },
      commit,
      after,
    ]);
    expect(
      (await good.provider.commit(4, quote, "stacked-edit")).outstandingCents,
    ).toBe(4500);
    const shifted = structuredClone(after);
    shifted.order.lineItems.nodes[0].discountAllocations[0].allocatedAmountSet =
      bag("15.00");
    shifted.order.lineItems.nodes[0].discountAllocations[1].allocatedAmountSet =
      bag("5.00");
    const bad = harness([
      order,
      { nodes: [variant(10, "50.00")] },
      commit,
      shifted,
    ]);
    await expect(
      bad.provider.commit(4, quote, "stacked-edit"),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(
      bad.requests.filter((request) =>
        request.query.includes("orderEditCommit"),
      ),
    ).toHaveLength(1);
  });

  it.each(["lost on removal", "multiplied on growth"])(
    "blocks a fixed credit %s before commit or financial settlement",
    async (change) => {
      const removal = change === "lost on removal";
      const h = harness([
        fixedOrder(),
        fixedOrder(),
        ...(!removal ? [{ nodes: [variant(10, "50.00")] }] : []),
        begin(fixedCalculated()),
        quantity(
          removal
            ? fixedCalculated(0, "0.00", "10.00")
            : fixedCalculated(2, "30.00", "10.00"),
        ),
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      await expect(
        h.provider.quote(
          4,
          snapshot,
          {
            changes: [{ lineItemId: "1", quantity: removal ? 0 : 2 }],
            additions: [],
          },
          "fixed-edit",
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_FIXED_DISCOUNT_MISMATCH" });
      expect(
        h.requests.some((request) =>
          /orderEditCommit|refundCreate|orderEditAddLineItemDiscount|suggestedRefund/.test(
            request.query,
          ),
        ),
      ).toBe(false);
    },
  );

  it.each(["value", "type"])(
    "rejects changed fixed code %s even if the revised allocation still totals $20",
    async (change) => {
      const result = fixedCalculated(2);
      result.lineItems.nodes.forEach((entry) => {
        entry.calculatedDiscountAllocations[0].discountApplication.value =
          change === "value"
            ? { __typename: "MoneyV2", amount: "25.00", currencyCode: "USD" }
            : { __typename: "PricingPercentageValue", percentage: 20 };
      });
      const h = harness([
        fixedOrder(),
        fixedOrder(),
        { nodes: [variant(10, "50.00")] },
        begin(fixedCalculated()),
        quantity(result),
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      await expect(
        h.provider.quote(
          4,
          snapshot,
          { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
          "fixed-edit",
        ),
      ).rejects.toMatchObject({ code: "PROMOTION_PARITY_UNVERIFIED" });
    },
  );

  it("restores the original fixed credit and quantities after wholly unpaid payment expiry", async () => {
    const { snapshot, quote } = await fixedIncrease();
    const pending = fixedOrder(2);
    const h = harness([
      pending,
      begin(fixedCalculated(2)),
      quantity(fixedCalculated()),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      fixedOrder(),
    ]);
    const restored = await h.provider.recoverUnpaid(
      4,
      snapshot,
      quote,
      "fixed-expire",
    );
    expect(restored.financials).toEqual(snapshot.financials);
    expect(restored.outstandingCents).toBe(0);
    expect(
      h.requests.some((request) =>
        /refundCreate|orderEditAddLineItemDiscount|discountCodeBasicCreate/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });

  it("blocks unused fixed credit before applying an edit instead of silently forfeiting or redeeming it again", async () => {
    const order = fixedOrder();
    const initial = fixedCalculated();
    // Original credit exceeds the remaining $50 item after removal.
    order.order.discountApplications.nodes[0].value = {
      __typename: "MoneyV2",
      amount: "60.00",
      currencyCode: "USD",
    };
    order.order.lineItems.nodes.forEach((entry) => {
      entry.priceAfterAllDiscountsBeforeTaxesSet = bag("20.00");
      entry.discountAllocations[0].allocatedAmountSet = bag("30.00");
    });
    Object.assign(order.order, {
      currentSubtotalPriceSet: bag("40.00"),
      currentTotalPriceSet: bag("40.00"),
      netPaymentSet: bag("40.00"),
      transactions: [tx(1, "40.00")],
    });
    initial.lineItems.nodes.forEach((entry) => {
      entry.calculatedDiscountAllocations[0].allocatedAmountSet = bag("30.00");
      entry.calculatedDiscountAllocations[0].discountApplication.value = {
        __typename: "MoneyV2",
        amount: "60.00",
        currencyCode: "USD",
      };
    });
    Object.assign(initial, {
      subtotalPriceSet: bag("40.00"),
      totalPriceSet: bag("40.00"),
      totalOutstandingSet: bag("0.00"),
    });
    const result = fixedCalculated(0, "0.00", "50.00");
    result.lineItems.nodes.forEach((entry) => {
      entry.calculatedDiscountAllocations[0].discountApplication.value = {
        __typename: "MoneyV2",
        amount: "60.00",
        currencyCode: "USD",
      };
    });
    result.totalOutstandingSet = bag("-40.00");
    const h = harness([order, order, begin(initial), quantity(result)]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 0 }], additions: [] },
        "fixed-edit",
      ),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_FIXED_CREDIT_SETTLEMENT_REQUIRED",
    });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|refundCreate|discountCodeBasicCreate/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });

  it("reconciles the captured free-shipping baseline without comparing its cart summary to product allocations", async () => {
    // Captured through Shopify 2026-10 orderEditBegin; only identities were anonymized.
    const captured: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/shopify-shipping-discount-calculated-order.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const h = harness([
      shippingOnlyOrder(),
      shippingOnlyOrder(),
      begin(captured),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({
      totalCents: 18798,
      deltaCents: 0,
      outstandingCents: 0,
      financials: {
        itemsDiscountCents: 0,
        itemsNetCents: 18798,
        shippingGrossCents: 999,
        shippingDiscountCents: 999,
        shippingCents: 0,
        totalCents: 18798,
      },
    });
    expect(h.requests).toHaveLength(3);
    expect(
      h.requests.filter((request) => request.query.includes("mutation")),
    ).toHaveLength(1);
    expect(h.requests.at(-1)?.query).toContain("orderEditBegin");
    expect(quote.lines.map((line) => line.calculatedLineId)).toEqual([
      id("CalculatedLineItem", 501),
      id("CalculatedLineItem", 502),
    ]);
  });

  it("shows exact current product discounts separately from free shipping", async () => {
    const h = harness([codeOrder()]);
    const snapshot = await h.provider.readOrder(4, "100");
    expect(snapshot.financials).toMatchObject({
      itemsGrossCents: 11995,
      itemsDiscountCents: 1199,
      itemsNetCents: 10796,
      itemDiscountLabels: ["AMAZZIN'"],
      shippingGrossCents: 1299,
      shippingDiscountCents: 1299,
      shippingCents: 0,
      shippingDiscountLabels: ["Free shipping"],
      taxCents: 0,
      totalCents: 10796,
      lines: [
        { id: id("LineItem", 1), netCents: 1796 },
        { id: id("LineItem", 2), netCents: 9000 },
      ],
    });
    expect(snapshot.lines[0].totalCents).toBe(1996); // Preserve the legacy fingerprint contract.
  });

  it("uses Shopify's rounded native percentage allocations without applying the code twice", async () => {
    const { h, quote } = await codeIncrease();
    expect(quote).toMatchObject({
      totalCents: 11245,
      deltaCents: 449,
      outstandingCents: 449,
      financials: {
        itemsGrossCents: 12494,
        itemsDiscountCents: 1249,
        itemsNetCents: 11245,
        shippingGrossCents: 1299,
        shippingDiscountCents: 1299,
        shippingCents: 0,
        totalCents: 11245,
      },
    });
    expect(
      h.requests.some((request) =>
        request.query.includes("orderEditAddLineItemDiscount"),
      ),
    ).toBe(false);
  });

  it("rejects an edit baseline that reallocates a cent between items before any requested change", async () => {
    const calculatedBaseline = codeCalculated();
    calculatedBaseline.lineItems.nodes[0].calculatedDiscountAllocations[0].allocatedAmountSet =
      bag("2.01");
    calculatedBaseline.lineItems.nodes[1].calculatedDiscountAllocations[0].allocatedAmountSet =
      bag("9.98");
    const h = harness([
      codeOrder(),
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      begin(calculatedBaseline),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_PERCENTAGE_DISCOUNT_MISMATCH",
    });
    expect(
      h.requests.some((request) =>
        request.query.includes("orderEditSetQuantity"),
      ),
    ).toBe(false);
  });

  it.each([
    "removed",
    "changed percentage",
    "changed code",
    "replaced identity",
  ])("rejects a native discount %s before commit", async (change) => {
    const result = codeCalculated(
      5,
      "2.50",
      "112.45",
      change === "replaced identity" ? 9 : 1,
    );
    if (change === "removed")
      result.lineItems.nodes.forEach((entry) => {
        entry.calculatedDiscountAllocations = [];
      });
    if (change === "changed percentage")
      result.lineItems.nodes.forEach((entry) => {
        entry.calculatedDiscountAllocations[0].discountApplication.value = {
          __typename: "PricingPercentageValue",
          percentage: 20,
        };
      });
    if (change === "changed code")
      result.lineItems.nodes.forEach((entry) => {
        entry.calculatedDiscountAllocations[0].discountApplication.code =
          "OTHER10";
      });
    const h = harness([
      codeOrder(),
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      begin(codeCalculated()),
      quantity(result),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "PROMOTION_PARITY_UNVERIFIED" });
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
  });

  it("rejects product allocations that do not reconcile to Shopify's quoted subtotal", async () => {
    const result = codeCalculated(5, "2.50", "112.45");
    result.lineItems.nodes[0].calculatedDiscountAllocations[0].allocatedAmountSet =
      bag("2.49");
    result.cartDiscountAmountSet = bag("12.48");
    const h = harness([
      codeOrder(),
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      begin(codeCalculated()),
      quantity(result),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_DISCOUNT_SUBTOTAL_MISMATCH" });
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
  });

  it.each([null, "0.00", "9.99"])(
    "preserves free shipping without equating cart summary %s to product allocations",
    async (cartDiscount) => {
      const h = harness([
        shippingOnlyOrder(),
        shippingOnlyOrder(),
        { nodes: [variant(10, "47.99")] },
        begin(shippingOnlyCalculated(1, cartDiscount)),
        quantity(shippingOnlyCalculated(2, cartDiscount)),
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      const quote = await h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      );
      expect(quote).toMatchObject({
        totalCents: 23597,
        deltaCents: 4799,
        outstandingCents: 4799,
        financials: {
          itemsGrossCents: 23597,
          itemsDiscountCents: 0,
          itemsNetCents: 23597,
          shippingGrossCents: 999,
          shippingDiscountCents: 999,
          shippingCents: 0,
          totalCents: 23597,
        },
      });
      expect(
        h.requests.some((request) =>
          request.query.includes("cartDiscountAmountSet"),
        ),
      ).toBe(false);
      expect(
        h.requests.some((request) =>
          /orderEditCommit|refundCreate|orderEditAddLineItemDiscount/.test(
            request.query,
          ),
        ),
      ).toBe(false);
    },
  );

  it("reconciles native percentage allocations even when an unused cart summary differs", async () => {
    const result = codeCalculated(5, "2.50", "112.45");
    result.cartDiscountAmountSet = bag("12.48");
    const h = harness([
      codeOrder(),
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      begin(codeCalculated()),
      quantity(result),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
      "edit-1",
    );
    expect(quote.financials).toMatchObject({
      itemsDiscountCents: 1249,
      itemsNetCents: 11245,
      totalCents: 11245,
    });
  });

  it.each(["subtotal", "shipping total", "tax"])(
    "rejects a free-shipping quote with inconsistent %s before commit",
    async (field) => {
      const result = shippingOnlyCalculated(2, "9.99");
      if (field === "subtotal") result.subtotalPriceSet = bag("235.96");
      if (field === "shipping total") {
        result.totalPriceSet = bag("245.96");
        result.totalOutstandingSet = bag(
          decimal(cents("245.96") - cents("187.98")),
        );
      }
      if (field === "tax") result.taxLines = [{ priceSet: bag("0.01") }];
      const h = harness([
        shippingOnlyOrder(),
        shippingOnlyOrder(),
        { nodes: [variant(10, "47.99")] },
        begin(shippingOnlyCalculated(1, "9.99")),
        quantity(result),
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      await expect(
        h.provider.quote(
          4,
          snapshot,
          { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
          "edit-1",
        ),
      ).rejects.toMatchObject({
        code:
          field === "subtotal"
            ? "ORDER_EDIT_DISCOUNT_SUBTOTAL_MISMATCH"
            : "ORDER_EDIT_FINANCIAL_MISMATCH",
      });
      expect(
        h.requests.some((request) =>
          /orderEditCommit|refundCreate/.test(request.query),
        ),
      ).toBe(false);
    },
  );

  it("rejects changed gross shipping even if a discount hides it in the order total", async () => {
    const result = codeCalculated(5, "2.50", "112.45");
    result.shippingLines[0].price = bag("19.99");
    const h = harness([
      codeOrder(),
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      begin(codeCalculated()),
      quantity(result),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "SHIPPING_CHANGED" });
  });

  it("verifies discounted per-line amounts and rules on post-commit readback", async () => {
    const { quote } = await codeIncrease();
    const h = harness([
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      codeOrder(5, "22.46", "112.46"),
    ]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toMatchObject({
      code: "COMMIT_UNCONFIRMED",
      outcome: "unknown",
    });
    const exact = harness([
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      codeOrder(5, "22.44", "112.45", "90.01"),
    ]);
    // The header total is unchanged, but the per-line discount allocation has drifted.
    await expect(
      exact.provider.commit(4, quote, "edit-1"),
    ).rejects.toMatchObject({ outcome: "unknown" });
    const good = harness([
      codeOrder(),
      { nodes: [variant(10, "4.99")] },
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      codeOrder(5, "22.45", "112.45"),
    ]);
    expect(
      (await good.provider.commit(4, quote, "edit-1")).outstandingCents,
    ).toBe(449);
  });

  it("rejects a changed code value even when the legacy fingerprint and total are unchanged", async () => {
    const { quote } = await codeIncrease();
    const raw = codeOrder();
    raw.order.discountApplications.nodes[1].value.percentage = 20;
    const h = harness([raw]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toBeInstanceOf(
      OrderEditCommitNotSentError,
    );
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].query).not.toContain("mutation");
  });

  it("restores a native discounted quantity increase and free shipping after payment expiry", async () => {
    const { snapshot, quote } = await codeIncrease();
    const pending = codeOrder(5, "22.45", "112.45");
    const h = harness([
      pending,
      begin(codeCalculated(5, "2.50", "112.45")),
      quantity(codeCalculated()),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      codeOrder(),
    ]);
    const restored = await h.provider.recoverUnpaid(
      4,
      snapshot,
      quote,
      "expire-1",
    );
    expect(restored.financials).toEqual(snapshot.financials);
    expect(restored.outstandingCents).toBe(0);
    expect(
      h.requests.some((request) =>
        /refundCreate|orderEditAddLineItemDiscount/.test(request.query),
      ),
    ).toBe(false);
  });

  it("quotes a discounted reduction and prepares a refund for the net difference", async () => {
    const h = harness([
      codeOrder(),
      codeOrder(),
      begin(codeCalculated()),
      quantity(codeCalculated(3, "1.50", "103.47")),
      refundCapacity("107.96"),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 3 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({
      totalCents: 10347,
      deltaCents: -449,
      outstandingCents: -449,
      financials: {
        itemsGrossCents: 11496,
        itemsDiscountCents: 1149,
        shippingDiscountCents: 1299,
        totalCents: 10347,
      },
    });
    expect(quote.evidence.refundPreflight).toMatchObject({ amountCents: 449 });
    const reduced = codeOrder(3, "13.47", "103.47");
    const refund = harness([reduced, reduced, refundCapacity("107.96")]);
    const changed = await refund.provider.readOrder(4, "100");
    expect(
      await refund.provider.prepareRefund(4, changed, "edit-1", "refund-key"),
    ).toMatchObject({ amountCents: 449 });
  });

  it("includes Shopify's recalculated tax in the discounted total and payment difference", async () => {
    const raw = codeOrder();
    Object.assign(raw.order, {
      currentTotalPriceSet: bag("114.44"),
      currentTotalTaxSet: bag("6.48"),
      netPaymentSet: bag("114.44"),
      transactions: [tx(1, "114.44")],
    });
    const initial = {
      ...codeCalculated(),
      totalPriceSet: bag("114.44"),
      taxLines: [{ priceSet: bag("6.48") }],
    };
    const changed = {
      ...codeCalculated(5, "2.50", "112.45"),
      totalPriceSet: bag("119.20"),
      totalOutstandingSet: bag("4.76"),
      taxLines: [{ priceSet: bag("6.75") }],
    };
    const h = harness([
      raw,
      raw,
      { nodes: [variant(10, "4.99")] },
      begin(initial),
      quantity(changed),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 5 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({
      totalCents: 11920,
      deltaCents: 476,
      financials: { itemsNetCents: 11245, taxCents: 675, totalCents: 11920 },
    });
  });

  it("combines native percentage codes with a verified member price on an added product", async () => {
    const source = codeOrder();
    const raw = {
      ...source,
      order: {
        ...source.order,
        customer: {
          ...source.order.customer,
          membershipPlan: { value: "plan-a" },
        },
      },
    };
    const base = codeCalculated();
    const native =
      base.lineItems.nodes[0].calculatedDiscountAllocations[0]
        .discountApplication;
    const added = {
      ...calcLine(3, 30, 1, "5.00"),
      calculatedDiscountAllocations: [
        { allocatedAmountSet: bag("0.50"), discountApplication: native },
      ],
    };
    const member = calcLine(3, 30, 1, "5.00", "4.00");
    member.calculatedDiscountAllocations.push({
      allocatedAmountSet: bag("0.40"),
      discountApplication: native,
    });
    const addedOrder = {
      ...base,
      totalPriceSet: bag("112.46"),
      totalOutstandingSet: bag("4.50"),
      subtotalPriceSet: bag("112.46"),
      cartDiscountAmountSet: bag("12.49"),
      addedLineItems: { nodes: [added], pageInfo: { hasNextPage: false } },
    };
    const memberOrder = {
      ...base,
      totalPriceSet: bag("111.56"),
      totalOutstandingSet: bag("3.60"),
      subtotalPriceSet: bag("111.56"),
      cartDiscountAmountSet: bag("12.39"),
      addedLineItems: { nodes: [member], pageInfo: { hasNextPage: false } },
    };
    const h = harness([
      raw,
      raw,
      {
        nodes: [
          variant(30, "5.00", JSON.stringify({ "plan-a": { cents: 400 } })),
        ],
      },
      begin(base),
      {
        orderEditAddVariant: {
          userErrors: [],
          calculatedLineItem: { id: member.id },
          calculatedOrder: addedOrder,
        },
      },
      {
        orderEditAddLineItemDiscount: {
          userErrors: [],
          calculatedOrder: memberOrder,
        },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [], additions: [{ variantId: "30", quantity: 1 }] },
      "edit-1",
    );
    expect(quote).toMatchObject({
      totalCents: 11156,
      deltaCents: 360,
      financials: {
        itemsGrossCents: 12495,
        itemsDiscountCents: 1339,
        itemsNetCents: 11156,
      },
    });
    expect(
      quote.financials?.lines.find((entry) => entry.id === member.id)?.netCents,
    ).toBe(360);
    expect(
      h.requests.filter((request) =>
        request.query.includes("mutation EchelonEditMemberPrice"),
      ),
    ).toHaveLength(1);

    function withMemberLine(memberQuantity: number) {
      const original = line(303, 30, memberQuantity, "5.00");
      const current = {
        ...raw.order,
        fullyPaid: memberQuantity === 0,
        currentTotalPriceSet: bag(memberQuantity === 0 ? "107.96" : "111.56"),
        currentSubtotalPriceSet: bag(
          memberQuantity === 0 ? "107.96" : "111.56",
        ),
        totalOutstandingSet: bag(memberQuantity === 0 ? "0.00" : "3.60"),
        lineItems: {
          ...raw.order.lineItems,
          nodes: [
            ...raw.order.lineItems.nodes,
            {
              ...original,
              discountedUnitPriceSet: bag("4.00"),
              unfulfilledDiscountedTotalSet: bag(
                memberQuantity === 0 ? "0.00" : "4.00",
              ),
              priceAfterAllDiscountsBeforeTaxesSet: bag(
                memberQuantity === 0 ? "0.00" : "3.60",
              ),
              discountAllocations: [
                {
                  allocatedAmountSet: bag("0.40"),
                  discountApplication: { index: 1 },
                },
                {
                  allocatedAmountSet: bag("1.00"),
                  discountApplication: { index: 2 },
                },
              ],
            },
          ],
        },
        discountApplications: {
          ...raw.order.discountApplications,
          nodes: [
            ...raw.order.discountApplications.nodes,
            {
              __typename: "ManualDiscountApplication",
              index: 2,
              targetType: "LINE_ITEM",
              allocationMethod: "EACH",
              targetSelection: "EXPLICIT",
              title: "Echelon member pricing",
              value: {
                __typename: "MoneyV2",
                amount: "1.00",
                currencyCode: "USD",
              },
            },
          ],
        },
      };
      return { ...raw, order: current };
    }
    const pending = withMemberLine(1);
    const postCommit = harness([
      raw,
      { nodes: [variant(30, "5.00")] },
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      pending,
    ]);
    expect(
      (await postCommit.provider.commit(4, quote, "edit-1")).outstandingCents,
    ).toBe(360);
    const removed = {
      ...member,
      quantity: 0,
      editableSubtotalSet: bag("0.00"),
    };
    const restoredCalculated = {
      ...base,
      lineItems: {
        ...base.lineItems,
        nodes: [...base.lineItems.nodes, removed],
      },
    };
    const recoveryStart = {
      ...memberOrder,
      addedLineItems: { ...memberOrder.addedLineItems, nodes: [] },
      lineItems: {
        ...base.lineItems,
        nodes: [...base.lineItems.nodes, member],
      },
    };
    const recovery = harness([
      pending,
      begin(recoveryStart),
      quantity(restoredCalculated),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      withMemberLine(0),
    ]);
    const restored = await recovery.provider.recoverUnpaid(
      4,
      snapshot,
      quote,
      "expire-1",
    );
    expect(isUnpaidRecoveryRestored(restored, snapshot)).toBe(true);
    expect(restored.financials?.itemDiscountLabels).toEqual(["AMAZZIN'"]);
  });

  it("fails closed when the displayed financial components cannot reconcile", async () => {
    const raw = codeOrder();
    raw.order.currentTotalPriceSet = bag("107.95");
    await expect(
      harness([raw]).provider.readOrder(4, "100"),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_FINANCIAL_MISMATCH" });
    await expect(
      harness([
        rawOrder({ taxesIncluded: true, currentTotalTaxSet: bag("1.00") }),
      ]).provider.readOrder(4, "100"),
    ).rejects.toMatchObject({ code: "TAX_INCLUDED_UNSUPPORTED" });
  });
  it("validates exact money, complete history, and specific connection credentials", async () => {
    const wrong = harness([], { connectionId: 8 });
    await expect(wrong.provider.readOrder(4, "100")).rejects.toMatchObject({
      code: "CONNECTION_INVALID",
    });
    expect(wrong.fetchImpl).not.toHaveBeenCalled();
    const money = harness([rawOrder({ currentTotalPriceSet: bag("20.001") })]);
    await expect(money.provider.readOrder(4, "100")).rejects.toMatchObject({
      code: "MONEY_INVALID",
    });
    const history = harness([
      rawOrder({ transactionsCount: { count: 2, precision: "EXACT" } }),
    ]);
    await expect(history.provider.readOrder(4, "100")).rejects.toMatchObject({
      code: "INCOMPLETE_ORDER",
    });
  });

  it("rejects forged or corrupted persisted financial evidence before requests", async () => {
    const { snapshot, quote } = await reduction();
    const h = harness([]);
    const corrupt = structuredClone(snapshot);
    corrupt.lines[0].totalCents = 1.5;
    await expect(
      h.provider.quote(
        4,
        corrupt,
        { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    for (const field of ["originalUnitPriceCents", "quantity"] as const) {
      const fractional = structuredClone(snapshot);
      fractional.lines[0][field] = 1.5;
      await expect(
        h.provider.quote(
          4,
          fractional,
          { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
          "edit-1",
        ),
      ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    }
    await expect(
      h.provider.commit(4, { ...quote, deltaCents: 1 }, "edit-1"),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    await expect(
      h.provider.commit(4, { ...quote, totalCents: 1.5 }, "edit-1"),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    const changedPlan = structuredClone(quote);
    changedPlan.plan.changes[0].quantity = 0;
    await expect(
      h.provider.commit(4, changedPlan, "edit-1"),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    await expect(
      h.provider.refund(
        4,
        { ...refundIntent(snapshot), note: "someone else's operation" },
        NOW.toISOString(),
      ),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "http://test.myshopify.com/pay",
    "https://test.myshopify.com@evil.example/pay",
    "https://evil.example/pay",
    "https://user:password@test.myshopify.com/pay",
  ])("rejects an unsafe payment URL %s", async (url) => {
    const h = harness([
      rawOrder({
        paymentCollectionDetails: { additionalPaymentCollectionUrl: url },
      }),
    ]);
    await expect(h.provider.readOrder(4, "100")).rejects.toMatchObject({
      code: "PAYMENT_URL_INVALID",
    });
  });

  it("stages a reduction without refunds, notifications, restocking, or committing", async () => {
    const h = harness([
      rawOrder(),
      rawOrder(),
      begin(),
      quantity(calculated("10.00", "-10.00", [calcLine(1, 10, 1)])),
      refundCapacity(),
    ]);
    const original = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      original,
      { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({
      totalCents: 1000,
      deltaCents: -1000,
      outstandingCents: -1000,
    });
    expect(original.lines[0].quantity).toBe(2);
    expect(
      h.requests.find((request) =>
        request.query.includes("orderEditSetQuantity"),
      )?.query,
    ).toContain("restock: false");
    expect(quote.evidence.refundPreflight).toEqual({
      amountCents: 1000,
      parentTransactionId: id("OrderTransaction", 1),
      gateway: "shopify_payments",
    });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|refundCreate/.test(request.query),
      ),
    ).toBe(false);
  });

  it("rejects invalid quantities and unsupported pending/partial payment before staging", async () => {
    const raw = rawOrder({
      fullyPaid: false,
      totalOutstandingSet: bag("5.00"),
      transactions: [tx(1, "15.00", "SALE", "PENDING")],
    });
    const h = harness([raw, raw]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: -1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "EDIT_PLAN_INVALID" });
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PAYMENT_STATE" });
    expect(h.requests).toHaveLength(2);
  });

  it("does not guess the identity of duplicate original variants", async () => {
    const raw = rawOrder({
      currentSubtotalPriceSet: bag("40.00"),
      currentTotalPriceSet: bag("40.00"),
      netPaymentSet: bag("40.00"),
      transactions: [tx(1, "40.00")],
      lineItems: { nodes: [line(), line(2)], pageInfo: { hasNextPage: false } },
    });
    const h = harness([raw, raw]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_IDENTITY" });
    expect(h.requests).toHaveLength(2);
  });

  it("detects a changed original price in Shopify's staged response", async () => {
    const h = harness([
      rawOrder(),
      rawOrder(),
      begin(),
      quantity(calculated("12.00", "-8.00", [calcLine(1, 10, 1, "12.00")])),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "QUOTE_PRICE_MISMATCH" });
  });

  it("adds an already ordered variant as a separately tracked line at the projected member price", async () => {
    const raw = rawOrder({
      customer: {
        id: id("Customer", 1),
        tags: [],
        membershipPlan: { value: "plan-a" },
      },
    });
    const h = harness([
      raw,
      raw,
      {
        nodes: [
          variant(10, "10.00", JSON.stringify({ "plan-a": { cents: 800 } })),
        ],
      },
      begin(),
      {
        orderEditAddVariant: {
          userErrors: [],
          calculatedLineItem: { id: id("CalculatedLineItem", 2) },
          calculatedOrder: calculated(
            "30.00",
            "10.00",
            [calcLine()],
            [calcLine(2, 10, 1)],
          ),
        },
      },
      {
        orderEditAddLineItemDiscount: {
          userErrors: [],
          calculatedOrder: calculated(
            "28.00",
            "8.00",
            [calcLine()],
            [calcLine(2, 10, 1, "10.00", "8.00")],
          ),
        },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [], additions: [{ variantId: "10", quantity: 1 }] },
      "edit-1",
    );
    expect(quote.lines[1]).toMatchObject({
      originalLineId: null,
      calculatedLineId: id("CalculatedLineItem", 2),
      discountedUnitPriceCents: 800,
    });
    expect(h.requests.at(-1)?.variables.discount).toEqual({
      description: "Echelon member pricing",
      fixedValue: { amount: "2.00", currencyCode: "USD" },
    });
  });

  it("increases an existing line with exact original pricing and incremental stock checks at quote and commit", async () => {
    const stock = {
      nodes: [{ ...variant(10, "10.00"), sellableOnlineQuantity: 1 }],
    };
    const updated = rawOrder({
      fullyPaid: false,
      lineItems: { nodes: [line(1, 10, 3)], pageInfo: { hasNextPage: false } },
      currentTotalPriceSet: bag("30.00"),
      currentSubtotalPriceSet: bag("30.00"),
      totalOutstandingSet: bag("10.00"),
    });
    const h = harness([
      rawOrder(),
      rawOrder(),
      stock,
      begin(),
      quantity(calculated("30.00", "10.00", [calcLine(1, 10, 3)])),
      rawOrder(),
      stock,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      updated,
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 3 }], additions: [] },
      "edit-1",
    );
    expect(quote.lines[0]).toMatchObject({
      originalLineId: id("LineItem", 1),
      quantity: 3,
      originalUnitPriceCents: 1000,
      discountedUnitPriceCents: 1000,
      totalCents: 3000,
    });
    expect((await h.provider.commit(4, quote, "edit-1")).lines[0].id).toBe(
      id("LineItem", 1),
    );
    expect(
      h.requests.filter((request) =>
        request.query.includes("EchelonEditVariantPrices"),
      ),
    ).toHaveLength(2);
    expect(
      h.requests.some((request) =>
        request.query.includes("orderEditAddVariant"),
      ),
    ).toBe(false);
    const depleted = harness([
      rawOrder(),
      { nodes: [{ ...variant(10, "10.00"), sellableOnlineQuantity: 0 }] },
    ]);
    await expect(
      depleted.provider.commit(4, quote, "edit-1"),
    ).rejects.toMatchObject({ code: "STOCK_CHANGED" });
    expect(
      depleted.requests.some((request) => request.query.startsWith("mutation")),
    ).toBe(false);
  });

  it("combines incremental stock demand when an increase and an addition use the same variant", async () => {
    const h = harness([
      rawOrder(),
      rawOrder(),
      { nodes: [{ ...variant(10, "10.00"), sellableOnlineQuantity: 2 }] },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        {
          changes: [{ lineItemId: "1", quantity: 3 }],
          additions: [{ variantId: "10", quantity: 2 }],
        },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "STOCK_UNAVAILABLE" });
    expect(h.requests.at(-1)?.variables.ids).toEqual([
      id("ProductVariant", 10),
    ]);
    expect(
      h.requests.some((request) => request.query.startsWith("mutation")),
    ).toBe(false);
  });

  it("blocks unverified product-specific promotion scope", async () => {
    const raw = rawOrder({
      discountApplications: {
        nodes: [
          {
            __typename: "DiscountCodeApplication",
            index: 0,
            targetType: "LINE_ITEM",
            allocationMethod: "ACROSS",
            targetSelection: "EXPLICIT",
            code: "SAVE",
            value: {
              __typename: "MoneyV2",
              amount: "5.00",
              currencyCode: "USD",
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const h = harness([raw, raw]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "PROMOTION_PARITY_UNVERIFIED" });
  });

  it.each(["manual", "gift_card", "multiple", "insufficient"])(
    "rejects an unsupported %s refund before committing a reduction",
    async (kind) => {
      const raw = rawOrder();
      const capacity = refundCapacity(
        kind === "insufficient" ? "9.00" : "20.00",
        kind === "gift_card" ? "gift_card" : "shopify_payments",
      );
      if (kind === "manual")
        raw.order.transactions[0].manualPaymentGateway = true;
      if (kind === "gift_card") raw.order.transactions[0].gateway = "gift_card";
      if (kind === "multiple")
        capacity.order.suggestedRefund.suggestedTransactions.push(
          structuredClone(
            capacity.order.suggestedRefund.suggestedTransactions[0],
          ),
        );
      const h = harness([
        raw,
        raw,
        begin(),
        quantity(calculated("10.00", "-10.00", [calcLine(1, 10, 1)])),
        capacity,
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      await expect(
        h.provider.quote(
          4,
          snapshot,
          { changes: [{ lineItemId: "1", quantity: 1 }], additions: [] },
          "edit-1",
        ),
      ).rejects.toMatchObject({
        code:
          kind === "multiple"
            ? "MULTIPLE_REFUND_TENDERS_UNSUPPORTED"
            : kind === "insufficient"
              ? "REFUND_CAPACITY_UNPROVEN"
              : "REFUND_METHOD_UNSUPPORTED",
      });
      expect(
        h.requests.some((request) =>
          /orderEditCommit|refundCreate/.test(request.query),
        ),
      ).toBe(false);
    },
  );

  it("rechecks automatic refund capacity immediately before commit", async () => {
    const { quote } = await reduction();
    const h = harness([rawOrder(), refundCapacity("9.00")]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toMatchObject({
      code: "REFUND_CAPACITY_UNPROVEN",
      outcome: "rejected",
    });
    expect(
      h.requests.some((request) => request.query.startsWith("mutation")),
    ).toBe(false);
  });

  it("blocks an increase whose duplicate lines cannot be distinguished for automatic expiry", async () => {
    const h = harness([
      rawOrder(),
      rawOrder(),
      { nodes: [variant(10, "10.00")] },
      begin(),
      {
        orderEditAddVariant: {
          userErrors: [],
          calculatedLineItem: { id: id("CalculatedLineItem", 2) },
          calculatedOrder: calculated(
            "40.00",
            "20.00",
            [calcLine()],
            [calcLine(2, 10, 2)],
          ),
        },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [], additions: [{ variantId: "10", quantity: 2 }] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "EXPIRY_LINEAGE_UNSUPPORTED" });
    expect(
      h.requests.some((request) => request.query.includes("orderEditCommit")),
    ).toBe(false);
    const quote = additionQuote(snapshot);
    quote.plan.additions = [{ variantId: "10", quantity: 2 }];
    Object.assign(quote.lines[1], {
      variantId: id("ProductVariant", 10),
      quantity: 2,
      originalUnitPriceCents: 1000,
      discountedUnitPriceCents: 1000,
      totalCents: 2000,
    });
    Object.assign(quote, {
      totalCents: 4000,
      outstandingCents: 2000,
      deltaCents: 2000,
    });
    const commit = harness([rawOrder()]);
    await expect(
      commit.provider.commit(4, quote, "edit-1"),
    ).rejects.toMatchObject({ code: "EXPIRY_LINEAGE_UNSUPPORTED" });
    expect(
      commit.requests.some((request) => request.query.startsWith("mutation")),
    ).toBe(false);
  });

  it("rejects insufficient stock before staging or committing an addition", async () => {
    const h = harness([
      rawOrder(),
      rawOrder(),
      { nodes: [{ ...variant(), sellableOnlineQuantity: 0 }] },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [], additions: [{ variantId: "20", quantity: 1 }] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "STOCK_UNAVAILABLE" });
    expect(
      h.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
    const commit = harness([
      rawOrder(),
      { nodes: [{ ...variant(), inventoryPolicy: "CONTINUE" }] },
    ]);
    await expect(
      commit.provider.commit(4, additionQuote(snapshot), "edit-1"),
    ).rejects.toMatchObject({
      code: "STOCK_CHANGED",
      name: "OrderEditCommitNotSentError",
    });
    expect(
      commit.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
  });

  it("does not commit an unpaid edit that fully removes an original line before same-line recovery is proven", async () => {
    const source = harness([rawOrder()]);
    const snapshot = await source.provider.readOrder(4, "100");
    const quote = additionQuote(snapshot);
    quote.plan.changes = [{ lineItemId: snapshot.lines[0].id, quantity: 0 }];
    quote.lines[0] = { ...quote.lines[0], quantity: 0, totalCents: 0 };
    quote.lines[1] = {
      ...quote.lines[1],
      originalUnitPriceCents: 3000,
      discountedUnitPriceCents: 3000,
      totalCents: 3000,
    };
    quote.totalCents = 3000;
    quote.outstandingCents = 1000;
    quote.deltaCents = 1000;
    const h = harness([rawOrder()]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toMatchObject({
      code: "EXPIRY_LINEAGE_UNSUPPORTED",
      name: "OrderEditCommitNotSentError",
    });
    expect(
      h.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
  });

  it("classifies a commit timeout as unknown and never resends it", async () => {
    const { quote } = await reduction();
    const h = harness([
      rawOrder(),
      refundCapacity(),
      new Error("network error"),
    ]);
    await expect(h.provider.commit(4, quote, "edit-1")).rejects.toMatchObject({
      code: "SHOPIFY_UNAVAILABLE",
      outcome: "unknown",
    });
    expect(
      h.requests.filter((request) => request.query.includes("orderEditCommit")),
    ).toHaveLength(1);
  });

  it("requires exact post-commit readback, with no customer notification", async () => {
    const { quote } = await reduction();
    const updated = rawOrder({
      lineItems: { nodes: [line(1, 10, 1)], pageInfo: { hasNextPage: false } },
      currentSubtotalPriceSet: bag("10.00"),
      currentTotalPriceSet: bag("10.00"),
      totalOutstandingSet: bag("-10.00"),
    });
    const h = harness([
      rawOrder(),
      refundCapacity(),
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      updated,
    ]);
    expect((await h.provider.commit(4, quote, "edit-1")).outstandingCents).toBe(
      -1000,
    );
    expect(
      h.requests.find((request) => request.query.includes("orderEditCommit"))
        ?.query,
    ).toContain("notifyCustomer: false");
    const wrong = harness([
      rawOrder(),
      refundCapacity(),
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      rawOrder(),
    ]);
    await expect(
      wrong.provider.commit(4, quote, "edit-1"),
    ).rejects.toMatchObject({
      code: "COMMIT_UNCONFIRMED",
      outcome: "unknown",
      name: "OrderEditProviderError",
    });
  });

  it("never marks an invalid post-mutation response as definitely not sent", async () => {
    const { quote } = await reduction();
    const h = harness([
      rawOrder(),
      refundCapacity(),
      { orderEditCommit: { order: null, userErrors: [] } },
    ]);
    const error = await h.provider
      .commit(4, quote, "edit-1")
      .catch((error: unknown) => error);
    expect(error).not.toBeInstanceOf(OrderEditCommitNotSentError);
    expect(error).toMatchObject({
      code: "SHOPIFY_RESPONSE_INVALID",
      outcome: "unknown",
    });
    expect(
      h.requests.filter((request) => request.query.includes("orderEditCommit")),
    ).toHaveLength(1);
  });

  it("reconciles an unchanged baseline without reissuing an ambiguous commit", async () => {
    const { snapshot, quote } = await reduction();
    const h = harness([rawOrder()]);
    expect(
      (await h.provider.reconcileCommit(4, snapshot, quote, "edit-1")).status,
    ).toBe("not_applied");
    expect(h.requests).toHaveLength(1);
  });

  it("creates an exact monetary refund intent after an order reduction", async () => {
    const raw = rawOrder({
      lineItems: { nodes: [line(1, 10, 1)], pageInfo: { hasNextPage: false } },
      currentSubtotalPriceSet: bag("10.00"),
      currentTotalPriceSet: bag("10.00"),
      totalOutstandingSet: bag("-10.00"),
    });
    const h = harness([
      raw,
      raw,
      {
        order: {
          id: id("Order", 100),
          suggestedRefund: {
            maximumRefundableSet: bag("20.00"),
            suggestedTransactions: [
              {
                kind: "SUGGESTED_REFUND",
                gateway: "shopify_payments",
                parentTransaction: { id: id("OrderTransaction", 1) },
                maximumRefundableSet: bag("20.00"),
              },
            ],
          },
        },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    expect(
      await h.provider.prepareRefund(4, snapshot, "edit-1", "refund-key"),
    ).toMatchObject({
      amountCents: 1000,
      parentTransactionId: id("OrderTransaction", 1),
      note: "Echelon order edit edit-1",
    });
  });

  it.each(["SUCCESS", "PENDING", "FAILURE"])(
    "proves refund transaction outcome %s without treating record creation as payment",
    async (status) => {
      const raw = rawOrder({
        lineItems: {
          nodes: [line(1, 10, 1)],
          pageInfo: { hasNextPage: false },
        },
        currentSubtotalPriceSet: bag("10.00"),
        currentTotalPriceSet: bag("10.00"),
        totalOutstandingSet: bag("-10.00"),
      });
      const result = {
        id: id("Refund", 9),
        note: "Echelon order edit edit-1",
        totalRefundedSet: bag("10.00"),
        transactions: {
          nodes: [tx(2, "10.00", "REFUND", status, 1)],
          pageInfo: { hasNextPage: false },
        },
      };
      const h = harness([
        raw,
        raw,
        { refundCreate: { refund: result, userErrors: [] } },
      ]);
      const snapshot = await h.provider.readOrder(4, "100");
      const intent = refundIntent(snapshot);
      const execution = h.provider.refund(4, intent, NOW.toISOString());
      if (status === "FAILURE")
        await expect(execution).rejects.toMatchObject({
          code: "REFUND_FAILED",
          outcome: "unknown",
        });
      else
        expect((await execution).status).toBe(
          status === "SUCCESS" ? "succeeded" : "pending",
        );
      const input = h.requests.at(-1)?.variables.input as Record<
        string,
        unknown
      >;
      expect(input).toMatchObject({ notify: false, allowOverRefunding: false });
      expect(input).not.toHaveProperty("refundLineItems");
      expect(h.requests.at(-1)?.variables.idempotencyKey).toBe("refund-key");
    },
  );

  it("refuses an automatic refund resend after the 24-hour provider window", async () => {
    const raw = rawOrder({
      lineItems: { nodes: [line(1, 10, 1)], pageInfo: { hasNextPage: false } },
      currentSubtotalPriceSet: bag("10.00"),
      currentTotalPriceSet: bag("10.00"),
      totalOutstandingSet: bag("-10.00"),
    });
    const h = harness([raw, raw]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.refund(4, refundIntent(snapshot), "2026-10-04T18:00:00.000Z"),
    ).rejects.toMatchObject({
      code: "REFUND_RETRY_WINDOW_EXPIRED",
      outcome: "unknown",
    });
    expect(
      h.requests.every((request) => !request.query.includes("refundCreate")),
    ).toBe(true);
  });

  it("reconciles an existing matching refund without creating another, even after 24 hours", async () => {
    const raw = rawOrder({
      lineItems: { nodes: [line(1, 10, 1)], pageInfo: { hasNextPage: false } },
      currentSubtotalPriceSet: bag("10.00"),
      currentTotalPriceSet: bag("10.00"),
      totalOutstandingSet: bag("-10.00"),
    });
    const h = harness([
      raw,
      rawOrder({
        refunds: [
          {
            id: id("Refund", 9),
            note: "Echelon order edit edit-1",
            totalRefundedSet: bag("10.00"),
            transactions: {
              nodes: [tx(2, "10.00", "REFUND", "SUCCESS", 1)],
              pageInfo: { hasNextPage: false },
            },
          },
        ],
      }),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    expect(
      (
        await h.provider.refund(
          4,
          refundIntent(snapshot),
          "2026-10-01T00:00:00.000Z",
        )
      ).status,
    ).toBe("succeeded");
    expect(h.requests).toHaveLength(2);
  });

  it("rejects unpaid expiry when partial payment or external edits changed the saved state", async () => {
    const h = harness([
      rawOrder(),
      rawOrder({
        netPaymentSet: bag("22.00"),
        totalOutstandingSet: bag("3.00"),
        currentTotalPriceSet: bag("25.00"),
        currentSubtotalPriceSet: bag("25.00"),
        lineItems: {
          nodes: [line(), line(2, 20, 1, "5.00")],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
    const baseline = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.recoverUnpaid(
        4,
        baseline,
        additionQuote(baseline),
        "expire-1",
      ),
    ).rejects.toMatchObject({ code: "EXPIRY_CONFLICT", outcome: "unknown" });
    expect(
      h.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
  });

  it("restores only the expired addition and verifies the original amount before release", async () => {
    const pending = rawOrder({
      fullyPaid: false,
      currentTotalPriceSet: bag("25.00"),
      currentSubtotalPriceSet: bag("25.00"),
      totalOutstandingSet: bag("5.00"),
      lineItems: {
        nodes: [line(), line(2, 20, 1, "5.00")],
        pageInfo: { hasNextPage: false },
      },
    });
    const restored = rawOrder({
      lineItems: {
        nodes: [line(), line(2, 20, 0, "5.00")],
        pageInfo: { hasNextPage: false },
      },
    });
    const h = harness([
      rawOrder(),
      pending,
      begin(
        calculated("25.00", "5.00", [calcLine(), calcLine(2, 20, 1, "5.00")]),
      ),
      quantity(
        calculated("20.00", "0.00", [calcLine(), calcLine(2, 20, 0, "5.00")]),
      ),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      restored,
    ]);
    const baseline = await h.provider.readOrder(4, "100");
    const result = await h.provider.recoverUnpaid(
      4,
      baseline,
      additionQuote(baseline),
      "expire-1",
    );
    expect(result.totalCents).toBe(2000);
    expect(result.outstandingCents).toBe(0);
    expect(
      h.requests.find((request) =>
        request.query.includes("orderEditSetQuantity"),
      )?.variables,
    ).toMatchObject({ lineItemId: id("CalculatedLineItem", 2), quantity: 0 });
  });

  it("expires an unpaid existing-line increase back to its original quantity and price", async () => {
    const pending = rawOrder({
      fullyPaid: false,
      currentTotalPriceSet: bag("30.00"),
      currentSubtotalPriceSet: bag("30.00"),
      totalOutstandingSet: bag("10.00"),
      lineItems: { nodes: [line(1, 10, 3)], pageInfo: { hasNextPage: false } },
    });
    const h = harness([
      rawOrder(),
      pending,
      begin(calculated("30.00", "10.00", [calcLine(1, 10, 3)])),
      quantity(calculated("20.00", "0.00", [calcLine()])),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      rawOrder(),
    ]);
    const baseline = await h.provider.readOrder(4, "100");
    const quote = additionQuote(baseline);
    quote.plan = {
      changes: [{ lineItemId: id("LineItem", 1), quantity: 3 }],
      additions: [],
    };
    quote.lines = [{ ...quote.lines[0], quantity: 3, totalCents: 3000 }];
    Object.assign(quote, {
      totalCents: 3000,
      outstandingCents: 1000,
      deltaCents: 1000,
    });
    const result = await h.provider.recoverUnpaid(
      4,
      baseline,
      quote,
      "expire-1",
    );
    expect(result.lines[0]).toMatchObject({
      id: id("LineItem", 1),
      quantity: 2,
      totalCents: 2000,
    });
    expect(result.netPaidCents).toBe(2000);
    expect(
      h.requests.some((request) =>
        /refundCreate|suggestedRefund|orderEditAddVariant/.test(request.query),
      ),
    ).toBe(false);
  });

  it("reconciles zero-quantity historical additions while refusing changed tax or late payment", async () => {
    const restored = rawOrder({
      lineItems: {
        nodes: [line(), line(2, 20, 0, "5.00")],
        pageInfo: { hasNextPage: false },
      },
    });
    const h = harness([
      rawOrder(),
      restored,
      rawOrder({
        currentTotalTaxSet: bag("1.00"),
        currentTotalPriceSet: bag("21.00"),
      }),
      rawOrder({
        transactions: [tx(), tx(2, "5.00")],
        transactionsCount: { count: 2, precision: "EXACT" },
      }),
    ]);
    const baseline = await h.provider.readOrder(4, "100");
    expect(
      (await h.provider.reconcileRecovery(4, baseline, "expire-1")).status,
    ).toBe("restored");
    expect(
      (await h.provider.reconcileRecovery(4, baseline, "expire-1")).status,
    ).toBe("conflict");
    expect(
      (await h.provider.reconcileRecovery(4, baseline, "expire-1")).status,
    ).toBe("conflict");
  });
});

function refundIntent(snapshot: OrderEditSnapshot) {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: snapshot.orderId,
    operationId: "edit-1",
    idempotencyKey: "refund-key",
    currency: "USD" as const,
    amountCents: 1000,
    parentTransactionId: id("OrderTransaction", 1),
    gateway: "shopify_payments",
    note: "Echelon order edit edit-1",
    contentFingerprint: snapshot.contentFingerprint,
  };
}
function additionQuote(baseline: OrderEditSnapshot): OrderEditQuote {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: baseline.orderId,
    operationId: "edit-1",
    calculatedOrderId: id("CalculatedOrder", 100),
    sessionId: id("OrderEditSession", 100),
    baselineFingerprint: baseline.fingerprint,
    baseline,
    plan: { changes: [], additions: [{ variantId: "20", quantity: 1 }] },
    lines: [
      {
        title: "Test product",
        variantTitle: null,
        totalCents: 2000,
        originalLineId: id("LineItem", 1),
        calculatedLineId: id("CalculatedLineItem", 1),
        variantId: id("ProductVariant", 10),
        quantity: 2,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
      },
      {
        title: "Test product",
        variantTitle: null,
        totalCents: 500,
        originalLineId: null,
        calculatedLineId: id("CalculatedLineItem", 2),
        variantId: id("ProductVariant", 20),
        quantity: 1,
        originalUnitPriceCents: 500,
        discountedUnitPriceCents: 500,
      },
    ],
    totalCents: 2500,
    outstandingCents: 500,
    deltaCents: 500,
    shippingCents: 0,
    createdAt: NOW.toISOString(),
    evidence: {},
  };
}

// Exact observed Shopify scopes for #64008, with synthetic commercial identities.
const addedMemberLineId =
  "gid://shopify/CalculatedLineItem/385de2d5-a4b7-49f3-9a8f-10a609b835fe";
function memberCreditOrder(extraQuantity = 0, includeHistorical = false) {
  const memberApplication = {
    __typename: "AutomaticDiscountApplication",
    index: 0,
    targetType: "LINE_ITEM",
    allocationMethod: "ACROSS",
    targetSelection: "ENTITLED",
    title: "Member discount",
    value: { __typename: "MoneyV2", amount: "30.00", currencyCode: "USD" },
  };
  const creditApplication = {
    __typename: "DiscountCodeApplication",
    index: 2,
    targetType: "LINE_ITEM",
    allocationMethod: "ACROSS",
    targetSelection: "ALL",
    code: "TEST-REWARD-19",
    value: { __typename: "MoneyV2", amount: "19.00", currencyCode: "USD" },
  };
  const manualApplication = {
    __typename: "ManualDiscountApplication",
    index: 3,
    targetType: "LINE_ITEM",
    allocationMethod: "EACH",
    targetSelection: "EXPLICIT",
    title: "Echelon member pricing",
    value: { __typename: "MoneyV2", amount: "30.00", currencyCode: "USD" },
  };
  const original = {
    ...line(1, 10, 1, "149.99"),
    priceAfterAllDiscountsBeforeTaxesSet: bag("100.99"),
    discountAllocations: [
      {
        allocatedAmountSet: bag("30.00"),
        discountApplication: memberApplication,
      },
      {
        allocatedAmountSet: bag("19.00"),
        discountApplication: creditApplication,
      },
    ],
  };
  const extra = {
    ...line(2, 10, extraQuantity, "149.99"),
    discountedUnitPriceSet: bag("119.99"),
    unfulfilledDiscountedTotalSet: bag(lineAmount("119.99", extraQuantity)),
    priceAfterAllDiscountsBeforeTaxesSet: bag(
      lineAmount("119.99", extraQuantity),
    ),
    discountAllocations: extraQuantity
      ? [
          {
            allocatedAmountSet: bag(lineAmount("30.00", extraQuantity)),
            discountApplication: manualApplication,
          },
        ]
      : [],
  };
  const total = decimal(
    cents("100.99") + cents("119.99") * BigInt(extraQuantity),
  );
  const base = rawOrder();
  return {
    ...base,
    order: {
      ...base.order,
      fullyPaid: extraQuantity === 0,
      currentTotalPriceSet: bag(total),
      currentSubtotalPriceSet: bag(total),
      netPaymentSet: bag("100.99"),
      totalOutstandingSet: bag(lineAmount("119.99", extraQuantity)),
      transactions: [tx(1, "100.99")],
      customer: {
        id: id("Customer", 1),
        tags: [],
        membershipPlan: { value: "test-plan" },
      },
      lineItems: {
        nodes: [
          original,
          ...(extraQuantity || includeHistorical ? [extra] : []),
        ],
        pageInfo: { hasNextPage: false },
      },
      discountApplications: {
        nodes: [
          memberApplication,
          {
            __typename: "AutomaticDiscountApplication",
            index: 1,
            targetType: "SHIPPING_LINE",
            allocationMethod: "EACH",
            targetSelection: "ALL",
            title: "Member free shipping",
            value: { __typename: "PricingPercentageValue", percentage: 100 },
          },
          creditApplication,
          ...(extraQuantity || includeHistorical ? [manualApplication] : []),
        ],
        pageInfo: { hasNextPage: false },
      },
      shippingLines: {
        nodes: [
          {
            id: id("ShippingLine", 1),
            isRemoved: false,
            originalPriceSet: bag("11.99"),
            currentDiscountedPriceSet: bag("0.00"),
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
function memberCreditCalculated(
  extraQuantity = 0,
  member = true,
  committed = false,
) {
  const original = calcLine(1, 10, 1, "149.99");
  original.calculatedDiscountAllocations = [
    {
      allocatedAmountSet: bag("30.00"),
      discountApplication: {
        __typename: "CalculatedAutomaticDiscountApplication",
        id: id("CalculatedAutomaticDiscountApplication", 1),
        allocationMethod: "ACROSS",
        appliedTo: "ORDER",
        targetType: "LINE_ITEM",
        targetSelection: "ENTITLED",
        description: "Member discount",
        value: { __typename: "MoneyV2", amount: "30.00", currencyCode: "USD" },
      },
    },
    {
      allocatedAmountSet: bag("19.00"),
      discountApplication: {
        __typename: "CalculatedDiscountCodeApplication",
        id: id("CalculatedDiscountCodeApplication", 2),
        allocationMethod: "ACROSS",
        appliedTo: "ORDER",
        targetType: "LINE_ITEM",
        targetSelection: "ALL",
        description: "TEST-REWARD-19",
        code: "TEST-REWARD-19",
        value: { __typename: "MoneyV2", amount: "19.00", currencyCode: "USD" },
      },
    },
  ];
  const extra = {
    ...calcLine(2, 10, extraQuantity, "149.99", member ? "119.99" : "149.99"),
    id: committed ? id("CalculatedLineItem", 2) : addedMemberLineId,
    editableQuantityBeforeChanges: committed ? extraQuantity : 0,
  };
  const total = decimal(
    cents("100.99") +
      cents(member ? "119.99" : "149.99") * BigInt(extraQuantity),
  );
  return {
    ...calculated(
      total,
      lineAmount(member ? "119.99" : "149.99", extraQuantity),
      committed ? [original, extra] : [original],
      !committed && extraQuantity ? [extra] : [],
    ),
    shippingLines: [
      {
        id: id("CalculatedShippingLine", 1),
        price: bag("11.99"),
        stagedStatus: "NONE",
      },
    ],
  };
}
function memberProvenance(title = "Cardshellz Member Pricing") {
  return {
    currentAppInstallation: { app: { id: id("App", 300) } },
    shopifyFunctions: {
      nodes: [
        { id: "pricing-function-id", handle: "cardshellz-pricing-discount" },
      ],
      pageInfo: { hasNextPage: false },
    },
    discountNodes: {
      nodes: [
        {
          id: id("DiscountAutomaticNode", 400),
          discount: {
            __typename: "DiscountAutomaticApp",
            title,
            status: "ACTIVE",
            discountClasses: ["PRODUCT"],
            appDiscountType: {
              functionId: "pricing-function-id",
              app: { id: id("App", 300) },
            },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}
function memberQuoteResponses() {
  return [
    memberCreditOrder(),
    memberCreditOrder(),
    memberProvenance(),
    {
      nodes: [
        variant(
          10,
          "149.99",
          JSON.stringify({ "test-plan": { cents: 11999 } }),
        ),
      ],
    },
    begin(memberCreditCalculated()),
    {
      orderEditAddVariant: {
        userErrors: [],
        calculatedLineItem: { id: addedMemberLineId },
        calculatedOrder: memberCreditCalculated(1, false),
      },
    },
    {
      orderEditAddLineItemDiscount: {
        userErrors: [],
        calculatedOrder: memberCreditCalculated(1),
      },
    },
  ];
}
async function quoteMemberIncrease() {
  const h = harness(memberQuoteResponses());
  const snapshot = await h.provider.readOrder(4, "100");
  const quote = await h.provider.quote(
    4,
    snapshot,
    { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
    "edit-1",
  );
  return { ...h, quote, snapshot };
}

describe("member function pricing on protected quantity increases", () => {
  it("combines a protected increase and an explicit addition without losing quantity lineage", async () => {
    const responses = memberQuoteResponses();
    responses[5] = {
      orderEditAddVariant: {
        userErrors: [],
        calculatedLineItem: { id: addedMemberLineId },
        calculatedOrder: memberCreditCalculated(2, false),
      },
    };
    responses[6] = {
      orderEditAddLineItemDiscount: {
        userErrors: [],
        calculatedOrder: memberCreditCalculated(2),
      },
    };
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      {
        changes: [{ lineItemId: "1", quantity: 2 }],
        additions: [{ variantId: "10", quantity: 1 }],
      },
      "edit-1",
    );
    expect(quote.totalCents).toBe(34097);
    expect(quote.lines[1]).toMatchObject({
      quantity: 2,
      quantityIncreaseOfLineId: id("LineItem", 1),
    });
    expect(
      h.requests.filter((request) =>
        request.query.includes("orderEditAddVariant"),
      ),
    ).toHaveLength(1);
    expect(quote.lines.reduce((total, line) => total + line.quantity, 0)).toBe(
      3,
    );
  });
  it("matches distinguishable original lines of the same variant for a subsequent edit", async () => {
    const raw = memberCreditOrder(1);
    Object.assign(raw.order, {
      fullyPaid: true,
      netPaymentSet: bag("220.98"),
      totalOutstandingSet: bag("0.00"),
      transactions: [tx(1, "100.99"), tx(2, "119.99")],
      transactionsCount: { count: 2, precision: "EXACT" },
    });
    const initial = memberCreditCalculated(1, true, true);
    initial.totalOutstandingSet = bag("0.00");
    const revised = memberCreditCalculated(2, true, true);
    revised.totalOutstandingSet = bag("119.99");
    const h = harness([
      raw,
      raw,
      memberProvenance(),
      {
        nodes: [
          variant(
            10,
            "149.99",
            JSON.stringify({ "test-plan": { cents: 11999 } }),
          ),
        ],
      },
      begin(initial),
      quantity(revised),
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "2", quantity: 2 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({ totalCents: 34097, deltaCents: 11999 });
    expect(
      quote.lines.map((line) => ({
        originalLineId: line.originalLineId,
        quantity: line.quantity,
      })),
    ).toEqual([
      { originalLineId: id("LineItem", 1), quantity: 1 },
      { originalLineId: id("LineItem", 2), quantity: 2 },
    ]);
  });
  it("refuses an equal-value readback that replaced the original automatic promotion", async () => {
    const { quote, snapshot } = await quoteMemberIncrease();
    const readback = memberCreditOrder(1);
    Object.assign(readback.order.discountApplications.nodes[0], {
      title: "Different promotion",
    });
    const h = harness([readback]);
    expect(
      (await h.provider.reconcileCommit(4, snapshot, quote, "edit-1")).status,
    ).toBe("conflict");
    expect(h.requests).toHaveLength(1);
  });
  it("overlaps current product and promotion reads, and waits for both before staging", async () => {
    const h = harness(memberQuoteResponses());
    const snapshot = await h.provider.readOrder(4, "100");
    const originalFetch = h.fetchImpl.getMockImplementation()!;
    let releasePromotion!: () => void;
    let releaseVariants!: () => void;
    const promotion = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    const variants = new Promise<void>((resolve) => {
      releaseVariants = resolve;
    });
    h.fetchImpl.mockImplementation(async (url, init) => {
      const response = originalFetch(url, init);
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("EchelonEditPricingProvenance")) await promotion;
      if (query.includes("EchelonEditVariantPrices")) await variants;
      return response;
    });
    const pending = h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
      "edit-1",
    );
    await vi.waitFor(() =>
      expect(
        h.requests.some((request) =>
          request.query.includes("EchelonEditVariantPrices"),
        ),
      ).toBe(true),
    );
    expect(
      h.requests.some((request) =>
        request.query.includes("EchelonEditPricingProvenance"),
      ),
    ).toBe(true);
    expect(
      h.requests.some((request) => request.query.includes("orderEditBegin")),
    ).toBe(false);
    releaseVariants();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      h.requests.some((request) => request.query.includes("orderEditBegin")),
    ).toBe(false);
    releasePromotion();
    expect((await pending).totalCents).toBe(22098);
  });
  it("awaits an outstanding product read after promotion failure and never stages", async () => {
    const responses: unknown[] = memberQuoteResponses();
    responses[2] = new Error("Promotion read unavailable");
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    const originalFetch = h.fetchImpl.getMockImplementation()!;
    let releaseVariants!: () => void;
    const variants = new Promise<void>((resolve) => {
      releaseVariants = resolve;
    });
    h.fetchImpl.mockImplementation(async (url, init) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("EchelonEditVariantPrices")) {
        await variants;
      }
      return originalFetch(url, init);
    });
    let settled = false;
    const outcome = h.provider
      .quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      )
      .then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
    await vi.waitFor(() =>
      expect(
        h.requests.some((request) =>
          request.query.includes("EchelonEditPricingProvenance"),
        ),
      ).toBe(true),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseVariants();
    expect(await outcome).toMatchObject({ code: "SHOPIFY_UNAVAILABLE" });
    expect(
      h.requests.some((request) => request.query.includes("mutation")),
    ).toBe(false);
  });
  it("reports both failed preflight reads without starting an edit", async () => {
    const responses: unknown[] = memberQuoteResponses();
    responses[2] = new Error("Promotion read unavailable");
    responses[3] = new Error("Product read unavailable");
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "SHOPIFY_UNAVAILABLE" });
    expect(h.reports).toHaveBeenCalledExactlyOnceWith({
      operationId: "edit-1",
      code: "SHOPIFY_UNAVAILABLE",
    });
    expect(
      h.requests.some((request) => request.query.includes("mutation")),
    ).toBe(false);
  });
  it("quotes the observed 1 -> 2 case on the same order, with the fixed reward used once", async () => {
    const { quote, requests } = await quoteMemberIncrease();
    expect(quote).toMatchObject({
      totalCents: 22098,
      deltaCents: 11999,
      outstandingCents: 11999,
      plan: { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
    });
    expect(quote.financials).toMatchObject({
      itemsGrossCents: 29998,
      itemsDiscountCents: 7900,
      itemsNetCents: 22098,
      shippingGrossCents: 1199,
      shippingDiscountCents: 1199,
      shippingCents: 0,
    });
    expect(quote.financials?.itemDiscounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "TEST-REWARD-19", amountCents: 1900 }),
        expect.objectContaining({ amountCents: 6000, key: "product" }),
      ]),
    );
    expect(quote.lines).toEqual([
      expect.objectContaining({
        originalLineId: id("LineItem", 1),
        quantity: 1,
      }),
      expect.objectContaining({
        originalLineId: null,
        quantityIncreaseOfLineId: id("LineItem", 1),
        calculatedLineId: addedMemberLineId,
        quantity: 1,
        discountedUnitPriceCents: 11999,
      }),
    ]);
    expect(
      requests.some((request) =>
        /orderEditSetQuantity|orderEditCommit|refundCreate/.test(request.query),
      ),
    ).toBe(false);
    expect(
      requests.find((request) => request.query.includes("orderEditAddVariant"))
        ?.variables,
    ).toMatchObject({
      id: id("CalculatedOrder", 100),
      variantId: id("ProductVariant", 10),
      quantity: 1,
    });
    expect(quote.evidence.pricingProvenance).toMatchObject({
      title: "Cardshellz Member Pricing",
      orderMessages: ["Member discount"],
    });
  });
  it("does not depend on the editable registration title", async () => {
    const responses = memberQuoteResponses();
    responses[2] = memberProvenance("Renamed promotion");
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    expect(
      (
        await h.provider.quote(
          4,
          snapshot,
          { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
          "edit-1",
        )
      ).totalCents,
    ).toBe(22098);
  });
  it("applies a native percentage coupon after both member-priced units", async () => {
    const raw = memberCreditOrder();
    const coupon = raw.order.discountApplications.nodes[2];
    coupon.value = { __typename: "PricingPercentageValue", percentage: 10 };
    const couponAllocation =
      raw.order.lineItems.nodes[0].discountAllocations[1];
    couponAllocation.allocatedAmountSet = bag("12.00");
    Object.assign(raw.order, {
      currentTotalPriceSet: bag("107.99"),
      currentSubtotalPriceSet: bag("107.99"),
      netPaymentSet: bag("107.99"),
      transactions: [tx(1, "107.99")],
    });
    raw.order.lineItems.nodes[0].priceAfterAllDiscountsBeforeTaxesSet =
      bag("107.99");
    const initial = memberCreditCalculated();
    const full = memberCreditCalculated(1);
    const afterAdd = memberCreditCalculated(1, false);
    for (const calculated of [initial, afterAdd, full]) {
      const credit =
        calculated.lineItems.nodes[0].calculatedDiscountAllocations[1];
      credit.discountApplication.value = {
        __typename: "PricingPercentageValue",
        percentage: 10,
      };
      credit.allocatedAmountSet = bag("12.00");
    }
    Object.assign(initial, {
      totalPriceSet: bag("107.99"),
      subtotalPriceSet: bag("107.99"),
      totalOutstandingSet: bag("0.00"),
    });
    const addedCredit = structuredClone(
      full.lineItems.nodes[0].calculatedDiscountAllocations[1],
    );
    full.addedLineItems.nodes[0].calculatedDiscountAllocations.push(
      addedCredit,
    );
    Object.assign(full, {
      totalPriceSet: bag("215.98"),
      subtotalPriceSet: bag("215.98"),
      totalOutstandingSet: bag("107.99"),
    });
    const h = harness([
      raw,
      raw,
      memberProvenance(),
      {
        nodes: [
          variant(
            10,
            "149.99",
            JSON.stringify({ "test-plan": { cents: 11999 } }),
          ),
        ],
      },
      begin(initial),
      {
        orderEditAddVariant: {
          userErrors: [],
          calculatedLineItem: { id: addedMemberLineId },
          calculatedOrder: afterAdd,
        },
      },
      {
        orderEditAddLineItemDiscount: { userErrors: [], calculatedOrder: full },
      },
    ]);
    const snapshot = await h.provider.readOrder(4, "100");
    const quote = await h.provider.quote(
      4,
      snapshot,
      { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
      "edit-1",
    );
    expect(quote).toMatchObject({ totalCents: 21598, deltaCents: 10799 });
    expect(quote.financials?.itemDiscounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "TEST-REWARD-19",
          amountCents: 2400,
          value: { type: "percentage", percentage: "10" },
        }),
      ]),
    );
  });
  it("rejects an unrelated automatic discount message even with the correct installed app", async () => {
    const raw = memberCreditOrder();
    Object.assign(raw.order.discountApplications.nodes[0], {
      title: "Other promotion",
    });
    const h = harness([raw, raw, memberProvenance()]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "PROMOTION_PARITY_UNVERIFIED" });
    expect(
      h.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
  });
  it("rejects current catalog member pricing that cannot reproduce the original price", async () => {
    const responses = memberQuoteResponses();
    responses[3] = {
      nodes: [
        variant(
          10,
          "149.99",
          JSON.stringify({ "test-plan": { cents: 12999 } }),
        ),
      ],
    };
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "MEMBER_PRICE_CHANGED" });
    expect(
      h.requests.some((request) =>
        /orderEditCommit|orderEditAddLineItemDiscount/.test(request.query),
      ),
    ).toBe(false);
  });
  it.each([
    "wrong-app",
    "wrong-function",
    "ambiguous",
    "wrong-class",
    "truncated",
  ])("rejects %s promotion provenance before opening an edit", async (mode) => {
    const provenance = memberProvenance();
    const discount = provenance.discountNodes.nodes[0].discount;
    if (mode === "wrong-app") discount.appDiscountType.app.id = id("App", 999);
    if (mode === "wrong-function")
      discount.appDiscountType.functionId = "wrong";
    if (mode === "ambiguous")
      provenance.discountNodes.nodes.push(
        structuredClone(provenance.discountNodes.nodes[0]),
      );
    if (mode === "wrong-class") discount.discountClasses = ["ORDER"];
    if (mode === "truncated")
      provenance.discountNodes.pageInfo.hasNextPage = true;
    const h = harness([memberCreditOrder(), memberCreditOrder(), provenance]);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toThrow();
    expect(
      h.requests.every((request) => !request.query.startsWith("mutation")),
    ).toBe(true);
  });
  it("rejects a changed original member allocation even when the final total reconciles", async () => {
    const responses = memberQuoteResponses();
    const changed = memberCreditCalculated(1);
    changed.lineItems.nodes[0].calculatedDiscountAllocations[0].allocatedAmountSet =
      bag("29.00");
    responses[6] = {
      orderEditAddLineItemDiscount: {
        userErrors: [],
        calculatedOrder: changed,
      },
    };
    const h = harness(responses);
    const snapshot = await h.provider.readOrder(4, "100");
    await expect(
      h.provider.quote(
        4,
        snapshot,
        { changes: [{ lineItemId: "1", quantity: 2 }], additions: [] },
        "edit-1",
      ),
    ).rejects.toMatchObject({ code: "PROMOTION_PARITY_UNVERIFIED" });
  });
  it.each([
    "extra-quantity",
    "inflated-original",
    "missing-source",
    "unknown-source",
    "wrong-variant",
    "unsafe-id",
  ])("rejects corrupted %s persisted quantity proof", async (mode) => {
    const { quote } = await quoteMemberIncrease();
    if (mode === "extra-quantity") quote.lines[1].quantity = 2;
    if (mode === "inflated-original") quote.lines[0].quantity = 2;
    if (mode === "missing-source")
      delete quote.lines[1].quantityIncreaseOfLineId;
    if (mode === "unknown-source")
      quote.lines[1].quantityIncreaseOfLineId = id("LineItem", 999);
    if (mode === "wrong-variant")
      quote.lines[1].variantId = id("ProductVariant", 20);
    if (mode === "unsafe-id")
      quote.lines[1].calculatedLineId =
        "gid://shopify/CalculatedLineItem/../../Order/1";
    expect(orderEditQuoteSchema.safeParse(quote).success).toBe(false);
  });
  it("recovers an unpaid increase by removing only the added unit, retaining the original member discount and reward", async () => {
    const { quote, snapshot } = await quoteMemberIncrease();
    const pending = memberCreditOrder(1);
    const h = harness([
      pending,
      begin(memberCreditCalculated(1, true, true)),
      quantity(memberCreditCalculated(0, true, true)),
      pending,
      { orderEditCommit: { order: { id: id("Order", 100) }, userErrors: [] } },
      memberCreditOrder(0, true),
    ]);
    const restored = await h.provider.recoverUnpaid(
      4,
      snapshot,
      quote,
      "expire-1",
    );
    expect(restored.totalCents).toBe(10099);
    expect(restored.outstandingCents).toBe(0);
    expect(isUnpaidRecoveryRestored(restored, snapshot)).toBe(true);
    expect(
      h.requests
        .filter((request) => request.query.includes("orderEditSetQuantity"))
        .map((request) => request.variables),
    ).toEqual([
      {
        id: id("CalculatedOrder", 100),
        lineItemId: id("CalculatedLineItem", 2),
        quantity: 0,
      },
    ]);
    expect(
      h.requests.some((request) =>
        /refundCreate|orderEditAddVariant|orderEditAddLineItemDiscount/.test(
          request.query,
        ),
      ),
    ).toBe(false);
  });
});
