import { describe, expect, it, vi } from "vitest";
import { CustomerAccountOrderQueriesService } from "../../application/customer-account-order-queries.service";
import { PostgresCustomerAccountOrderContextReader } from "../../infrastructure/customer-account-order-context.repository";
import { ShopifyOrderEditProvider } from "../../../order-edits/infrastructure/shopify-order-edit.provider";
import { serviceHarness } from "../../../order-edits/__tests__/fixtures/order-edit-service.fixture";
import type { NativeCustomerOrderSummary } from "../../../order-edits/application/order-edit-provider";
import { orderAddressEligibility } from "../../../order-edits/domain/order-address-eligibility";
import { orderEditOrderManagementPresentation } from "../../../order-edits/application/order-edit-response-presentation";

const principal = {
  channelId: 2,
  externalCustomerId: "100",
  shopDomain: "fixture.myshopify.com",
  sessionKey: "a".repeat(43),
  authenticatedAt: 1,
  expiresAt: 1800001,
};
const connection = {
  connectionId: 4,
  channelId: 2,
  shopDomain: principal.shopDomain,
  name: "Shopify",
  enabled: true,
  paymentWindowMinutes: 30,
};
const identity = { externalOrderId: "99", orderReference: "#49180" };
const summary = {
  ...identity,
  customerId: "gid://shopify/Customer/100",
  channelId: 2,
  shopDomain: principal.shopDomain,
  totalCents: 0,
  currency: "USD" as const,
  cancelled: true,
  financialStatus: "Refunded",
};
function fixture() {
  const edits = {
    orderSummaries: vi.fn(
      async (): Promise<NativeCustomerOrderSummary[]> => [summary],
    ),
    customerOrderDetails: vi.fn(),
  };
  const context = {
    read: vi.fn(
      async () =>
        [] as Array<{
          externalOrderId: string;
          omsOrderId: number;
          warehouseStatuses: string[];
          held: boolean;
        }>,
    ),
  };
  const report = vi.fn();
  const service = new CustomerAccountOrderQueriesService({
    principal,
    connection: vi.fn(async () => connection),
    edits,
    context,
    report,
  });
  return { service, edits, context, report };
}
describe("owned, query-only account history", () => {
  it("returns an exact zero total for a historical purchase without an OMS order", async () => {
    const h = fixture();
    const result = await h.service.summaries({ orders: [identity] });
    expect(result).toEqual({
      orders: [
        {
          ...identity,
          omsOrderId: null,
          totalCents: 0,
          currency: "USD",
          cancelled: true,
          financialStatus: "Refunded",
        },
      ],
      unavailableExternalOrderIds: [],
      statusUnavailable: false,
    });
    expect(h.edits.orderSummaries).toHaveBeenCalledExactlyOnceWith(4, ["99"]);
    expect(h.context.read).toHaveBeenCalledExactlyOnceWith({
      channelId: 2,
      externalCustomerId: "100",
      externalOrderIds: ["99"],
    });
  });
  it.each([
    { ...summary, customerId: "gid://shopify/Customer/101" },
    { ...summary, customerId: null },
    { ...summary, channelId: 3 },
    { ...summary, shopDomain: "another.myshopify.com" },
    { ...summary, externalOrderId: "98" },
    { ...summary, orderReference: "#other" },
  ])(
    "never discloses an unowned or mismatched purchase: %j",
    async (native) => {
      const h = fixture();
      h.edits.orderSummaries.mockResolvedValueOnce([native]);
      expect(await h.service.summaries({ orders: [identity] })).toEqual({
        orders: [],
        unavailableExternalOrderIds: ["99"],
        statusUnavailable: false,
      });
    },
  );
  it("keeps current money available and reports a status-store outage explicitly", async () => {
    const h = fixture();
    h.context.read.mockRejectedValueOnce(
      new Error("private SQL and credentials"),
    );
    const result = await h.service.summaries({ orders: [identity] });
    expect(result.orders[0].totalCents).toBe(0);
    expect(result.statusUnavailable).toBe(true);
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      code: "CUSTOMER_ACCOUNT_STATUS_UNAVAILABLE",
    });
  });
  it("reports ambiguous numeric/GID OMS aliases without hiding verified native money or choosing an arbitrary order", async () => {
    const h = fixture();
    h.context.read.mockResolvedValueOnce(
      [9, 10].map((omsOrderId) => ({
        externalOrderId: "99",
        omsOrderId,
        warehouseStatuses: ["ready"],
        held: false,
      })),
    );
    const result = await h.service.summaries({ orders: [identity] });
    expect(result.orders[0]).toMatchObject({ totalCents: 0, omsOrderId: null });
    expect(result.statusUnavailable).toBe(true);
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      code: "CUSTOMER_ACCOUNT_ORDER_AMBIGUOUS",
    });
  });
  it("uses canonical picking presentation while distinguishing a stopped warehouse order from Shopify cancellation", async () => {
    const h = fixture();
    h.context.read.mockResolvedValueOnce([
      {
        externalOrderId: "99",
        omsOrderId: 9,
        warehouseStatuses: ["cancelled"],
        held: true,
      },
    ]);
    h.edits.orderSummaries.mockResolvedValueOnce([
      { ...summary, cancelled: false },
    ]);
    expect(
      (await h.service.summaries({ orders: [identity] })).orders[0].fulfillment,
    ).toEqual({ code: "attention", label: "Order needs attention" });
  });
  it.each([
    [],
    Array.from({ length: 21 }, (_, i) => ({
      ...identity,
      externalOrderId: String(i + 1),
    })),
    [identity, identity],
  ])(
    "rejects unbounded, empty or duplicate lookups before provider/database work",
    async (orders) => {
      const h = fixture();
      await expect(h.service.summaries({ orders })).rejects.toThrow();
      expect(h.edits.orderSummaries).not.toHaveBeenCalled();
      expect(h.context.read).not.toHaveBeenCalled();
    },
  );
  it("binds detail reads directly to the signed customer and exact native identity, without an OMS lookup", async () => {
    const h = fixture();
    h.edits.customerOrderDetails.mockResolvedValueOnce({
      ...identity,
      currency: "USD",
      totalCents: 0,
      lines: [],
    });
    expect(await h.service.details(identity)).toMatchObject({
      ...identity,
      totalCents: 0,
    });
    expect(h.edits.customerOrderDetails).toHaveBeenCalledExactlyOnceWith(
      4,
      "99",
      "gid://shopify/Customer/100",
      { channelId: 2, shopDomain: principal.shopDomain },
    );
    expect(h.context.read).not.toHaveBeenCalled();
    h.edits.customerOrderDetails.mockResolvedValueOnce({
      ...identity,
      orderReference: "#another",
      currency: "USD",
      totalCents: 0,
      lines: [],
    });
    await expect(h.service.details(identity)).rejects.toMatchObject({
      code: "CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE",
    });
  });
  it("uses one parameterized SELECT scoped to the channel, customer and bounded native identities", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new PostgresCustomerAccountOrderContextReader({
      query,
    } as never);
    await repository.read({
      channelId: 2,
      externalCustomerId: "100",
      externalOrderIds: ["99", "98"],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [statement, values] = query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(statement).toMatch(
      /WHERE o\.channel_id=\$1 AND o\.external_customer_id=\$2 AND \(o\.external_order_id=ANY\(\$3::text\[\]\)/,
    );
    expect(statement).not.toMatch(/FOR UPDATE|INSERT|UPDATE |DELETE /);
    expect(values).toEqual([
      2,
      "100",
      ["99", "98"],
      ["gid://shopify/Order/99", "gid://shopify/Order/98"],
    ]);
  });
});

describe("native summary adapter", () => {
  function provider(nodes: unknown[]) {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { nodes } }), { status: 200 }),
    );
    const credentials = {
      get: vi.fn(async () => ({
        connectionId: 4,
        channelId: 2,
        shopDomain: principal.shopDomain,
        accessToken: "fixture-only",
      })),
    };
    return {
      fetch,
      credentials,
      provider: new ShopifyOrderEditProvider({
        credentials,
        fetch: fetch as typeof globalThis.fetch,
        clock: () => new Date("2026-10-22T12:00:00Z"),
      }),
    };
  }
  const bag = (amount: string) => ({
    presentmentMoney: { amount, currencyCode: "USD" },
    shopMoney: { amount, currencyCode: "USD" },
  });
  const node = (id: string, amount: string) => ({
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    customer: { id: summary.customerId },
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: bag(amount),
  });
  it("reads a full page in one native query with exact integer cents, no calculation or mutation", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const h = provider(ids.map((id) => node(id, id === "1" ? "9.17" : "0.0")));
    const result = await h.provider.readOrderSummaries(4, ids);
    expect(result[0].totalCents).toBe(917);
    expect(result[1].totalCents).toBe(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.credentials.get).toHaveBeenCalledExactlyOnceWith(4);
    const [, request] = h.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(request.body));
    expect(body.variables.ids).toEqual(
      ids.map((id) => `gid://shopify/Order/${id}`),
    );
    expect(body.query).toContain("currentTotalPriceSet");
    expect(body.query).not.toMatch(
      /mutation|lineItems|transactions|discountApplications|orderEditBegin/,
    );
  });
  it.each([
    { nodes: [node("98", "1.00")], code: "ORDER_IDENTITY_MISMATCH" },
    { nodes: [node("99", "0.001")], code: "MONEY_INVALID" },
    { nodes: [node("99", "90071992547409.92")], code: "MONEY_OVERFLOW" },
    { nodes: [], code: "SHOPIFY_RESPONSE_INVALID" },
  ])(
    "rejects incomplete, misidentified or inexact money responses",
    async ({ nodes, code }) => {
      await expect(
        provider(nodes).provider.readOrderSummaries(4, ["99"]),
      ).rejects.toMatchObject({ code });
    },
  );
  it("preserves missing native nodes as unavailable without assigning another total", async () => {
    expect(
      await provider([null, node("98", "0.00")]).provider.readOrderSummaries(
        4,
        ["99", "98"],
      ),
    ).toEqual([
      expect.objectContaining({ externalOrderId: "98", totalCents: 0 }),
    ]);
  });
});

it("the existing details reader authorizes the native customer without warehouse, operations or money writes", async () => {
  const h = serviceHarness();
  const details = await h.service.customerOrderDetails(
    4,
    "100",
    "gid://shopify/Customer/8",
    { channelId: 36, shopDomain: "fixture.myshopify.com" },
  );
  expect(details.totalCents).toBe(2000);
  expect(h.provider.readOrder).toHaveBeenCalledExactlyOnceWith(
    4,
    "100",
    "gid://shopify/Customer/8",
    "fixture.myshopify.com",
  );
  expect(h.warehouse.inspect).not.toHaveBeenCalled();
  expect(h.provider.quote).not.toHaveBeenCalled();
  expect(h.provider.commit).not.toHaveBeenCalled();
  await expect(
    h.service.customerOrderDetails(4, "100", "gid://shopify/Customer/9", {
      channelId: 36,
      shopDomain: "fixture.myshopify.com",
    }),
  ).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE" });
});

it("versioned management metadata preserves the deployed v1 and legacy response contracts", async () => {
  const h = serviceHarness();
  const order = {
    ...(await h.service.order(4, 1)),
    activeOperationStatus: "review_required" as const,
    cancellation: {
      canReview: false,
      requestKey: null,
      reasons: ["Review required"],
    },
  };
  expect(orderEditOrderManagementPresentation(order, "v2")).toEqual(order);
  const v1 = orderEditOrderManagementPresentation(order, "v1");
  expect(v1).not.toHaveProperty("activeOperationStatus");
  expect(v1).not.toHaveProperty("addressEligibility");
  expect(v1.cancellation).toEqual({ canReview: false, requestKey: null });
  const legacy = orderEditOrderManagementPresentation(order, undefined);
  expect(legacy).not.toHaveProperty("fulfillment");
  expect(legacy).not.toHaveProperty("cancellation");
});

it("explains address restrictions without widening the existing warehouse cutoff or active-update exclusion", () => {
  expect(
    orderAddressEligibility({
      editEligible: true,
      editReasons: [],
      activeOperationId: null,
    }),
  ).toEqual({ editable: true, reasons: [] });
  expect(
    orderAddressEligibility({
      editEligible: false,
      editReasons: ["Picking has started"],
      activeOperationId: null,
    }),
  ).toEqual({ editable: false, reasons: ["Picking has started"] });
  expect(
    orderAddressEligibility({
      editEligible: true,
      editReasons: [],
      activeOperationId: "held",
      activeOperationStatus: "review_required",
    }),
  ).toEqual({
    editable: false,
    reasons: [
      "Your previous order update needs review before you can change the shipping address. Contact us for help.",
    ],
  });
});
