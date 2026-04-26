/**
 * Unit tests for `pushShopifyFulfillment` (§6 Group E).
 *
 * Coverage scopes:
 *   - C21 contract: WMS-only reads, GQL resolver + create, persists
 *     Fulfillment GID into wms.outbound_shipments.shopify_fulfillment_id,
 *     structured ShopifyFulfillmentPushError on every documented failure.
 *   - C22c upgrades:
 *       D1  Idempotency: skip push when shipment already has
 *           shopify_fulfillment_id; return alreadyPushed:true.
 *       D2/D4 Path A primary: when oms.oms_order_lines carry FO line
 *           item ids (populated by C22b ingest), use them directly and
 *           skip the live Shopify FO resolution query.
 *       D2  Self-healing back-write: when Path B resolves IDs, write
 *           them to oms_order_lines so the next push uses Path A.
 *           Failure here is non-fatal.
 *       D13 Location filter: only push for FOs assigned to OUR
 *           warehouse/channel `shopify_location_id`. 3PL-assigned FOs
 *           are skipped (they handle their own Shopify fulfillments).
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
  __test__,
} from "../../fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const SHIPMENT_ID = 9001;
const ORDER_ID = 4242;
const CHANNEL_ID = 7;
const SHOPIFY_ORDER_GID = "gid://shopify/Order/123456789";
const FO_GID = "gid://shopify/FulfillmentOrder/777";
const OUR_LOCATION_GID = "gid://shopify/Location/100100";
const OUR_LOCATION_NUMERIC = "100100";
const SHIPMONK_LOCATION_GID = "gid://shopify/Location/200200";

function okShipmentRow(overrides: Partial<any> = {}) {
  return {
    id: SHIPMENT_ID,
    order_id: ORDER_ID,
    channel_id: CHANNEL_ID,
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
    channel_id: CHANNEL_ID,
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

/** Path A read with both rows populated (Path A usable). */
function pathAFullyPopulatedRows() {
  return [
    {
      shipment_item_id: 1,
      quantity: 2,
      oms_order_line_id: 8001,
      shopify_fulfillment_order_id: FO_GID,
      shopify_fulfillment_order_line_item_id: "gid://shopify/FulfillmentOrderLineItem/777-1",
    },
    {
      shipment_item_id: 2,
      quantity: 1,
      oms_order_line_id: 8002,
      shopify_fulfillment_order_id: FO_GID,
      shopify_fulfillment_order_line_item_id: "gid://shopify/FulfillmentOrderLineItem/777-2",
    },
  ];
}

/** Path A read with one row missing FO line item id (forces Path B fallback). */
function pathAPartialRows() {
  return [
    {
      shipment_item_id: 1,
      quantity: 2,
      oms_order_line_id: 8001,
      shopify_fulfillment_order_id: FO_GID,
      shopify_fulfillment_order_line_item_id: "gid://shopify/FulfillmentOrderLineItem/777-1",
    },
    {
      shipment_item_id: 2,
      quantity: 1,
      oms_order_line_id: 8002,
      shopify_fulfillment_order_id: null,
      shopify_fulfillment_order_line_item_id: null,
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
              id: FO_GID,
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

/** Location-filter response: FO_GID assigned to OUR location. */
function okLocationFilterResponse(
  fulfillmentOrders: Array<{ id: string; locationGid: string | null }> = [
    { id: FO_GID, locationGid: OUR_LOCATION_GID },
  ],
) {
  return {
    order: {
      id: SHOPIFY_ORDER_GID,
      fulfillmentOrders: {
        edges: fulfillmentOrders.map((fo) => ({
          node: {
            id: fo.id,
            assignedLocation: fo.locationGid
              ? { location: { id: fo.locationGid } }
              : null,
          },
        })),
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
 * For a Shopify push (Path B end-to-end), the service issues these
 * queries in order:
 *
 *   1. Idempotency SELECT  on wms.outbound_shipments.shopify_fulfillment_id
 *   2. SELECT shipment row on wms.outbound_shipments
 *   3. SELECT order row    on wms.orders
 *   4. SELECT channel.provider on channels.channels (if channel_id set)
 *   5. SELECT shipment items joined to wms.order_items
 *   6. SELECT Path A rows joined through oms.oms_order_lines
 *   7. UPDATE oms.oms_order_lines for each back-write (Path B only)
 *   8. SELECT warehouse.warehouses.shopify_location_id
 *   9. SELECT channels.channels.shopify_location_id
 *  10. UPDATE wms.outbound_shipments.shopify_fulfillment_id
 *
 * Path A drops step 7 (no back-writes). Idempotency hits return after step 1.
 */
function makeDb(scripted: Array<{ rows: any[] }>): ScriptedDb {
  const remaining = [...scripted];
  const captured: ScriptedDb["capturedQueries"] = [];
  const execute = vi.fn(async (query: any) => {
    let sqlText = "";
    try {
      const chunks = (query as any)?.queryChunks;
      if (Array.isArray(chunks)) {
        sqlText = chunks
          .map((c: any) => {
            if (c == null) return "";
            if (typeof c === "string") return c;
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

/** Convenience: warehouse + channel rows for the location filter step. */
function locationConfigRows() {
  return [
    { rows: [{ shopify_location_id: OUR_LOCATION_NUMERIC }] }, // warehouses
    { rows: [{ shopify_location_id: null }] },                  // channels
  ];
}

/** No-locations-configured rows (skip filter path). */
function emptyLocationConfigRows() {
  return [
    { rows: [] }, // warehouses
    { rows: [{ shopify_location_id: null }] }, // channels
  ];
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("pushShopifyFulfillment :: happy path (Path B end-to-end)", () => {
  let db: ScriptedDb;
  let client: MockClient;

  beforeEach(() => {
    db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },     // 1. idempotency
      { rows: [okShipmentRow()] },                       // 2. shipment
      { rows: [okOrderRow()] },                          // 3. order
      { rows: [{ provider: "shopify" }] },               // 4. channel.provider
      { rows: okItems() },                               // 5. shipment items
      { rows: pathAPartialRows() },                      // 6. Path A read (partial → Path B)
      { rows: [] },                                      // 7. back-write item 1
      { rows: [] },                                      // 7. back-write item 2
      ...locationConfigRows(),                           // 8-9. location config
      { rows: [] },                                      // 10. UPDATE shipment
    ]);
    client = makeShopifyClient([
      okFulfillmentOrdersResponse(),       // Path B resolver
      okLocationFilterResponse(),          // location filter
      okFulfillmentCreateV2Response(),     // mutation
    ]);
  });

  it("performs full WMS read, GQL calls, and persists the Fulfillment GID", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(result).toEqual({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/55555",
      alreadyPushed: false,
    });
    // 11 db.execute calls: idem, shipment, order, channel.provider, items,
    // path-A read, 2 back-writes (one per item), warehouses, channels (loc),
    // UPDATE shipment.
    expect(db.db.execute).toHaveBeenCalledTimes(11);
    // 3 Shopify GQL calls: fulfillmentOrders (resolve), fulfillmentOrders (location), fulfillmentCreateV2
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0].query).toContain("fulfillmentOrders");
    expect(client.calls[0].query).toContain("remainingQuantity");
    expect(client.calls[0].variables).toEqual({ id: SHOPIFY_ORDER_GID });
    expect(client.calls[1].query).toContain("assignedLocation");
    expect(client.calls[2].query).toContain("fulfillmentCreateV2");
  });

  it("builds a correctly-grouped lineItemsByFulfillmentOrder payload", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const mutationVars = client.calls[2].variables as any;
    const fulfillment = mutationVars.fulfillment;

    expect(fulfillment.notifyCustomer).toBe(true);
    expect(fulfillment.trackingInfo).toEqual({
      number: "9400110000000000000001",
      company: "USPS",
      url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400110000000000000001",
    });

    expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
    const fo = fulfillment.lineItemsByFulfillmentOrder[0];
    expect(fo.fulfillmentOrderId).toBe(FO_GID);
    expect(fo.fulfillmentOrderLineItems).toEqual([
      { id: "gid://shopify/FulfillmentOrderLineItem/777-1", quantity: 2 },
      { id: "gid://shopify/FulfillmentOrderLineItem/777-2", quantity: 1 },
    ]);
  });

  it("persists shopify_fulfillment_id back to wms.outbound_shipments on success", async () => {
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const updateCall = db.capturedQueries[db.capturedQueries.length - 1];
    expect(updateCall.sqlText).toContain("UPDATE wms.outbound_shipments");
    expect(updateCall.sqlText).toContain("shopify_fulfillment_id");
    expect(updateCall.sqlText).toContain("updated_at");
  });

  it("omits trackingInfo.url when shipment has no tracking_url", async () => {
    db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ tracking_url: null })] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
      { rows: [] },
      { rows: [] },
      ...locationConfigRows(),
      { rows: [] },
    ]);
    client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const fulfillment = (client.calls[2].variables as any).fulfillment;
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
    const db = makeDb([
      { rows: [] }, // idempotency: no row
      { rows: [] }, // shipment SELECT: no row → throws
    ]);
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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow({ source: "ebay", channel_id: 8 })] },
      { rows: [{ provider: "ebay" }] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(makeShopifyClient([]));

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result).toEqual({ shopifyFulfillmentId: null, alreadyPushed: false });
  });

  it("throws when Shopify client is not set", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
    ]);
    const svc = createFulfillmentPushService(db.db, null);

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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
      { rows: [] }, { rows: [] }, // back-writes
      ...locationConfigRows(),
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
      { rows: [] }, { rows: [] },
      ...locationConfigRows(),
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      {
        rows: [
          { shipment_item_id: 1, order_item_id: 500, oms_order_line_id: 8001, sku: "MYSTERY-SKU", qty: 1 },
        ],
      },
      { rows: [] }, // Path A: no row joined → null → Path B
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
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      {
        rows: [
          { shipment_item_id: 1, order_item_id: 500, oms_order_line_id: 8001, sku: "ABC-1", qty: 1 },
        ],
      },
      { rows: [] },                                      // Path A null → Path B
      { rows: [] },                                      // back-write
      ...locationConfigRows(),
      { rows: [] },                                      // UPDATE shipment
    ]);
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
      // Location filter: only the OPEN one is reported, assigned to OUR location
      okLocationFilterResponse([
        { id: "gid://shopify/FulfillmentOrder/OPEN", locationGid: OUR_LOCATION_GID },
      ]),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const fulfillment = (client.calls[2].variables as any).fulfillment;
    expect(fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(
      "gid://shopify/FulfillmentOrder/OPEN",
    );
  });
});

// ─── C22c: Idempotency (D1) ─────────────────────────────────────────

describe("pushShopifyFulfillment :: idempotency (D1)", () => {
  it("skips push and returns existing GID when shopify_fulfillment_id is already set", async () => {
    const existing = "gid://shopify/Fulfillment/already-pushed-001";
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: existing }] },
    ]);
    const client = makeShopifyClient([]); // no GQL calls expected
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(result).toEqual({
      shopifyFulfillmentId: existing,
      alreadyPushed: true,
    });
    // Only the idempotency SELECT fired
    expect(db.db.execute).toHaveBeenCalledTimes(1);
    expect(client.calls).toHaveLength(0);
  });

  it("treats empty-string shopify_fulfillment_id as not pushed and proceeds", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: "" }] },        // 1. idempotency: empty → not pushed
      { rows: [okShipmentRow()] },                       // 2. shipment
      { rows: [okOrderRow()] },                          // 3. order
      { rows: [{ provider: "shopify" }] },               // 4. channel
      { rows: okItems() },                               // 5. items
      { rows: pathAFullyPopulatedRows() },               // 6. Path A (full)
      ...locationConfigRows(),                           // 7-8. location config
      { rows: [] },                                      // 9. UPDATE
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.alreadyPushed).toBe(false);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
  });

  it("proceeds with push when shopify_fulfillment_id is null", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result).toEqual({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/55555",
      alreadyPushed: false,
    });
  });
});

// ─── C22c: Path A primary (D2/D4) ───────────────────────────────────

describe("pushShopifyFulfillment :: Path A primary (D2/D4)", () => {
  it("uses Path A and skips the fulfillmentOrders resolver query when all FO IDs are stored", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },               // ← Path A usable
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      // No fulfillmentOrders resolver query — Path A skipped it.
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
    // Exactly 2 GQL calls (location filter + create), NOT 3.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].query).toContain("assignedLocation");
    expect(client.calls[1].query).toContain("fulfillmentCreateV2");

    // Mutation payload uses the stored IDs from Path A.
    const fulfillment = (client.calls[1].variables as any).fulfillment;
    expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
    expect(fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(FO_GID);
  });

  it("falls back to Path B when some oms_order_lines have null FO line item IDs", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },                      // ← partial → fallback
      { rows: [] }, { rows: [] },                        // back-writes (Path B)
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),                     // Path B resolver fires
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(client.calls).toHaveLength(3);
    expect(client.calls[0].query).toContain("remainingQuantity");
  });

  it("falls back to Path B when Path A read returns no rows (defensive)", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: [] },                                      // ← Path A empty
      { rows: [] }, { rows: [] },                        // back-writes
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    expect(client.calls).toHaveLength(3);
  });
});

// ─── C22c: Self-healing back-write (D2) ─────────────────────────────

describe("pushShopifyFulfillment :: self-healing back-write (D2)", () => {
  it("writes resolved FO IDs back to oms_order_lines when Path B succeeds", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
      { rows: [] }, { rows: [] },                        // back-writes
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    // Find the back-write UPDATE statements among captured queries.
    const backWrites = db.capturedQueries.filter((q) =>
      q.sqlText.includes("UPDATE oms.oms_order_lines"),
    );
    expect(backWrites).toHaveLength(2);
    expect(backWrites[0].sqlText).toContain("shopify_fulfillment_order_id");
    expect(backWrites[0].sqlText).toContain("shopify_fulfillment_order_line_item_id");
    // Idempotency guard
    expect(backWrites[0].sqlText).toContain("IS NULL");
  });

  it("does NOT issue back-write UPDATEs when Path A is used (already populated)", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    await svc.pushShopifyFulfillment(SHIPMENT_ID);

    const backWrites = db.capturedQueries.filter((q) =>
      q.sqlText.includes("UPDATE oms.oms_order_lines"),
    );
    expect(backWrites).toHaveLength(0);
  });

  it("push still succeeds when a back-write UPDATE throws (non-fatal)", async () => {
    // Build a db whose 7th + 8th calls (the back-writes) throw.
    let callIdx = 0;
    const remaining: Array<{ rows: any[] }> = [
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAPartialRows() },
      { rows: [] }, { rows: [] },                        // ignored — overridden below
      ...locationConfigRows(),
      { rows: [] },
    ];
    const captured: Array<{ sqlText: string }> = [];
    const execute = vi.fn(async (query: any) => {
      const chunks = (query as any)?.queryChunks;
      let sqlText = "";
      if (Array.isArray(chunks)) {
        sqlText = chunks
          .map((c: any) => {
            if (c == null) return "";
            if (typeof c === "string") return c;
            if (Array.isArray(c.value)) return c.value.join("");
            if (typeof c.value === "string") return c.value;
            return "";
          })
          .join("");
      }
      captured.push({ sqlText });
      const i = callIdx++;
      // Calls 7 and 8 (zero-indexed 6 and 7) are the back-writes.
      if (sqlText.includes("UPDATE oms.oms_order_lines")) {
        throw new Error("simulated DB hiccup");
      }
      return remaining[i] ?? { rows: [] };
    });
    const client = makeShopifyClient([
      okFulfillmentOrdersResponse(),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService({ execute }, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
    expect(result.alreadyPushed).toBe(false);
    // Two failed back-write attempts (each item)
    const backWrites = captured.filter((q) =>
      q.sqlText.includes("UPDATE oms.oms_order_lines"),
    );
    expect(backWrites).toHaveLength(2);
  });
});

// ─── C22c: Location filtering (D13) ─────────────────────────────────

describe("pushShopifyFulfillment :: location filtering (D13)", () => {
  it("pushes when all FOs are assigned to OUR locations", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse([{ id: FO_GID, locationGid: OUR_LOCATION_GID }]),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");

    const fulfillment = (client.calls[1].variables as any).fulfillment;
    expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
  });

  it("returns null no-op when ALL FOs are assigned to a 3PL (ShipMonk) location", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      // No UPDATE — we early-return before persisting.
    ]);
    const client = makeShopifyClient([
      // FO assigned to ShipMonk, NOT in our locations.
      okLocationFilterResponse([{ id: FO_GID, locationGid: SHIPMONK_LOCATION_GID }]),
      // No create call expected.
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result).toEqual({ shopifyFulfillmentId: null, alreadyPushed: false });
    // Only one GQL call (the location-filter query) — no create.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("assignedLocation");
  });

  it("filters out 3PL FOs when some are ours and some are not (mixed)", async () => {
    // Two FOs split across our location + a 3PL location.
    const ourFo = "gid://shopify/FulfillmentOrder/ours";
    const threePlFo = "gid://shopify/FulfillmentOrder/3pl";
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      // Path A: item 1 -> ourFo, item 2 -> threePlFo
      {
        rows: [
          {
            shipment_item_id: 1,
            quantity: 2,
            oms_order_line_id: 8001,
            shopify_fulfillment_order_id: ourFo,
            shopify_fulfillment_order_line_item_id: "gid://shopify/FulfillmentOrderLineItem/ours-1",
          },
          {
            shipment_item_id: 2,
            quantity: 1,
            oms_order_line_id: 8002,
            shopify_fulfillment_order_id: threePlFo,
            shopify_fulfillment_order_line_item_id: "gid://shopify/FulfillmentOrderLineItem/3pl-1",
          },
        ],
      },
      ...locationConfigRows(),
      { rows: [] }, // UPDATE
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse([
        { id: ourFo, locationGid: OUR_LOCATION_GID },
        { id: threePlFo, locationGid: SHIPMONK_LOCATION_GID },
      ]),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");

    const fulfillment = (client.calls[1].variables as any).fulfillment;
    expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
    expect(fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(ourFo);
  });

  it("skips the location filter and proceeds when no warehouses or channels carry shopify_location_id", async () => {
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...emptyLocationConfigRows(),                      // ← empty config
      { rows: [] }, // UPDATE
    ]);
    const client = makeShopifyClient([
      // No location-filter query expected (skipped due to empty config).
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
    // Only the create call fires (filter skipped, Path A)
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("fulfillmentCreateV2");
  });

  it("matches numeric stored shopify_location_id against Shopify's gid form", async () => {
    // warehouses stores numeric "100100"; Shopify returns gid://shopify/Location/100100.
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      { rows: [{ shopify_location_id: OUR_LOCATION_NUMERIC }] }, // stored numeric
      { rows: [{ shopify_location_id: null }] },
      { rows: [] }, // UPDATE
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse([{ id: FO_GID, locationGid: OUR_LOCATION_GID }]),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
  });
});

// ─── Helper unit tests (exported via __test__) ──────────────────────

describe("normaliseShopifyLocationId", () => {
  it("returns the gid tail when given a Shopify gid", () => {
    expect(__test__.normaliseShopifyLocationId("gid://shopify/Location/12345")).toBe("12345");
  });
  it("returns the input verbatim when already numeric", () => {
    expect(__test__.normaliseShopifyLocationId("12345")).toBe("12345");
  });
  it("trims surrounding whitespace before extracting the tail", () => {
    expect(__test__.normaliseShopifyLocationId("  gid://shopify/Location/777  ")).toBe("777");
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

// ─── C25: Combined-orders fan-out (§6 Commit 25 + Overlord D8) ───────
//
// When a SHIP_NOTIFY fires for a shipment whose order is part of a
// combined-order group (parent + N children, set up by C14), each
// ORDER in the group needs its own Shopify fulfillment record so each
// customer sees their own order as "Shipped" — but they all share the
// SAME physical tracking number.
//
// Real-world example: Alice places orders #1234 and #1235, combined
// into one box with UPS tracking 1Z999. Both orders should show
// "Shipped" with the same UPS link.
//
// Test scaffolding notes:
//   - The triggering shipment enters via the public method. Once its
//     order row reveals `combined_group_id`, the helper fans out:
//        (a) SELECT siblings ORDER BY parent-first then id
//        (b) for each non-voided sibling, recurse via
//            `pushSingleShipmentFulfillment(siblingId, sharedTracking)`
//   - Each sibling that pushes consumes 8–11 db.execute calls of its
//     own (idempotency, shipment, order, channel.provider, items,
//     Path A read, [back-writes if Path B], warehouses, channels,
//     UPDATE shipment) plus 2 GQL calls (location filter + create) on
//     Path A or 3 GQL calls on Path B.
//   - The fan-out's narrowing step requires the SIBLINGS query to
//     return a row for the triggering shipment id.

// Group fixtures.
const PARENT_SHIPMENT_ID = SHIPMENT_ID;          // 9001
const CHILD_SHIPMENT_ID_1 = 9101;
const CHILD_SHIPMENT_ID_2 = 9102;
const PARENT_ORDER_ID = ORDER_ID;                // 4242
const CHILD_ORDER_ID_1 = 4243;
const CHILD_ORDER_ID_2 = 4244;
const COMBINED_GROUP_ID = 555;
const CHILD_SHOPIFY_ORDER_GID_1 = "gid://shopify/Order/123456790";
const CHILD_SHOPIFY_ORDER_GID_2 = "gid://shopify/Order/123456791";

/**
 * One sibling shipment row as returned by the fan-out's siblings SELECT.
 */
function siblingRow(
  shipmentId: number,
  orderId: number,
  role: "parent" | "child",
  overrides: Partial<{
    shopify_fulfillment_id: string | null;
    status: string;
  }> = {},
) {
  return {
    shipment_id: shipmentId,
    order_id: orderId,
    shopify_fulfillment_id:
      overrides.shopify_fulfillment_id !== undefined
        ? overrides.shopify_fulfillment_id
        : null,
    status: overrides.status ?? "labeled",
    combined_role: role,
  };
}

/**
 * Build the db.execute script for ONE sibling's full Path A push, given
 * its shipment id, order id, and Shopify order GID. Mirrors the solo
 * Path A sequence.
 */
function siblingPathARows(
  shipmentIdLocal: number,
  orderIdLocal: number,
  shopifyOrderGid: string,
  combinedGroupId: number | null,
  combinedRole: "parent" | "child",
  fulfillmentIdAlready: string | null = null,
) {
  return [
    { rows: [{ shopify_fulfillment_id: fulfillmentIdAlready }] }, // idempotency
    ...(fulfillmentIdAlready
      ? []
      : [
          {
            rows: [
              okShipmentRow({
                id: shipmentIdLocal,
                order_id: orderIdLocal,
              }),
            ],
          }, // shipment
          {
            rows: [
              okOrderRow({
                id: orderIdLocal,
                external_order_id: shopifyOrderGid,
                combined_group_id: combinedGroupId,
                combined_role: combinedRole,
              }),
            ],
          }, // order
          { rows: [{ provider: "shopify" }] }, // channel.provider
          { rows: okItems() }, // items
          { rows: pathAFullyPopulatedRows() }, // path A
          ...locationConfigRows(), // warehouses, channels
          { rows: [] }, // UPDATE shipment
        ]),
  ];
}

describe("pushShopifyFulfillment :: combined-orders fan-out (C25)", () => {
  it("fans out parent + 1 child: 2 fulfillments pushed, both saved", async () => {
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-1";
    const fulfillmentChild = "gid://shopify/Fulfillment/child-1";

    // Triggering shipment (parent) flow:
    //   1) idempotency SELECT (parent)
    //   2) shipment SELECT (parent)
    //   3) order SELECT (parent) → sees combined_group_id → fan out
    //   4) siblings SELECT (parent + child)
    // Then per-sibling Path A push (parent first, child second).
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },                 // 1
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },        // 2
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },                                                            // 3
      // 4. siblings
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child"),
        ],
      },
      // — sibling 1 (parent) full Path A push
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
      // — sibling 2 (child) full Path A push
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_1,
        CHILD_ORDER_ID_1,
        CHILD_SHOPIFY_ORDER_GID_1,
        COMBINED_GROUP_ID,
        "child",
      ),
    ]);
    const client = makeShopifyClient([
      // sibling 1 (parent): location filter + create
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
      // sibling 2 (child): location filter + create
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentChild),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);

    // Public return reflects the triggering (parent) shipment only.
    expect(result).toEqual({
      shopifyFulfillmentId: fulfillmentParent,
      alreadyPushed: false,
    });

    // 2 fulfillmentCreateV2 mutations issued (parent + child).
    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(2);

    // Both pushes carry the SAME tracking number (D8: shared tracking).
    for (const call of createCalls) {
      const fulfillment = (call.variables as any).fulfillment;
      expect(fulfillment.trackingInfo.number).toBe("9400110000000000000001");
      expect(fulfillment.trackingInfo.company).toBe("USPS");
    }

    // Two UPDATE wms.outbound_shipments persists, one per sibling.
    const updates = db.capturedQueries.filter((q) =>
      q.sqlText.includes("UPDATE wms.outbound_shipments"),
    );
    expect(updates).toHaveLength(2);
  });

  it("fans out when triggering shipment is the CHILD: parent + child both push", async () => {
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-2";
    const fulfillmentChild = "gid://shopify/Fulfillment/child-2";

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },                 // 1 idempotency (child)
      { rows: [okShipmentRow({ id: CHILD_SHIPMENT_ID_1 })] },       // 2 shipment
      {
        rows: [
          okOrderRow({
            id: CHILD_ORDER_ID_1,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "child",
          }),
        ],
      },                                                            // 3 order
      // 4 siblings (ORDER BY parent-first → parent comes first)
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child"),
        ],
      },
      // sibling 1 (parent)
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
      // sibling 2 (child)
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_1,
        CHILD_ORDER_ID_1,
        CHILD_SHOPIFY_ORDER_GID_1,
        COMBINED_GROUP_ID,
        "child",
      ),
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentChild),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(CHILD_SHIPMENT_ID_1);

    // Public return reflects the triggering (child) shipment only.
    expect(result).toEqual({
      shopifyFulfillmentId: fulfillmentChild,
      alreadyPushed: false,
    });

    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(2);
  });

  it("fans out a group of 3 (parent + 2 children): 3 fulfillments pushed", async () => {
    const fId = (n: number) => `gid://shopify/Fulfillment/3-grp-${n}`;

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child"),
          siblingRow(CHILD_SHIPMENT_ID_2, CHILD_ORDER_ID_2, "child"),
        ],
      },
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_1,
        CHILD_ORDER_ID_1,
        CHILD_SHOPIFY_ORDER_GID_1,
        COMBINED_GROUP_ID,
        "child",
      ),
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_2,
        CHILD_ORDER_ID_2,
        CHILD_SHOPIFY_ORDER_GID_2,
        COMBINED_GROUP_ID,
        "child",
      ),
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fId(1)),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fId(2)),
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fId(3)),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);

    expect(result.shopifyFulfillmentId).toBe(fId(1));
    expect(result.alreadyPushed).toBe(false);

    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(3);
  });

  it("sibling already has shopify_fulfillment_id → idempotently skipped, others push normally", async () => {
    const existingChildGid = "gid://shopify/Fulfillment/child-already-pushed";
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-3";

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      // siblings: child already has shopify_fulfillment_id set
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child", {
            shopify_fulfillment_id: existingChildGid,
          }),
        ],
      },
      // parent: full Path A push
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
      // child: only the idempotency SELECT fires (returns existing GID)
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_1,
        CHILD_ORDER_ID_1,
        CHILD_SHOPIFY_ORDER_GID_1,
        COMBINED_GROUP_ID,
        "child",
        existingChildGid,
      ),
    ]);
    const client = makeShopifyClient([
      // Only the parent push touches Shopify.
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);

    expect(result.shopifyFulfillmentId).toBe(fulfillmentParent);
    expect(result.alreadyPushed).toBe(false);

    // Only ONE fulfillmentCreateV2 call (parent) — the already-pushed
    // child sibling skipped Shopify entirely via D1 idempotency.
    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(1);
  });

  it("voided sibling → skipped without contacting Shopify; non-voided still push", async () => {
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-voided-test";

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      // siblings: child is voided
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child", {
            status: "voided",
          }),
        ],
      },
      // parent push only — voided child consumes ZERO db calls
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);

    expect(result.shopifyFulfillmentId).toBe(fulfillmentParent);

    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(1);
  });

  it("cancelled sibling → also skipped without contacting Shopify", async () => {
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-cancelled-test";

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child", {
            status: "cancelled",
          }),
        ],
      },
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
    ]);
    const client = makeShopifyClient([
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe(fulfillmentParent);

    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(1);
  });

  it("all siblings already pushed → every sibling skips, no Shopify calls", async () => {
    const triggeringExisting = "gid://shopify/Fulfillment/triggering-already";
    const childExisting = "gid://shopify/Fulfillment/child-already";

    // Triggering shipment's idempotency hits FIRST and short-circuits the
    // public method before any fan-out can happen — that's the existing
    // D1 contract for solo orders, and it carries through unchanged for
    // combined orders. The public return is the triggering shipment's
    // existing GID with alreadyPushed:true.
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: triggeringExisting }] }, // idempotency → short-circuit
    ]);
    void childExisting;
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);
    expect(result).toEqual({
      shopifyFulfillmentId: triggeringExisting,
      alreadyPushed: true,
    });
    expect(client.calls).toHaveLength(0);
  });

  it("sibling errors mid-fan-out → others still attempt; triggering still returns success", async () => {
    const fulfillmentParent = "gid://shopify/Fulfillment/parent-partial-success";

    // Parent (triggering) succeeds; child errors at the create call.
    // Per failure semantics: triggering's success is recorded and
    // returned to the caller; the failed child sibling is captured
    // internally and will be retried independently via DLQ on its own
    // shipment id (C22d).
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child"),
        ],
      },
      // parent: full success
      ...siblingPathARows(
        PARENT_SHIPMENT_ID,
        PARENT_ORDER_ID,
        SHOPIFY_ORDER_GID,
        COMBINED_GROUP_ID,
        "parent",
      ),
      // child: full sequence up to mutation, but mutation will throw via
      // the GQL client. UPDATE shipment never fires for the child.
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: CHILD_SHIPMENT_ID_1, order_id: CHILD_ORDER_ID_1 })] },
      {
        rows: [
          okOrderRow({
            id: CHILD_ORDER_ID_1,
            external_order_id: CHILD_SHOPIFY_ORDER_GID_1,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "child",
          }),
        ],
      },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      // child UPDATE shipment never fires (mutation throws before it).
    ]);
    const client = makeShopifyClient([
      // parent
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentParent),
      // child: location filter ok, then create throws
      okLocationFilterResponse(),
      new Error("ECONNRESET"),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);

    // Triggering (parent) succeeded → caller sees parent's outcome.
    expect(result).toEqual({
      shopifyFulfillmentId: fulfillmentParent,
      alreadyPushed: false,
    });

    // Both fulfillmentCreateV2 attempts were made; child failed but
    // parent still succeeded. UPDATE wms.outbound_shipments fired only
    // for the parent.
    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(2);
    const updates = db.capturedQueries.filter((q) =>
      q.sqlText.includes("UPDATE wms.outbound_shipments"),
    );
    expect(updates).toHaveLength(1);
  });

  it("triggering sibling itself errors → public method re-throws structured error", async () => {
    // Parent (triggering) errors at the create call; child succeeds.
    // Public method re-throws the parent's error so the caller's
    // retry/DLQ logic sees the same shape it would for a solo push.
    const fulfillmentChild = "gid://shopify/Fulfillment/child-only";

    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      {
        rows: [
          siblingRow(PARENT_SHIPMENT_ID, PARENT_ORDER_ID, "parent"),
          siblingRow(CHILD_SHIPMENT_ID_1, CHILD_ORDER_ID_1, "child"),
        ],
      },
      // parent: full sequence up to (failing) mutation
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow({ id: PARENT_SHIPMENT_ID })] },
      {
        rows: [
          okOrderRow({
            id: PARENT_ORDER_ID,
            combined_group_id: COMBINED_GROUP_ID,
            combined_role: "parent",
          }),
        ],
      },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      // parent UPDATE never fires.
      // child: full success Path A
      ...siblingPathARows(
        CHILD_SHIPMENT_ID_1,
        CHILD_ORDER_ID_1,
        CHILD_SHOPIFY_ORDER_GID_1,
        COMBINED_GROUP_ID,
        "child",
      ),
    ]);
    const client = makeShopifyClient([
      // parent: location filter ok, then create errors
      okLocationFilterResponse(),
      new Error("ECONNRESET"),
      // child: success
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(fulfillmentChild),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    let err: ShopifyFulfillmentPushError | undefined;
    try {
      await svc.pushShopifyFulfillment(PARENT_SHIPMENT_ID);
    } catch (e) {
      err = e as ShopifyFulfillmentPushError;
    }
    expect(err).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(err?.context.code).toBe(SHOPIFY_PUSH_NETWORK_ERROR);
    expect(err?.context.shipmentId).toBe(PARENT_SHIPMENT_ID);

    // Child still attempted + succeeded — partial fan-out semantics hold.
    const createCalls = client.calls.filter((c) =>
      c.query.includes("fulfillmentCreateV2"),
    );
    expect(createCalls).toHaveLength(2);
  });

  it("solo order (combined_group_id = null) behaves exactly like before", async () => {
    // Regression: an order with combined_group_id null on its row must
    // not trigger fan-out. This is the same fixture used by the C22c
    // happy-path tests, just asserted in a C25-named block to make the
    // intent obvious.
    const db = makeDb([
      { rows: [{ shopify_fulfillment_id: null }] },
      { rows: [okShipmentRow()] },
      // combined_group_id NOT set on the order row → solo path
      { rows: [okOrderRow()] },
      { rows: [{ provider: "shopify" }] },
      { rows: okItems() },
      { rows: pathAFullyPopulatedRows() },
      ...locationConfigRows(),
      { rows: [] },
    ]);
    const client = makeShopifyClient([
      // Exactly 2 GQL calls: location filter + create. No siblings query
      // and no fan-out.
      okLocationFilterResponse(),
      okFulfillmentCreateV2Response(),
    ]);
    const svc = createFulfillmentPushService(db.db, null);
    svc.setShopifyClient(client);

    const result = await svc.pushShopifyFulfillment(SHIPMENT_ID);
    expect(result.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/55555");
    expect(client.calls).toHaveLength(2);

    // No siblings SELECT was issued.
    const siblingsQueries = db.capturedQueries.filter((q) =>
      q.sqlText.includes("o.combined_group_id"),
    );
    expect(siblingsQueries).toHaveLength(0);
  });
});
