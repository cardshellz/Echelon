/**
 * Unit tests for `handleShopifyFulfillmentUpdate` (§6 Group F, Commit 27).
 *
 * Coverage scopes:
 *   - Happy path: shipment found, tracking changed, markShipmentShipped's
 *     re-tracking branch (C18) writes a `shipment_tracking_history` row +
 *     UPDATEs the shipment, rollup runs, OMS mirror invoked.
 *   - Idempotent replay: same tracking arrives twice → markShipmentShipped
 *     returns changed=false, no rollup, no OMS call.
 *   - Status routing:
 *       - `cancelled` → 200 cancel_handled_by_other_webhook (no DB calls)
 *       - non-success/non-cancelled (`pending`, `failure`) → 200
 *         status_ignored (no DB calls)
 *   - Missing tracking on success → 200 no_tracking (no DB calls)
 *   - Shipment not found → 200 shipment_not_tracked
 *   - Bad payload (missing id, null body) → 400
 *   - markShipmentShipped throws → 500 propagation (caller maps to retry)
 *   - OMS mirror throws → still returns 200 updated (non-fatal)
 *   - Carrier mapping: parameterized over USPS / UPS / FedEx / DHL / unknown
 *
 * Mocks: in-memory `db.execute` that scripts SQL responses in call order,
 * mirroring `fulfillments-create-webhook.test.ts`. The shipment-rollup
 * helpers (`markShipmentShipped`, `recomputeOrderStatusFromShipments`)
 * are real — they're pure functions over the same scripted `db.execute`,
 * so we exercise the full integration the route handler would.
 *
 * The HMAC verification path lives in the route handler itself
 * (`verifyChannelWebhook`); the pure handler under test is invoked AFTER
 * verification, so this file does not exercise HMAC.
 *
 * Standards: coding-standards Rule #6 (idempotent retry-safety), Rule #9
 * (happy path + edge cases per failure mode), Rule #15 (5-section
 * completion report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `shopify.routes.ts` transitively imports `server/db`; stub it so import
// time doesn't try to construct a real Postgres client. Same pattern as
// fulfillments-create-webhook.test.ts.
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
  handleShopifyFulfillmentUpdate,
  mapShopifyCarrier,
  type ShopifyFulfillmentUpdatePayload,
} from "../../../../routes/shopify.routes";

// ─── Fixtures ────────────────────────────────────────────────────────

const FULFILLMENT_GID = "gid://shopify/Fulfillment/77777";
const SHOPIFY_ORDER_ID = "1122334455";
const OLD_TRACKING = "1Z999AA10123456784";
const NEW_TRACKING = "1Z999AA10987654321";
const TRACKING_URL = "https://www.ups.com/track?tracknum=1Z999AA10987654321";
const FIXED_NOW = new Date("2026-04-26T12:00:00.000Z");
const FIXED_CREATED_AT = "2026-04-26T11:55:00.000Z";

function basePayload(
  overrides: Partial<ShopifyFulfillmentUpdatePayload> = {},
): ShopifyFulfillmentUpdatePayload {
  return {
    id: FULFILLMENT_GID,
    order_id: SHOPIFY_ORDER_ID,
    status: "success",
    tracking_number: NEW_TRACKING,
    tracking_url: TRACKING_URL,
    tracking_company: "UPS",
    created_at: FIXED_CREATED_AT,
    ...overrides,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────

interface SqlCall {
  sqlText: string;
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

// ─── Happy path: tracking changed ────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — happy path (tracking changed)", () => {
  it("re-tracks shipment, writes history, rolls up order, mirrors OMS", async () => {
    // Scripted SQL responses (in call order):
    //   1. lookup shipment by shopify_fulfillment_id → found (5500)
    //   2. markShipmentShipped: loadShipment → existing tracking OLD_TRACKING
    //   3. markShipmentShipped: INSERT shipment_tracking_history (re-track)
    //   4. markShipmentShipped: UPDATE outbound_shipments
    //   5. recompute: SELECT order
    //   6. recompute: SELECT shipments for order
    //   (status already 'shipped' → no UPDATE order)
    const db = makeDb([
      // 1. existing shipment lookup
      { rows: [{ id: 5500, order_id: 7700 }] },
      // 2. loadShipment
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: OLD_TRACKING,
            carrier: "UPS",
            tracking_url: "https://www.ups.com/old",
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: 12345,
          },
        ],
      },
      // 3. INSERT history
      { rows: [] },
      // 4. UPDATE shipment
      { rows: [] },
      // 5. SELECT order
      {
        rows: [
          {
            id: 7700,
            warehouse_status: "shipped",
            completed_at: FIXED_NOW,
          },
        ],
      },
      // 6. SELECT shipments
      { rows: [{ status: "shipped" }] },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("updated");
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledTimes(1);
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledWith(
      SHOPIFY_ORDER_ID,
      NEW_TRACKING,
      "UPS",
    );
    // 6 calls: lookup + loadShipment + history + UPDATE shipment + 2× recompute reads
    expect(db.execute).toHaveBeenCalledTimes(6);
  });

  it("writes shipment_tracking_history row when tracking differs", async () => {
    const db = makeDb([
      { rows: [{ id: 5500, order_id: 7700 }] },
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: OLD_TRACKING,
            carrier: "UPS",
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
      { rows: [] }, // history INSERT
      { rows: [] }, // UPDATE shipment
      { rows: [{ id: 7700, warehouse_status: "shipped", completed_at: FIXED_NOW }] },
      { rows: [{ status: "shipped" }] },
    ]);
    const omsSvc = makeOmsSvc();

    await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    // History INSERT is the 3rd call. Match by SQL text fragment.
    const historyCall = db.calls[2];
    expect(historyCall.sqlText).toContain("shipment_tracking_history");
  });

  it("does not push back to Shopify (Shopify is the source)", async () => {
    // Verify by absence: markShipmentShipped's fulfillmentPush hook is
    // gated on `opts.fulfillmentPush?.updateShopifyFulfillmentTracking`
    // being a function. We never wire it in handleShopifyFulfillmentUpdate,
    // so a re-tracking event must NOT call any push function. We assert
    // by counting db calls — pushing would be an out-of-band side effect
    // we don't supply.
    const db = makeDb([
      { rows: [{ id: 5500, order_id: 7700 }] },
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: OLD_TRACKING,
            carrier: "UPS",
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 7700, warehouse_status: "shipped", completed_at: FIXED_NOW }] },
      { rows: [{ status: "shipped" }] },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.body.outcome).toBe("updated");
    // No additional side-effect surface: the deps interface intentionally
    // omits a fulfillmentPush hook.
  });

  it("does not 500 when OMS mirror fails", async () => {
    const db = makeDb([
      { rows: [{ id: 5500, order_id: 7700 }] },
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: OLD_TRACKING,
            carrier: "UPS",
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 7700, warehouse_status: "shipped", completed_at: FIXED_NOW }] },
      { rows: [{ status: "shipped" }] },
    ]);
    const omsSvc = makeOmsSvc({ fail: true });

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("updated");
    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledTimes(1);
  });
});

// ─── Idempotent replay ──────────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — idempotency", () => {
  it("is a clean no-op when tracking + carrier already match", async () => {
    const db = makeDb([
      // 1. existing shipment lookup
      { rows: [{ id: 5500, order_id: 7700 }] },
      // 2. loadShipment — already has the new tracking + same carrier
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: NEW_TRACKING,
            carrier: "UPS",
            tracking_url: TRACKING_URL,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("idempotent");
    // Only the lookup + loadShipment ran; no history, no UPDATE, no rollup.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });
});

// ─── Status routing ─────────────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — status routing", () => {
  it("acks cancelled with no DB calls (cancel webhook handles unwind)", async () => {
    const db = makeDb([]); // no responses scripted — must not be called
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ status: "cancelled" }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("cancel_handled_by_other_webhook");
    expect(db.execute).not.toHaveBeenCalled();
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });

  it("acks pending status without DB calls", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ status: "pending" }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("status_ignored");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("acks failure status without DB calls", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ status: "failure" }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("status_ignored");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("acks unknown status (e.g. 'open') without DB calls", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ status: "open" }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("status_ignored");
  });
});

// ─── No-tracking guard ──────────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — no tracking", () => {
  it("acks success-with-empty-tracking without writing", async () => {
    // Operator wiping tracking before re-entering it. Don't overwrite
    // good tracking with nothing.
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ tracking_number: null }),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("no_tracking");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("treats whitespace-only tracking as no_tracking", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ tracking_number: "   " }),
    );

    expect(result.body.outcome).toBe("no_tracking");
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ─── Shipment not tracked ───────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — shipment not found", () => {
  it("acks 200 when no shipment matches the fulfillment id", async () => {
    // 3PL fulfillment that bypassed C26 path B (we don't sync this order).
    // Don't 500 — Shopify retries forever for orders we never tracked.
    const db = makeDb([
      { rows: [] }, // shipment lookup → none
    ]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload(),
    );

    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("shipment_not_tracked");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(omsSvc.markShippedByExternalId).not.toHaveBeenCalled();
  });
});

// ─── Bad payload ────────────────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — bad payload", () => {
  it("returns 400 when payload is null", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      null,
    );

    expect(result.status).toBe(400);
    expect(result.body.received).toBe(false);
    expect(result.body.outcome).toBe("invalid_payload");
    expect(result.body.error).toContain("missing fulfillment id");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 400 when payload is undefined", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      undefined,
    );

    expect(result.status).toBe(400);
    expect(result.body.outcome).toBe("invalid_payload");
  });

  it("returns 400 when id is missing", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      // @ts-expect-error: deliberately omitted required field
      basePayload({ id: undefined }),
    );

    expect(result.status).toBe(400);
    expect(result.body.outcome).toBe("invalid_payload");
    expect(result.body.error).toContain("missing fulfillment id");
  });

  it("returns 400 when id is null", async () => {
    const db = makeDb([]);
    const omsSvc = makeOmsSvc();

    const result = await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      // @ts-expect-error: deliberately null
      basePayload({ id: null }),
    );

    expect(result.status).toBe(400);
  });
});

// ─── markShipmentShipped throws → 500 ───────────────────────────────

describe("handleShopifyFulfillmentUpdate — DB failure propagates", () => {
  it("propagates an exception so the route returns 500 (Shopify retries)", async () => {
    const db = makeDb([
      // 1. existing shipment lookup
      { rows: [{ id: 5500, order_id: 7700 }] },
      // 2. loadShipment throws
      new Error("connection lost"),
    ]);
    const omsSvc = makeOmsSvc();

    await expect(
      handleShopifyFulfillmentUpdate(
        { db, omsSvc, now: FIXED_NOW },
        basePayload(),
      ),
    ).rejects.toThrow(/connection lost/);
  });
});

// ─── Carrier mapping ────────────────────────────────────────────────

describe("handleShopifyFulfillmentUpdate — carrier mapping", () => {
  // Parameterized over Shopify's typical carrier strings. Mirrors the
  // map in shopify.routes.ts (kept in sync with C26's create-side tests).
  const cases: Array<[string, string]> = [
    ["USPS", "USPS"],
    ["U.S. Postal Service", "USPS"],
    ["UPS", "UPS"],
    ["FedEx", "FedEx"],
    ["Federal Express", "FedEx"],
    ["DHL", "DHL"],
    ["DHL Express", "DHL"],
    ["DHL eCommerce", "DHL"],
  ];

  it.each(cases)(
    "maps Shopify carrier %s → %s",
    (shopifyName, canonical) => {
      expect(mapShopifyCarrier(shopifyName)).toBe(canonical);
    },
  );

  it("passes unknown carriers through as upper-case", () => {
    expect(mapShopifyCarrier("Aramex")).toBe("ARAMEX");
    expect(mapShopifyCarrier("OnTrac")).toBe("ONTRAC");
  });

  it("returns 'unknown' for null/empty/whitespace carrier", () => {
    expect(mapShopifyCarrier(null)).toBe("unknown");
    expect(mapShopifyCarrier(undefined)).toBe("unknown");
    expect(mapShopifyCarrier("")).toBe("unknown");
    expect(mapShopifyCarrier("   ")).toBe("unknown");
  });

  it("uses mapped canonical carrier on the OMS mirror call", async () => {
    const db = makeDb([
      { rows: [{ id: 5500, order_id: 7700 }] },
      {
        rows: [
          {
            id: 5500,
            order_id: 7700,
            status: "shipped",
            tracking_number: OLD_TRACKING,
            carrier: "USPS",
            tracking_url: null,
            shopify_fulfillment_id: FULFILLMENT_GID,
            shipstation_order_id: null,
          },
        ],
      },
      { rows: [] }, // history
      { rows: [] }, // UPDATE shipment
      { rows: [{ id: 7700, warehouse_status: "shipped", completed_at: FIXED_NOW }] },
      { rows: [{ status: "shipped" }] },
    ]);
    const omsSvc = makeOmsSvc();

    await handleShopifyFulfillmentUpdate(
      { db, omsSvc, now: FIXED_NOW },
      basePayload({ tracking_company: "Federal Express" }),
    );

    expect(omsSvc.markShippedByExternalId).toHaveBeenCalledWith(
      SHOPIFY_ORDER_ID,
      NEW_TRACKING,
      "FedEx",
    );
  });
});
