import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
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
const lineAmount = (price: string, quantity: number) => {
  const [whole, fraction = ""] = price.split(".");
  const result =
    (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) *
    BigInt(quantity);
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
    shippingLines: [],
    lineItems: { nodes: lines, pageInfo: { hasNextPage: false } },
    addedLineItems: { nodes: added, pageInfo: { hasNextPage: false } },
  };
}
const begin = (value = calculated()) => ({
  orderEditBegin: {
    userErrors: [],
    calculatedOrder: value,
    orderEditSession: { id: id("OrderEditSession", 100) },
  },
});
const quantity = (value: ReturnType<typeof calculated>) => ({
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

function harness(
  responses: Array<unknown>,
  credentialOverrides: Record<string, unknown> = {},
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
  const provider = new ShopifyOrderEditProvider({
    clock: () => NOW,
    fetch: fetchImpl as typeof fetch,
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
  return { provider, requests, fetchImpl };
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

describe("ShopifyOrderEditProvider", () => {
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
    await expect(
      h.provider.commit(4, { ...quote, deltaCents: 1 }, "edit-1"),
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

  it("blocks unverified promotion combinations", async () => {
    const raw = rawOrder({
      discountApplications: {
        nodes: [
          {
            __typename: "DiscountCodeApplication",
            index: 0,
            targetType: "LINE_ITEM",
            allocationMethod: "ACROSS",
            targetSelection: "ALL",
            code: "SAVE",
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
      rawOrder({ currentTotalTaxSet: bag("1.00") }),
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
