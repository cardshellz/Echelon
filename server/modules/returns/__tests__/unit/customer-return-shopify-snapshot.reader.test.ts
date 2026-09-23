import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyCustomerReturnSnapshotReader } from "../../infrastructure/customer-return-shopify-snapshot.reader";
import { CustomerReturnShopifySnapshotError, customerReturnShopifySnapshotSchema,
  type CustomerReturnShopifySnapshotInput } from "../../application/customer-return-shopify-snapshot.ports";

const gid = (resource: string, id: number | string) => `gid://shopify/${resource}/${id}`;
const timestamp = "2026-09-22T12:00:00.000Z";
const observedAt = "2026-09-23T12:00:00.000Z";
const input: CustomerReturnShopifySnapshotInput = {
  shop: { channelId: 36, connectionId: 7, shopDomain: "fixture.myshopify.com", displayName: "Fixture store" },
  externalOrderId: "1001",
};
const connection = () => ({ id: 7, channelId: 36, shopDomain: "fixture.myshopify.com", accessToken: "test-only-secret",
  apiVersion: "2024-01", shopifyLocationId: null });
const line = (id: number, quantity: number) => ({ id: gid("LineItem", id), title: "Fictional product", variantTitle: null,
  sku: "SAME-SKU", quantity, currentQuantity: quantity, refundableQuantity: quantity, requiresShipping: true });
const fulfillment = (id: number, totalQuantity: number) => ({ id: gid("Fulfillment", id), status: "SUCCESS",
  updatedAt: timestamp, deliveredAt: timestamp, inTransitAt: timestamp, displayStatus: "DELIVERED", totalQuantity,
  trackingInfo: [{ number: `TRACK-${id}`, company: "Fixture carrier" }] });
const native = (id: number, status: string) => ({ id: gid("Return", id), status, totalQuantity: 1, order: { id: gid("Order", 1001) } });
const nativeLine = (id: number, fulfillmentLine: number) => ({ __typename: "ReturnLineItem", id: gid("ReturnLineItem", id),
  quantity: 1, processedQuantity: 0, refundedQuantity: 0,
  fulfillmentLineItem: { id: gid("FulfillmentLineItem", fulfillmentLine), lineItem: { id: gid("LineItem", 101) } } });
const order = () => ({ id: gid("Order", 1001), name: "#TEST-1001", createdAt: timestamp, processedAt: timestamp,
  updatedAt: timestamp, cancelledAt: null, shippingAddress: { countryCodeV2: "US" },
  fulfillmentsCount: { count: 2, precision: "EXACT" }, fulfillments: [fulfillment(201, 3), fulfillment(202, 2)],
  refunds: [{ id: gid("Refund", 701), updatedAt: timestamp, return: { id: gid("Return", 501) } }],
});
const page = <T>(nodes: T[], after: unknown, size = 1) => {
  const offset = after == null ? 0 : Number(String(after).split(":")[1]);
  const items = nodes.slice(offset, offset + size);
  return { nodes: items, pageInfo: { hasNextPage: offset + size < nodes.length,
    endCursor: items.length ? `cursor:${offset + items.length}` : null } };
};
type Variables = Record<string, unknown>;
type Modifier = (data: Record<string, unknown>, operation: string, variables: Variables, observation: number) => unknown;
function fixtureData(operation: string, variables: Variables): Record<string, unknown> {
  const id = variables.id;
  const orderScope = { id: gid("Order", 1001), updatedAt: timestamp };
  const fulfillmentScope = { id, updatedAt: timestamp, order: { id: gid("Order", 1001) } };
  switch (operation) {
    case "ReturnSnapshotAccount": return { shop: { id: gid("Shop", 1), myshopifyDomain: input.shop.shopDomain },
      currentAppInstallation: { accessScopes: ["read_orders", "read_all_orders", "read_returns"].map(handle => ({ handle })) } };
    case "ReturnSnapshotOrder": return { order: order() };
    case "ReturnSnapshotPurchasedLines": return { order: { ...orderScope, lineItems: page([line(101, 4), line(102, 1)], variables.after) } };
    case "ReturnSnapshotFulfillmentLines": return { fulfillment: { ...fulfillmentScope, fulfillmentLineItems: page(
      id === gid("Fulfillment", 201) ? [
        { id: gid("FulfillmentLineItem", 301), quantity: 2, lineItem: { id: gid("LineItem", 101) } },
        { id: gid("FulfillmentLineItem", 302), quantity: 1, lineItem: { id: gid("LineItem", 102) } },
      ] : [{ id: gid("FulfillmentLineItem", 401), quantity: 2, lineItem: { id: gid("LineItem", 101) } }], variables.after) } };
    case "ReturnSnapshotFulfillmentEvents": return { fulfillment: { ...fulfillmentScope, events: page([
      { id: gid("FulfillmentEvent", id === gid("Fulfillment", 201) ? 801 : 901), status: "IN_TRANSIT", happenedAt: timestamp },
      { id: gid("FulfillmentEvent", id === gid("Fulfillment", 201) ? 802 : 902), status: "DELIVERED", happenedAt: timestamp },
    ], variables.after) } };
    case "ReturnSnapshotReturns": return { order: { ...orderScope, returns: page([native(501, "OPEN"), native(502, "CLOSED")], variables.after) } };
    case "ReturnSnapshotNativeReturnLines": return { return: { ...native(id === gid("Return", 501) ? 501 : 502, id === gid("Return", 501) ? "OPEN" : "CLOSED"),
      returnLineItems: page([nativeLine(id === gid("Return", 501) ? 601 : 602, id === gid("Return", 501) ? 301 : 401)], variables.after) } };
    case "ReturnSnapshotRefundLines": return { refund: { id, updatedAt: timestamp, order: { id: gid("Order", 1001) }, return: { id: gid("Return", 501) },
      refundLineItems: page([{ id: gid("RefundLineItem", 1001), lineItem: { id: gid("LineItem", 101) }, quantity: 1, restockType: "NO_RESTOCK" }], variables.after) } };
    case "ReturnSnapshotReturnables": return { returnableFulfillments: page([
      { id: gid("ReturnableFulfillment", 201), fulfillment: { id: gid("Fulfillment", 201), order: { id: gid("Order", 1001) } } },
      { id: gid("ReturnableFulfillment", 202), fulfillment: { id: gid("Fulfillment", 202), order: { id: gid("Order", 1001) } } },
    ], variables.after) };
    case "ReturnSnapshotReturnableLines": return { returnableFulfillment: { id,
      fulfillment: { id: id === gid("ReturnableFulfillment", 201) ? gid("Fulfillment", 201) : gid("Fulfillment", 202), order: { id: gid("Order", 1001) } },
      returnableFulfillmentLineItems: page(id === gid("ReturnableFulfillment", 201) ? [
        { quantity: 1, fulfillmentLineItem: { id: gid("FulfillmentLineItem", 301), lineItem: { id: gid("LineItem", 101) } } },
        { quantity: 1, fulfillmentLineItem: { id: gid("FulfillmentLineItem", 302), lineItem: { id: gid("LineItem", 102) } } },
      ] : [{ quantity: 1, fulfillmentLineItem: { id: gid("FulfillmentLineItem", 401), lineItem: { id: gid("LineItem", 101) } } }], variables.after) } };
    default: throw new Error("Unrecognized fixture operation");
  }
}
const response = (data: unknown, headers: Record<string, string> = { "X-Shopify-API-Version": "2026-07" }) =>
  new Response(JSON.stringify({ data }), { status: 200, headers });
function setup(modify?: Modifier) {
  let observation = 0;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Variables };
    const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
    if (operation === "ReturnSnapshotOrder") observation++;
    const data = fixtureData(operation, body.variables ?? {});
    return response(modify ? modify(data, operation, body.variables ?? {}, observation) : data);
  });
  const resolveConnection = vi.fn(async () => connection());
  const now = vi.fn(() => new Date(observedAt));
  const reader = new ShopifyCustomerReturnSnapshotReader({ request, resolveConnection, now });
  return { reader, request, resolveConnection, now };
}
function child(data: Record<string, unknown>, name: string): Record<string, unknown> {
  return data[name] as Record<string, unknown>;
}
function connectionPage(data: Record<string, unknown>, root: string, field: string) {
  return child(data, root)[field] as { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}
afterEach(() => vi.restoreAllMocks());

describe("read-only Shopify return snapshots", () => {
  it("collects every nested page and preserves exact split, native-return and refund identities", async () => {
    const { reader, request, resolveConnection } = setup();
    const snapshot = await reader.read(input);
    expect(customerReturnShopifySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.shop).toEqual({ ...input.shop, shopId: gid("Shop", 1), scopes: { readOrders: true, readAllOrders: true, readReturns: true } });
    expect(snapshot.observedAt).toBe(observedAt);
    expect(snapshot.fulfillments.map(item => item.lines)).toEqual([
      [{ id: gid("FulfillmentLineItem", 301), lineItemId: gid("LineItem", 101), quantity: 2 },
        { id: gid("FulfillmentLineItem", 302), lineItemId: gid("LineItem", 102), quantity: 1 }],
      [{ id: gid("FulfillmentLineItem", 401), lineItemId: gid("LineItem", 101), quantity: 2 }],
    ]);
    expect(snapshot.fulfillments[0].events).toHaveLength(2);
    expect(snapshot.fulfillments[0].tracking).toEqual([{ number: "TRACK-201", company: "Fixture carrier" }]);
    expect(snapshot.returns.map(item => item.status)).toEqual(["OPEN", "CLOSED"]);
    expect(snapshot.refunds[0].returnId).toBe(snapshot.returns[0].id);
    expect(snapshot.returnableFulfillments[0].lines).toHaveLength(2);
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(snapshot)).not.toContain("test-only-secret");
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe("https://fixture.myshopify.com/admin/api/2026-07/graphql.json");
      expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
      expect(JSON.parse(String(init?.body)).query).toMatch(/^query ReturnSnapshot/);
      expect(JSON.parse(String(init?.body)).query).not.toMatch(/\bmutation\b/);
    }
  });

  it("does not infer delivery from success or returnability", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotOrder") for (const item of child(data, "order").fulfillments as Array<Record<string, unknown>>) {
        item.deliveredAt = null; item.inTransitAt = null; item.displayStatus = null;
      }
      if (operation === "ReturnSnapshotFulfillmentEvents") child(data, "fulfillment").events = page([], null);
      return data;
    });
    const snapshot = await reader.read(input);
    expect(snapshot.fulfillments[0]).toMatchObject({ status: "SUCCESS", deliveredAt: null, events: [] });
    expect(snapshot.returnableFulfillments).toHaveLength(2);
  });

  it("paginates native-return and refund child lines independently", async () => {
    const { reader } = setup((data, operation, variables) => {
      if (operation === "ReturnSnapshotReturns") for (const item of connectionPage(data, "order", "returns").nodes) {
        if (item.id === gid("Return", 501)) item.totalQuantity = 2;
      }
      if (operation === "ReturnSnapshotNativeReturnLines" && variables.id === gid("Return", 501)) {
        child(data, "return").totalQuantity = 2;
        child(data, "return").returnLineItems = page([nativeLine(601, 301), nativeLine(603, 301)], variables.after);
      }
      if (operation === "ReturnSnapshotRefundLines") child(data, "refund").refundLineItems = page([
        { id: gid("RefundLineItem", 1001), lineItem: { id: gid("LineItem", 101) }, quantity: 1, restockType: "NO_RESTOCK" },
        { id: gid("RefundLineItem", 1002), lineItem: { id: gid("LineItem", 102) }, quantity: 1, restockType: "RETURN" },
      ], variables.after);
      return data;
    });
    const snapshot = await reader.read(input);
    expect(snapshot.returns[0].lines).toHaveLength(2);
    expect(snapshot.refunds[0].lines).toHaveLength(2);
  });
  it("keeps canceled fulfillment provenance instead of merging it by purchased line or tracking", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotOrder") (child(data, "order").fulfillments as Array<Record<string, unknown>>)[1].status = "CANCELLED";
      return data;
    });
    expect((await reader.read(input)).fulfillments[1]).toMatchObject({ id: gid("Fulfillment", 202), status: "CANCELLED" });
  });
  it("enforces the domain's collection bound instead of returning the first 200 purchased lines", async () => {
    const { reader } = setup((data, operation, variables) => {
      if (operation === "ReturnSnapshotPurchasedLines") child(data, "order").lineItems =
        page(Array.from({ length: 201 }, (_, index) => line(1000 + index, 1)), variables.after, 100);
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_PAGINATION_INVALID" });
  });
  it("rejects native claim totals that overconsume the original fulfillment line", async () => {
    const { reader } = setup((data, operation, variables) => {
      if (operation === "ReturnSnapshotReturns") for (const item of connectionPage(data, "order", "returns").nodes) item.totalQuantity = 2;
      if (operation === "ReturnSnapshotNativeReturnLines") {
        child(data, "return").totalQuantity = 2;
        const item = connectionPage(data, "return", "returnLineItems").nodes[0];
        item.quantity = 2;
        item.fulfillmentLineItem = { id: gid("FulfillmentLineItem", 301), lineItem: { id: gid("LineItem", 101) } };
      }
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_RESPONSE_INVALID" });
  });
  it("rejects an inflated returnable ceiling without inventing an available quantity", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotReturnableLines") connectionPage(data, "returnableFulfillment", "returnableFulfillmentLineItems").nodes[0].quantity = 10;
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_IDENTITY_MISMATCH" });
  });

  it.each(["1001", gid("Order", 1001)])("accepts exact canonical order identity %s", async externalOrderId => {
    await expect(setup().reader.read({ ...input, externalOrderId })).resolves.toMatchObject({ order: { id: gid("Order", 1001) } });
  });
  it("preserves large string order IDs without numeric conversion", async () => {
    const externalOrderId = "90071992547409931234";
    const { reader } = setup(data => JSON.parse(JSON.stringify(data).replaceAll(gid("Order", 1001), gid("Order", externalOrderId))) as unknown);
    expect((await reader.read({ ...input, externalOrderId })).order.id).toBe(gid("Order", externalOrderId));
  });
  it.each(["#1001", " 1001", "001001", "1e3", gid("Customer", 1001), "1001/subpath"]) ("rejects unsafe external identity %s before any dependency", async externalOrderId => {
    const { reader, request, resolveConnection } = setup();
    await expect(reader.read({ ...input, externalOrderId })).rejects.toMatchObject({ code: "RETURN_SHOPIFY_INPUT_INVALID" });
    expect(request).not.toHaveBeenCalled(); expect(resolveConnection).not.toHaveBeenCalled();
  });

  it.each(["read_orders", "read_all_orders", "read_returns"])("requires current %s scope", async missing => {
    const { reader, request } = setup((data, operation) => {
      if (operation === "ReturnSnapshotAccount") child(data, "currentAppInstallation").accessScopes =
        ["read_orders", "read_all_orders", "read_returns"].filter(scope => scope !== missing).map(handle => ({ handle }));
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_SCOPE_MISSING" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects a different current Shopify account", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotAccount") child(data, "shop").myshopifyDomain = "different.myshopify.com";
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_IDENTITY_MISMATCH" });
  });
  it.each(["channelId", "id", "shopDomain"])("rejects mismatched configured connection %s", async field => {
    const { reader, resolveConnection, request } = setup();
    resolveConnection.mockResolvedValueOnce({ ...connection(), [field]: field === "shopDomain" ? "other.myshopify.com" : 99 });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_CONNECTION_CHANGED" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rechecks connection credentials after both observations", async () => {
    const { reader, resolveConnection } = setup();
    resolveConnection.mockResolvedValueOnce(connection()).mockResolvedValueOnce({ ...connection(), accessToken: "rotated-secret" });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_CONNECTION_CHANGED" });
  });
  it("sanitizes resolver failures", async () => {
    const { reader, resolveConnection } = setup();
    resolveConnection.mockRejectedValueOnce(new Error("secret customer database failure"));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_CONNECTION_UNAVAILABLE", message: "The Shopify order snapshot could not be verified." });
  });

  it.each([undefined, "2025-10"])("rejects missing or wrong served API version %s", async version => {
    const { reader, request } = setup();
    request.mockResolvedValueOnce(response({}, version ? { "X-Shopify-API-Version": version } : {}));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_VERSION_MISMATCH" });
  });
  it.each([401, 403, 429, 500])("classifies HTTP %i without provider-body leakage", async status => {
    const { reader, request } = setup();
    request.mockResolvedValueOnce(new Response("secret provider payload", { status }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_HTTP_REJECTED", failureClass: status >= 429 ? "transient" : "permanent" });
  });
  it("rejects partial GraphQL data with errors", async () => {
    const { reader, request } = setup();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ data: fixtureData("ReturnSnapshotAccount", {}), errors: [{ message: "secret", extensions: { code: "THROTTLED" } }] }),
      { headers: { "X-Shopify-API-Version": "2026-07" } }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_GRAPHQL_REJECTED", failureClass: "transient" });
  });
  it.each(["invalid json", "null", "[]", '{"data":null}'])("rejects malformed envelope %s", async body => {
    const { reader, request } = setup();
    request.mockResolvedValueOnce(new Response(body, { headers: { "X-Shopify-API-Version": "2026-07" } }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_RESPONSE_INVALID" });
  });
  it("limits response bytes", async () => {
    const { reader, request } = setup();
    request.mockResolvedValueOnce(new Response(" ".repeat(2_000_001), { headers: { "X-Shopify-API-Version": "2026-07" } }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_SNAPSHOT_LIMIT" });
  });
  it("bounds an uncooperative request with the transport abort signal", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const { reader, request } = setup();
    request.mockImplementationOnce(async () => { controller.abort(); return new Promise<Response>(() => undefined); });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_TRANSPORT_FAILED" });
  });
  it("bounds a stalled successful response body", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const { reader, request } = setup();
    request.mockResolvedValueOnce(new Response(new ReadableStream({ pull() { controller.abort(); } }), { headers: { "X-Shopify-API-Version": "2026-07" } }));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_TRANSPORT_FAILED" });
  });

  it.each(["duplicate", "missingCursor", "repeatedCursor", "emptyNext", "missingPageInfo"])("fails closed for %s pagination", async mode => {
    const { reader } = setup((data, operation, variables) => {
      if (operation === "ReturnSnapshotPurchasedLines") {
        const result = connectionPage(data, "order", "lineItems");
        if (mode === "duplicate" && variables.after) result.nodes[0] = line(101, 4);
        if (mode === "missingCursor") result.pageInfo.endCursor = null;
        if (mode === "repeatedCursor" && variables.after) result.pageInfo.endCursor = "cursor:1";
        if (mode === "emptyNext") { result.nodes = []; result.pageInfo.hasNextPage = true; }
        if (mode === "missingPageInfo") delete (result as Partial<typeof result>).pageInfo;
      }
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_PAGINATION_INVALID" });
  });
  it("does not accept array truncation or estimated fulfillment counts", async () => {
    for (const count of [{ count: 3, precision: "EXACT" }, { count: 2, precision: "AT_LEAST" }]) {
      const { reader } = setup((data, operation) => { if (operation === "ReturnSnapshotOrder") child(data, "order").fulfillmentsCount = count; return data; });
      await expect(reader.read(input)).rejects.toBeInstanceOf(CustomerReturnShopifySnapshotError);
    }
  });
  it("rejects an unknown native-return line type", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotNativeReturnLines") connectionPage(data, "return", "returnLineItems").nodes[0].__typename = "UnfulfilledReturnLineItem";
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_PAGINATION_INVALID" });
  });
  it.each([null, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("rejects invalid provider quantity %s", async value => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotFulfillmentLines") connectionPage(data, "fulfillment", "fulfillmentLineItems").nodes[0].quantity = value;
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_PAGINATION_INVALID" });
  });
  it("rejects a purchased-line identity masquerading as a fulfillment-line identity", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotFulfillmentLines") connectionPage(data, "fulfillment", "fulfillmentLineItems").nodes[0].id = gid("LineItem", 101);
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_PAGINATION_INVALID" });
  });
  it("detects changed native claim allocation with identical order timestamp and total", async () => {
    const { reader } = setup((data, operation, _variables, observation) => {
      if (operation === "ReturnSnapshotNativeReturnLines" && observation === 2) {
        connectionPage(data, "return", "returnLineItems").nodes[0].fulfillmentLineItem = { id: gid("FulfillmentLineItem", 401), lineItem: { id: gid("LineItem", 101) } };
      }
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_SNAPSHOT_CHANGED" });
  });
  it("detects changes to an intermediate parent's revision or ownership", async () => {
    const { reader } = setup((data, operation) => { if (operation === "ReturnSnapshotFulfillmentLines") child(data, "fulfillment").order = { id: gid("Order", 999) }; return data; });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_SNAPSHOT_CHANGED" });
  });
  it("requires a collected exact fulfillment allocation for every native claim", async () => {
    const { reader } = setup((data, operation) => {
      if (operation === "ReturnSnapshotNativeReturnLines") connectionPage(data, "return", "returnLineItems").nodes[0].fulfillmentLineItem =
        { id: gid("FulfillmentLineItem", 999), lineItem: { id: gid("LineItem", 101) } };
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_IDENTITY_MISMATCH" });
  });
  it("rejects returnable quantity attributed to another fulfillment", async () => {
    const { reader } = setup((data, operation, variables) => {
      if (operation === "ReturnSnapshotReturnableLines" && variables.id === gid("ReturnableFulfillment", 202)) {
        connectionPage(data, "returnableFulfillment", "returnableFulfillmentLineItems").nodes[0].fulfillmentLineItem =
          { id: gid("FulfillmentLineItem", 301), lineItem: { id: gid("LineItem", 101) } };
      }
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_IDENTITY_MISMATCH" });
  });
  it("fails a changed shop ID despite unchanged shop domain", async () => {
    const { reader } = setup((data, operation, _variables, observation) => {
      if (operation === "ReturnSnapshotAccount" && observation === 2) child(data, "shop").id = gid("Shop", 2);
      return data;
    });
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_CONNECTION_CHANGED" });
  });
  it("rejects invalid injected time", async () => {
    const { reader, now } = setup(); now.mockReturnValueOnce(new Date("invalid"));
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_CLOCK_INVALID" });
  });
});
