/**
 * Unit tests for `pushShopifyFulfillment` (§6 Commit 21).
 *
 * Scope: this commit lands scaffolding only — no callers wire the
 * function in production yet. These tests protect the contract C22 and
 * later commits will rely on:
 *
 *   - Reads strictly from WMS (post-WMS-source-of-truth refactor)
 *   - Resolves Shopify fulfillment-order line items via the GQL
 *     `fulfillmentOrders` query (Path B — schema does not carry the
 *     stored mapping yet; see commit body)
 *   - Calls `fulfillmentCreateV2` with a payload grouped by
 *     fulfillmentOrderId
 *   - Persists the returned Fulfillment GID back into
 *     `wms.outbound_shipments.shopify_fulfillment_id`
 *   - Throws `ShopifyFulfillmentPushError` (with structured `context`)
 *     on every documented failure mode so the C22 retry/DLQ wrapper
 *     can classify without parsing message strings
 *
 * Mocks: in-memory db.execute that scripts SQL responses in call order,
 * and an in-memory ShopifyAdminGraphQLClient. No fetch, no real DB.
 *
 * Standards: coding-standards Rule #9 (happy path + edge cases),
 * Rule #15 (test-coverage explanation in completion report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFulfillmentPushService,
  ShopifyFulfillmentPushError,
  SHOPIFY_PUSH_INVALID_INPUT,
  SHOPIFY_PUSH_CLIENT_NOT_SET,
  SHOPIFY_PUSH_USER_ERRORS,
  SHOPIFY_PUSH_NETWORK_ERROR,
  SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS,
} from "../../fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const SHIPMENT_ID = 9001;
const ORDER_ID = 4242;
const SHOPIFY_ORDER_GID = "gid://shopify/Order/123456789";

function okShipmentRow(overrides: Partial<any> = {}) {
  return {
    id: SHIPMENT_ID,
    order_id: ORDER_ID,
    channel_id: 7,
    status: "labeled",
    carrier: "USPS",
    tracking_number: "9400110000000000000001",
    tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400110000000000000001",
    shopify_fulfillment_id: null,
    ...overrides,
  };
}

function okOrderRow(overrides: Partial<any> = {}) {
  return {
    id: ORDER_ID,
    channel_id: 7,
    source: "shopify",
    external_order_id: SHOPIFY_ORDER_GID,
    oms_fulfillment_order_id: "100",
    ...overrides,
  };
}

function okItems() {
  return [
    {
      shipment_item_id: 1,
      order_item_id: 500,
      oms_order_line_id: 8001,
      sku: "ABC-1",
      qty: 2,
    },
    {
      shipment_item_id: 2,
      order_item_id: 501,
      oms_order_line_id: 8002,
      sku: "XYZ-9",
      qty: 1,
    },
  ];
}

function okFulfillmentOrdersResponse() {
  return {
    order: {
      id: SHOPIFY_ORDER_GID,
      fulfillmentOrders: {
        edges: [
          {
            node: {
              id: "gid://shopify/FulfillmentOrder/777",
              status: "OPEN",
              lineItems: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/FulfillmentOrderLineItem/777-1",
                      sku: "ABC-1",
                      remainingQuantity: 2,
                    },
                  },
                  {
                    node: {
                      id: "gid://shopify/FulfillmentOrderLineItem/777-2",
                      sku: "XYZ-9",
                      remainingQuantity: 1,
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

function okFulfillmentCreateV2Response(
  fulfillmentGid = "gid://shopify/Fulfillment/55555",
) {
  return {
    fulfillmentCreateV2: {
      fulfillment: { id: fulfillmentGid, status: "SUCCESS" },
      userErrors: [],
    },
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────

interface ScriptedDb {
  db: { execute: ReturnType<typeof vi.fn> };
  capturedQueries: Array<{ sqlText: string; params: unknown[] }>;
}

/**
 * Build a db mock that returns each scripted result in call order.
 *
 * The fulfillment-push service issues these queries (in this order) for
 * a Shopify push:
 *   1. SELECT shipment row
 *   2. SELECT order row
 *   3. SELECT channel.provider          (only if order.channel_id is set)
 *   4. SELECT shipment items (joined)
 *   5. UPDATE wms.outbound_shipments    (returns nothing meaningful)
 */
function makeDb(scripted: Array<{ rows: any[] }>): ScriptedDb {
  const remaining = [...scripted];
  const captured: ScriptedDb["capturedQueries"] = [];
  const execute = vi.fn(async (query: any) => {
    // drizzle's `sql` template returns an object whose `queryChunks` is
    // an array of mixed StringChunk + Param entries. Stringify each
    // chunk's `.value` (StringChunk) and skip Param objects so the
    // resulting text reflects the SQL identifiers/keywords we care
    // about for assertions. Order-based scripting handles the rest.
    let sqlText = "";
    try {
      const chunks = (query as any)?.queryChunks;
      if (Array.isArray(chunks)) {
        sqlText = chunks
          .map((c: any) => {
            if (c == null) return "";
            if (typeof c === "string") return c;
            // drizzle StringChunk: { value: string[] }
            if (Array.isArray(c.value)) return c.value.join("");
            if (typeof c.value === "string") return c.value;
            return "";
          })
          .join("");
      } else {
        sqlText = String(query);
      }
    } catch {
      sqlText = "<unstringifiable>";
    }
    captured.push({ sqlText, params: [] });
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });
  return { db: { execute }, capturedQueries: captured };
}

interface MockClient extends ShopifyAdminGraphQLClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
}

function makeShopifyClient(
  responses: Array<unknown | (() => unknown)>,
): MockClient {
  const remaining = [...responses];
  const calls: MockClient["calls"] = [];
  return {
    calls,
    async request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });
      if (remaining.length === 0) {
        throw new Error("MockClient: no scripted response remaining");
      }
      const next = remaining.shift();
      const value = typeof next === "function" ? (next as () => unknown)() : next;
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("pushShopifyFulfillment :: happy path", () => {
  let db: ScriptedDb;
  let client: MockClient;

  beforeEach(() => {
    db = makeDb([
      { rows: [okShipmentRow()] },        // 1. shipment
      { rows: [okOrderRow()] },           // 2. order
      { rows: [{ provider: "shopify" }] }, // 3. channel.provider
      { rows: okItems() },                 // 4. shipment items
      { rows: [] },                        // 5. UPDATE
    ]);
    client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okFulfillmentCreateV2Response(),
    ]);
  });

  it("performs full WMS read, GQL calls, and persists the Fulfillment GID", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(result).toBe("gid://shopify/Fulfillment/55555");
    // 5 db.execute calls in order
    expect(db.db.execute).toHaveBeenCalledTimes(5);
    // 2 Shopify GQL calls: fulfillmentOrders, then fulfillmentCreateV2
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].query).toContain("fulfillmentOrders");
    expect(client.calls[0].variables).toEqual({ id: SHOPIFY_ORDER_GID });
    expect(client.calls[1].query).toContain("fulfillmentCreateV2");
  });

  it("builds a correctly-grouped lineItemsByFulfillmentOrder payload", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const mutationVars = client.calls[1].variables as any;
    const fulfillment = mutationVars.fulfillment;

    expect(fulfillment.notifyCustomer).toBe(true);
    expect(fulfillment.trackingInfo).toEqual({
      number: "9400110000000000000001",
      company: "USPS",
      url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400110000000000000001",
    });

    expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
    const fo = fulfillment.lineItemsByFulfillmentOrder[0];
    expect(fo.fulfillmentOrderId).toBe("gid://shopify/FulfillmentOrder/777");
    expect(fo.fulfillmentOrderLineItems).toEqual([
      { id: "gid://shopify/FulfillmentOrderLineItem/777-1", quantity: 2 },
      { id: "gid://shopify/FulfillmentOrderLineItem/777-2", quantity: 1 },
    ]);
  });

  it("persists shopify_fulfillment_id back to wms.outbound_shipments on success", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    // Last db.execute call is the UPDATE
    const updateCall = db.capturedQueries[db.capturedQueries.length - 1];
    expect(updateCall.sqlText).toContain("UPDATE wms.outbound_shipments");
    expect(updateCall.sqlText).toContain("shopify_fulfillment_id");
    expect(updateCall.sqlText).toContain("updated_at");
  });

  it("omits trackingInfo.url when shipment has no tracking_url", async () => {
    db = makeDb([
      { rows: [okShipmentRow({ tracking_url: null })] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: [] },
    ]);
    client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const fulfillment = (client.calls[1].variables as any).fulfillment;
    expect(fulfillment.trackingInfo).toEqual({
      number: "9400110000000000000001",
      company: "USPS",
    });
    expect(fulfillment.trackingInfo.url).toBeUndefined();
  });
});

describe("pushShopifyFulfillment :: validation failures", () => {
  it("throws when shipmentId is non-positive", async () => {
    const db = makeDb([]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(0);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("shipmentId");
  });

  it("throws when shipment row is missing", async () => {
    const db = makeDb([{ rows: [] }]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("shipment");
  });

  it("throws when tracking_number is missing", async () => {
    const db = makeDb([
      { rows: [okShipmentRow({ tracking_number: null })] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("tracking_number");
  });

  it("throws when tracking_number is empty string", async () => {
    const db = makeDb([
      { rows: [okShipmentRow({ tracking_number: "   " })] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    await expect(svc.pushShopifyFulfillment(SHIPMENT_ID)).rejects.toMatchObject({
      context: { code: SHOPIFY_PUSH_INVALID_INPUT, field: "tracking_number" },
    });
  });

  it("throws when carrier is missing", async () => {
    const db = makeDb([
      { rows: [okShipmentRow({ carrier: null })] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("carrier");
  });

  it("returns null (noop) when channel is non-Shopify", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow({ source: "ebay", channel_id: 8 })] },
      { rows: [{ provider: "ebay" }] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result).toBeNull();
  });

  it("throws when Shopify client is not set", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    // intentionally do NOT call setShopifyClient

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_CLIENT_NOT_SET);
    expect(err?.message).toContain("shopify client not initialized");
  });

  it("throws when shipment has zero items", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: [] }, // no items
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("items");
  });

  it("throws when all items have non-positive quantity", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      {
        rows: [
          { shipment_item_id: 1, order_item_id: 500, oms_order_line_id: 8001, sku: "ABC-1", qty: 0 },
        ],
      },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    await expect(svc.pushShopifyFulfillment(SHIPMENT_ID)).rejects.toMatchObject({
      context: { code: SHOPIFY_PUSH_INVALID_INPUT, field: "items" },
    });
  });

  it("throws when external_order_id is missing", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow({ external_order_id: null })] },
      { rows: [{ provider: "shopify" }] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_INVALID_INPUT);
    expect(err?.context.field).toBe("external_order_id");
  });
});

describe("pushShopifyFulfillment :: GraphQL failures", () => {
  it("throws SHOPIFY_PUSH_USER_ERRORS when fulfillmentCreateV2 returns userErrors", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      {
        fulfillmentCreateV2: {
          fulfillment: null,
          userErrors: [
            { field: ["fulfillment", "trackingInfo"], message: "Tracking number is invalid" },
          ],
        },
      },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_USER_ERRORS);
    expect(err?.message).toContain("Tracking number is invalid");
    expect(err?.context.userErrors).toHaveLength(1);
  });

  it("throws SHOPIFY_PUSH_NETWORK_ERROR when fulfillmentCreateV2 transport fails", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      new Error("ECONNRESET"),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_NETWORK_ERROR);
    expect(err?.context.cause).toContain("ECONNRESET");
  });

  it("throws SHOPIFY_PUSH_NETWORK_ERROR when fulfillmentOrders lookup transport fails", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
    ]);
    const client = makeShopifyClient([
      new Error("ETIMEDOUT"),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_NETWORK_ERROR);
    expect(err?.context.cause).toContain("ETIMEDOUT");
  });

  it("throws SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS when Shopify returns no fulfillment orders", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
    ]);
    const client = makeShopifyClient([
      { order: { id: SHOPIFY_ORDER_GID, fulfillmentOrders: { edges: [] } } },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS);
  });

  it("throws SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS when no fulfillment-order line matches a sku", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      {
        rows: [
          { shipment_item_id: 1, order_item_id: 500, oms_order_line_id: 8001, sku: "MYSTERY-SKU", qty: 1 },
        ],
      },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(), // only has ABC-1 and XYZ-9
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err?.context.code).toBe(SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS);
    expect(err?.message).toContain("MYSTERY-SKU");
  });

  it("skips CLOSED fulfillment orders when matching", async () => {
    const db = makeDb([
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      {
        rows: [
          { shipment_item_id: 1, order_item_id: 500, oms_order_line_id: 8001, sku: "ABC-1", qty: 1 },
        ],
      },
    ]);
    // Two FOs: a CLOSED one (must be skipped) and an OPEN one we should match
    const client = makeShopifyClient([
      {
        order: {
          id: SHOPIFY_ORDER_GID,
          fulfillmentOrders: {
            edges: [
              {
                node: {
                  id: "gid://shopify/FulfillmentOrder/CLOSED",
                  status: "CLOSED",
                  lineItems: {
                    edges: [
                      { node: { id: "gid://shopify/FulfillmentOrderLineItem/closed-1", sku: "ABC-1", remainingQuantity: 5 } },
                    ],
                  },
                },
              },
              {
                node: {
                  id: "gid://shopify/FulfillmentOrder/OPEN",
                  status: "OPEN",
                  lineItems: {
                    edges: [
                      { node: { id: "gid://shopify/FulfillmentOrderLineItem/open-1", sku: "ABC-1", remainingQuantity: 5 } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const fulfillment = (client.calls[1].variables as any).fulfillment;
    expect(fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(
      "gid://shopify/FulfillmentOrder/OPEN",
    );
  });
});

describe("setShopifyClient", () => {
  it("is exposed on the service", () => {
    const db = makeDb([]);
    const svc = createFulfillmentPushService(db.db, null);
    expect(typeof svc.setShopifyClient).toBe("function");
  });

  it("does not affect existing eBay path / setEbayClient", () => {
    const db = makeDb([]);
    const svc = createFulfillmentPushService(db.db, null);
    expect(typeof svc.setEbayClient).toBe("function");
    expect(typeof svc.pushTracking).toBe("function");
  });
});
