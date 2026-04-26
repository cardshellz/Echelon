/**
 * Unit tests for `handleShopifyFulfillmentCreate` (§6 Group F, Commit 26).
 *
 * Coverage scopes:
 *   - Path A (existing shipment, our roundtrip): a fulfillment we pushed
 *     via C22d returns through the webhook. WMS shipment found by
 *     `shopify_fulfillment_id`; `markShipmentShipped` fires; rollup runs;
 *     OMS mirror invoked.
 *   - Path A idempotency: a duplicate webhook for an already-shipped
 *     shipment with identical tracking is a clean no-op (no rollup write,
 *     no OMS call).
 *   - Path B (external 3PL fulfillment, WMS order exists): no shipment
 *     row found, but the WMS order resolves via `oms_fulfillment_order_id`
 *     → INSERT a new shipment row directly in `shipped` state with
 *     `source='shopify_external_fulfillment'` and run the rollup.
 *   - Path B no-tracking: external fulfillment without a tracking number
 *     still creates the shipment row (so order can roll up) — tracking is
 *     stored as null.
 *   - Order-not-tracked: webhook for an order Echelon never synced. Logs +
 *     returns 200 (don't 500 over orders we don't track).
 *   - Bad payload: missing `id` → 400. Missing `order_id` → 400.
 *   - Non-success status: `cancelled` / `failure` returns 200 without
 *     doing any DB work.
 *   - Carrier mapping: `mapShopifyCarrier` translates known carriers and
 *     passes unknown ones through verbatim (UPPER-cased).
 *
 * Mocks: in-memory `db.execute` that scripts SQL responses in call order,
 * mirroring the pattern used by `push-shopify-fulfillment.test.ts` and
 * `ship-notify-v2.test.ts`. The shipment-rollup helpers
 * (`markShipmentShipped`, `recomputeOrderStatusFromShipments`) are real
 * — they're pure functions over the same scripted `db.execute`, so we
 * exercise the full integration the route handler would.
 *
 * The HMAC verification path lives in the route handler itself
 * (`verifyChannelWebhook`); the pure handler under test is invoked AFTER
 * verification so a verification bypass would surface as a route-level
 * regression rather than a handler-level bug. This is verified by the
 * "smoke" test: the handler does not consult HMAC headers.
 *
 * Standards: coding-standards Rule #6 (idempotent retry-safety), Rule #9
 * (happy path + edge cases per failure mode), Rule #15 (5-section
 * completion report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `shopify.routes.ts` transitively imports `server/db` (via storage
// modules) and would otherwise try to construct a real Postgres client
// at import time and fail on missing DATABASE_URL. The pure handler
// under test never reads from the default db — callers inject their own
// `db` — so a no-op stand-in is sufficient. Same pattern as
// `ship-notify-retry.test.ts`.
vi.mock("../../../../db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  },
}));

import {
  handleShopifyFulfillmentCreate,
  mapShopifyCarrier,
  type ShopifyFulfillmentCreatePayload,
} from "../../../../routes/shopify.routes";

// ─── Fixtures ────────────────────────────────────────────────────────

const FULFILLMENT_GID = "gid://shopify/Fulfillment/55555";
const SHOPIFY_ORDER_ID = "9988776655";
const TRACKING_NUMBER = "1Z999AA10123456784";
const TRACKING_URL = "https://www.ups.com/track?tracknum=1Z999AA10123456784";
const FIXED_NOW = new Date("2026-04-26T11:00:00.000Z");
const FIXED_CREATED_AT = "2026-04-26T10:55:00.000Z";

function basePayload(
  overrides: Partial<ShopifyFulfillmentCreatePayload> = {},
): ShopifyFulfillmentCreatePayload {
  return {
    id: FULFILLMENT_GID,
    order_id: SHOPIFY_ORDER_ID,
    status: "success",
    tracking_number: TRACKING_NUMBER,
    tracking_url: TRACKING_URL,
    tracking_company: "UPS",
    created_at: FIXED_CREATED_AT,
    line_items: [{ sku: "SKU-1", quantity: 2 }],
    ...overrides,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────

interface SqlCall {
  sqlText: string;
  // Capture so assertions can read the parameter list. Drizzle's `sql`
  // template builder exposes .queryChunks; for testing we just join the
  // strings to reconstruct a roughly-readable representation.
  raw: any;
}

interface ScriptedDb {
  execute: ReturnType<typeof vi.fn>;
  calls: SqlCall[];
}

function makeDb(responses: Array<unknown | (() => unknown)>): ScriptedDb {
  const calls: SqlCall[] = [];
  const remaining = [...responses];
  const execute = vi.fn(async (query: any) => {
    // Drizzle's `sql` template tag produces an object with .queryChunks
    // and .values; reconstruct enough text to inspect in assertions.
    const chunks: any[] = query?.queryChunks ?? query?.chunks ?? [];
    const sqlText = chunks
      .map((c: any) =>
        typeof c?.value?.[0] === "string"
          ? c.value[0]
          : typeof c?.sql === "string"
            ? c.sql
            : "",
      )
      .join(" ");
    calls.push({ sqlText, raw: query });
    if (remaining.length === 0) {
      throw new Error(
        `ScriptedDb: no scripted response remaining for SQL: ${sqlText}`,
      );
    }
    const next = remaining.shift();
    const value = typeof next === "function" ? (next as () => unknown)() : next;
    if (value instanceof Error) throw value;
    return value as any;
  });
  return { execute, calls };
}

interface OmsSpy {
  markShippedByExternalId: ReturnType<typeof vi.fn>;
}

function makeOmsSvc(opts: { fail?: boolean } = {}): OmsSpy {
  return {
    markShippedByExternalId: vi.fn(async () => {
      if (opts.fail) throw new Error("oms boom");
      return { id: 1 };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Path A: existing shipment, our roundtrip ───────────────────────

describe("handleShopifyFulfillmentCreate — path A (existing shipment)", () => {
  it("marks shipment shipped, rolls up order, mirrors OMS", async () => {
    // Scripted SQL responses (in call order):
    //   1. lookup shipment by shopify_fulfillment_id → found (shipment 5000)
    //   2. markShipmentShipped: load shipment row
    //   3. markShipmentShipped: UPDATE wms.outbound_shipments
    //   4. recomputeOrderStatusFromShipments: SELECT wms.orders
    //   5. recomputeOrderStatusFromShipments: SELECT shipments for order
    //   6. recomputeOrderStatusFromShipments: UPDATE wms.orders (transition to shipped + completed_at)
    const db = makeDb([
      // 1. existing shipment lookup
      { rows: [{ id: 5000, order_id: 7000 }] },
      // 2. markShipmentShipped loadShipment
      {
        rows: [
          {
            id: 5000,
            order_id: 7000,
            status: "labeled",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: 12345,
          },
        ],
      },
      // 3. UPDATE shipment
      { rows: [] },
      // 4. SELECT order
      {
        rows: [
          {
            id: 7000,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      // 5. SELECT shipments for order
      { rows: [{ status: "shipped" }] },
      // 6. UPDATE order
      { rows: [] },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("shipment_updated");
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledTimes(1);
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledWith(
      SHOPIFY_ORDER_ID,
      TRACKING_NUMBER,
      "UPS",
    );
    // 6 db calls: 1 lookup + 2 markShipmentShipped + 3 recompute
    expect(db.execute).toHaveBeenCalledTimes(6);
  });

  it("is a clean no-op on idempotent replay (already shipped, same tracking)", async () => {
    const db = makeDb([
      // 1. existing shipment lookup
      { rows: [{ id: 5000, order_id: 7000 }] },
      // 2. markShipmentShipped loadShipment — already shipped same tracking
      {
        rows: [
          {
            id: 5000,
            order_id: 7000,
            status: "shipped",
            tracking_number: TRACKING_NUMBER,
            carrier: "UPS",
            tracking_url: TRACKING_URL,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: 12345,
          },
        ],
      },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("shipment_idempotent");
    // No UPDATE, no rollup, no OMS call — just lookup + loadShipment.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });

  it("skips mark-shipped when tracking_number is missing", async () => {
    // Existing shipment, but webhook arrived with no tracking. Don't
    // fabricate a placeholder — log + idempotent ack.
    const db = makeDb([
      { rows: [{ id: 5000, order_id: 7000 }] },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ tracking_number: null }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("shipment_idempotent");
    // Only the lookup ran; mark-shipped was skipped.
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });

  it("does not 500 when OMS mirror fails", async () => {
    // OMS failure is non-fatal (WMS is the source of truth here).
    const db = makeDb([
      { rows: [{ id: 5000, order_id: 7000 }] },
      {
        rows: [
          {
            id: 5000,
            order_id: 7000,
            status: "labeled",
            tracking_number: null,
            carrier: null,
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
      { rows: [] }, // UPDATE shipment
      { rows: [{ id: 7000, warehouse_status: "ready_to_ship", completed_at: null }] },
      { rows: [{ status: "shipped" }] },
      { rows: [] }, // UPDATE order
    ]);
    const omsSvc = makeOmsSvc({ fail: true });

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("shipment_updated");
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledTimes(1);
  });
});

// ─── Path B: external fulfillment (3PL), WMS order exists ───────────

describe("handleShopifyFulfillmentCreate — path B (external fulfillment)", () => {
  it("creates a new shipment row in shipped state and rolls up", async () => {
    // Scripted responses:
    //   1. lookup shipment by shopify_fulfillment_id → none
    //   2. lookup wms.orders by oms_fulfillment_order_id → found
    //   3. INSERT new wms.outbound_shipments row
    //   4. recomputeOrderStatusFromShipments: SELECT order
    //   5. recomputeOrderStatusFromShipments: SELECT shipments
    //   6. recomputeOrderStatusFromShipments: UPDATE order
    const db = makeDb([
      { rows: [] }, // 1
      { rows: [{ id: 8000, channel_id: 36 }] }, // 2
      { rows: [] }, // 3 INSERT
      { rows: [{ id: 8000, warehouse_status: "ready_to_ship", completed_at: null }] }, // 4
      { rows: [{ status: "shipped" }] }, // 5
      { rows: [] }, // 6
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("external_shipment_created");
    expect(db.execute).toHaveBeenCalledTimes(6);

    // Inspect the INSERT to confirm source + status. Drizzle's `sql`
    // template stitches the literal text together; we just need to
    // confirm the marker fragments are present.
    const insertCall = db.calls[2];
    expect(insertCall.sqlText).toContain("INSERT INTO wms.outbound_shipments");
    expect(insertCall.sqlText).toContain("'shipped'");
    expect(insertCall.sqlText).toContain("'shopify_external_fulfillment'");

    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledWith(
      SHOPIFY_ORDER_ID,
      TRACKING_NUMBER,
      "UPS",
    );
  });

  it("creates external shipment even when tracking_number is missing", async () => {
    // External fulfillment without tracking is rare but legal (Shopify
    // test webhooks, manual fulfillments without label). Order still
    // needs to roll up to shipped, so the row is still created with
    // tracking_number=NULL.
    const db = makeDb([
      { rows: [] }, // shipment lookup miss
      { rows: [{ id: 8000, channel_id: 36 }] }, // wms.orders lookup
      { rows: [] }, // INSERT
      { rows: [{ id: 8000, warehouse_status: "ready_to_ship", completed_at: null }] },
      { rows: [{ status: "shipped" }] },
      { rows: [] },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ tracking_number: null, tracking_company: null }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("external_shipment_created");
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledWith(
      SHOPIFY_ORDER_ID,
      "",
      "unknown",
    );
  });
});

// ─── Order not tracked ───────────────────────────────────────────────

describe("handleShopifyFulfillmentCreate — order not tracked", () => {
  it("returns 200 (not 500) when no WMS order matches", async () => {
    const db = makeDb([
      { rows: [] }, // shipment lookup miss
      { rows: [] }, // wms.orders lookup miss
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("order_not_tracked");
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });
});

// ─── Bad payloads ────────────────────────────────────────────────────

describe("handleShopifyFulfillmentCreate — payload validation", () => {
  it("returns 400 on missing id", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      { ...basePayload(), id: undefined as any },
    );

    expect(result.status).toBe(400);
    expect(result.body.outcome).toBe("non_actionable_status");
    expect(result.body.error).toMatch(/id/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 400 on missing order_id", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      { ...basePayload(), order_id: undefined as any },
    );

    expect(result.status).toBe(400);
    expect(result.body.outcome).toBe("non_actionable_status");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 400 on null payload", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      null as any,
    );

    expect(result.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ─── Non-actionable status ──────────────────────────────────────────

describe("handleShopifyFulfillmentCreate — non-success status", () => {
  it.each([
    ["cancelled"],
    ["failure"],
    ["pending"],
    ["open"],
    ["error"],
  ])("returns 200 without DB work on status=%s", async (status) => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentCreate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ status }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("non_actionable_status");
    expect(db.execute).not.toHaveBeenCalled();
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });
});

// ─── Carrier mapping ─────────────────────────────────────────────────

describe("mapShopifyCarrier", () => {
  it.each([
    ["USPS", "USPS"],
    ["usps", "USPS"],
    ["U.S. Postal Service", "USPS"],
    ["UPS", "UPS"],
    ["ups", "UPS"],
    ["FedEx", "FedEx"],
    ["fedex", "FedEx"],
    ["Federal Express", "FedEx"],
    ["DHL", "DHL"],
    ["DHL Express", "DHL"],
    ["DHL eCommerce", "DHL"],
  ])("maps %s → %s", (input, expected) => {
    expect(mapShopifyCarrier(input)).toBe(expected);
  });

  it("passes unknown carriers through verbatim (UPPER-cased)", () => {
    expect(mapShopifyCarrier("Canada Post")).toBe("CANADA POST");
    expect(mapShopifyCarrier("OnTrac")).toBe("ONTRAC");
  });

  it("returns 'unknown' for null/empty input", () => {
    expect(mapShopifyCarrier(null)).toBe("unknown");
    expect(mapShopifyCarrier(undefined)).toBe("unknown");
    expect(mapShopifyCarrier("")).toBe("unknown");
    expect(mapShopifyCarrier("   ")).toBe("unknown");
  });
});

// ─── HMAC bypass smoke ───────────────────────────────────────────────

describe("handleShopifyFulfillmentCreate — HMAC isolation", () => {
  it("does not consult any HMAC headers (route-level concern)", async () => {
    // The pure handler intentionally takes only deps + payload, never
    // the request. Route-level HMAC is enforced by `verifyChannelWebhook`
    // BEFORE this handler runs. This test asserts the API surface so a
    // future regression that adds request-level concerns to the handler
    // surfaces as a test failure.
    expect(handleShopifyFulfillmentCreate.length).toBe(2);
  });
});
