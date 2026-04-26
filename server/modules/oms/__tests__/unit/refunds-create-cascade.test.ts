/**
 * Unit tests for `applyShopifyRefundCascade` (§6 Group F, Commit 29).
 *
 * The cascade is the WMS portion of the Shopify `refunds/create`
 * webhook handler. It:
 *   - Validates the refund payload shape
 *   - Resolves the OMS order (caller-injected helper)
 *   - Resolves the WMS order via `wms.orders` lookup
 *   - Resolves the most-recent shipment (id DESC LIMIT 1)
 *   - Idempotency-checks via `refund_external_id` + `order_id`
 *   - Inserts a `wms.returns` row with `restocked` reflecting whether
 *     any refund line was flagged for restock
 *   - Optionally invokes a restock helper if any line was flagged
 *
 * The route handler itself (HMAC, OMS update, event log) is exercised
 * via integration; this file scopes to the cascade logic only.
 *
 * Standards: coding-standards Rule #6 (idempotent retry-safety),
 * Rule #9 (happy + edge cases), Rule #15 (5-section completion report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `oms-webhooks.ts` transitively imports `server/db`; stub it so import
// time doesn't try to construct a real Postgres client. Same pattern as
// orders-cancelled-cascade / fulfillments-create-webhook.
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

// Pull in helpers after the db mock is registered.
import { __test__ } from "../../oms-webhooks";

const { applyShopifyRefundCascade, RefundsCreateBadPayloadError } = __test__;

// ─── Scripted db.execute mock ────────────────────────────────────────

type ScriptedResponse = { rows: any[] };

function makeDb(scripted: ScriptedResponse[]) {
  const calls: any[] = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (query: any) => {
    calls.push(query);
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });
  return {
    db: { execute } as any,
    execute,
    calls,
    remaining,
  };
}

const NOW = new Date("2026-04-26T12:00:00Z");

const baseRefund = (overrides: Record<string, any> = {}) => ({
  id: 9988776655,
  order_id: 1234567890,
  note: "customer changed mind",
  processed_at: "2026-04-26T11:55:00Z",
  refund_line_items: [],
  ...overrides,
});

const buildResolveOmsOrder = (id: number | null) =>
  vi.fn(async (_db: any, _args: any) => (id === null ? null : { id }));

describe("applyShopifyRefundCascade (C29)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: refund with no restocks → wms.returns row inserted with restocked=false", async () => {
    const mock = makeDb([
      // 1) WMS order lookup
      { rows: [{ id: 42 }] },
      // 2) Idempotency check (no existing row)
      { rows: [] },
      // 3) Most-recent shipment
      { rows: [{ id: 7001 }] },
      // 4) INSERT wms.returns
      { rows: [] },
    ]);

    const restock = vi.fn();
    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [
          { line_item_id: 1, quantity: 1, restock: false },
          { line_item_id: 2, quantity: 2, restock: false },
        ],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("return_recorded");
    expect(result.refundExternalId).toBe("9988776655");
    expect(result.omsOrderId).toBe(99);
    expect(result.wmsOrderId).toBe(42);
    expect(result.shipmentId).toBe(7001);
    expect(result.restocked).toBe(false);
    expect(result.restockInvoked).toBe(false);
    expect(restock).not.toHaveBeenCalled();
    // 4 db.execute calls
    expect(mock.execute).toHaveBeenCalledTimes(4);
  });

  it("refund with restock_type='return' line → restocked=true, restock helper invoked", async () => {
    const mock = makeDb([
      { rows: [{ id: 42 }] }, // WMS order
      { rows: [] }, // idempotency
      { rows: [{ id: 7002 }] }, // most-recent shipment
      { rows: [] }, // INSERT
    ]);

    const restock = vi.fn(async () => undefined);
    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [
          { line_item_id: 1, quantity: 1, restock_type: "return" },
          { line_item_id: 2, quantity: 1, restock: false },
        ],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("return_recorded");
    expect(result.restocked).toBe(true);
    expect(result.restockInvoked).toBe(true);
    expect(result.restockError).toBeUndefined();
    expect(restock).toHaveBeenCalledOnce();
    const ctx = restock.mock.calls[0][1];
    expect(ctx.wmsOrderId).toBe(42);
    expect(ctx.omsOrderId).toBe(99);
    expect(ctx.refundLineItems).toHaveLength(1);
    expect(ctx.refundLineItems[0].restock_type).toBe("return");
  });

  it("refund with restock=true line → restocked=true (treats boolean restock as restock signal)", async () => {
    const mock = makeDb([
      { rows: [{ id: 42 }] },
      { rows: [] },
      { rows: [{ id: 7003 }] },
      { rows: [] },
    ]);

    const restock = vi.fn(async () => undefined);
    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [{ line_item_id: 1, quantity: 1, restock: true }],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.restocked).toBe(true);
    expect(restock).toHaveBeenCalledOnce();
  });

  it("no associated shipment → no_shipment_to_associate, no INSERT, no restock", async () => {
    const mock = makeDb([
      { rows: [{ id: 42 }] }, // WMS order
      { rows: [] }, // idempotency
      { rows: [] }, // most-recent shipment: empty
    ]);

    const restock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [{ line_item_id: 1, quantity: 1, restock: true }],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("no_shipment_to_associate");
    expect(result.shipmentId).toBeNull();
    expect(result.restocked).toBe(false);
    expect(result.restockInvoked).toBe(false);
    expect(restock).not.toHaveBeenCalled();
    // Only 3 db.execute calls (WMS, idempotency, shipment) — no INSERT
    expect(mock.execute).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("order not tracked in OMS → order_not_tracked, no DB writes", async () => {
    const mock = makeDb([]);
    const restock = vi.fn();

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund(),
      { resolveOmsOrder: buildResolveOmsOrder(null), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("order_not_tracked");
    expect(result.omsOrderId).toBeUndefined();
    expect(result.wmsOrderId).toBeUndefined();
    expect(result.restocked).toBe(false);
    expect(mock.execute).not.toHaveBeenCalled();
    expect(restock).not.toHaveBeenCalled();
  });

  it("WMS order not found → wms_order_not_found, no INSERT", async () => {
    const mock = makeDb([
      { rows: [] }, // WMS order: empty
    ]);
    const restock = vi.fn();

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund(),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("wms_order_not_found");
    expect(result.omsOrderId).toBe(99);
    expect(mock.execute).toHaveBeenCalledTimes(1);
    expect(restock).not.toHaveBeenCalled();
  });

  it("idempotent: same refund.id arrives twice → second call no-ops with idempotent_skip", async () => {
    const mock = makeDb([
      { rows: [{ id: 42 }] }, // WMS order
      { rows: [{ id: 555 }] }, // idempotency: existing row found
    ]);
    const restock = vi.fn();

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [{ line_item_id: 1, restock: true }],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("idempotent_skip");
    expect(result.wmsOrderId).toBe(42);
    expect(result.restocked).toBe(false);
    expect(result.restockInvoked).toBe(false);
    // Only WMS lookup + idempotency check — no shipment lookup, no INSERT
    expect(mock.execute).toHaveBeenCalledTimes(2);
    expect(restock).not.toHaveBeenCalled();
  });

  it("bad payload: missing id → throws RefundsCreateBadPayloadError", async () => {
    const mock = makeDb([]);
    await expect(
      applyShopifyRefundCascade(
        mock.db,
        { order_id: 12345 },
        { resolveOmsOrder: buildResolveOmsOrder(99) },
        { channelId: 5, now: NOW },
      ),
    ).rejects.toBeInstanceOf(RefundsCreateBadPayloadError);
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("bad payload: missing order_id → throws RefundsCreateBadPayloadError", async () => {
    const mock = makeDb([]);
    await expect(
      applyShopifyRefundCascade(
        mock.db,
        { id: 99887766 },
        { resolveOmsOrder: buildResolveOmsOrder(99) },
        { channelId: 5, now: NOW },
      ),
    ).rejects.toBeInstanceOf(RefundsCreateBadPayloadError);
  });

  it("bad payload: null payload → throws RefundsCreateBadPayloadError", async () => {
    const mock = makeDb([]);
    await expect(
      applyShopifyRefundCascade(
        mock.db,
        null,
        { resolveOmsOrder: buildResolveOmsOrder(99) },
        { channelId: 5, now: NOW },
      ),
    ).rejects.toBeInstanceOf(RefundsCreateBadPayloadError);
  });

  it("DB failure on INSERT → propagates (caller maps to 500)", async () => {
    const mock = {
      db: {
        execute: vi
          .fn()
          // WMS lookup ok
          .mockResolvedValueOnce({ rows: [{ id: 42 }] })
          // idempotency ok
          .mockResolvedValueOnce({ rows: [] })
          // shipment ok
          .mockResolvedValueOnce({ rows: [{ id: 7004 }] })
          // INSERT throws
          .mockRejectedValueOnce(new Error("connection terminated")),
      } as any,
    };

    await expect(
      applyShopifyRefundCascade(
        mock.db,
        baseRefund(),
        { resolveOmsOrder: buildResolveOmsOrder(99) },
        { channelId: 5, now: NOW },
      ),
    ).rejects.toThrow("connection terminated");
  });

  it("restock helper throws → return record still considered recorded, error captured", async () => {
    const mock = makeDb([
      { rows: [{ id: 42 }] }, // WMS
      { rows: [] }, // idempotency
      { rows: [{ id: 7005 }] }, // shipment
      { rows: [] }, // INSERT
    ]);

    const restock = vi.fn(async () => {
      throw new Error("reservation service down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund({
        refund_line_items: [{ line_item_id: 1, restock: true }],
      }),
      { resolveOmsOrder: buildResolveOmsOrder(99), restock },
      { channelId: 5, now: NOW },
    );

    expect(result.outcome).toBe("return_recorded");
    expect(result.restocked).toBe(true);
    expect(result.restockInvoked).toBe(true);
    expect(result.restockError).toContain("reservation service down");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("picks the most-recent shipment (id DESC LIMIT 1) consistently", async () => {
    // Verifies the cascade does not collapse to e.g. lowest id; it asks
    // db.execute for the shipment and uses whatever id is returned. The
    // SQL itself is `ORDER BY id DESC LIMIT 1` (asserted by inspecting
    // the issued query string).
    const mock = makeDb([
      { rows: [{ id: 42 }] },
      { rows: [] },
      { rows: [{ id: 9999 }] },
      { rows: [] },
    ]);

    const result = await applyShopifyRefundCascade(
      mock.db,
      baseRefund(),
      { resolveOmsOrder: buildResolveOmsOrder(99) },
      { channelId: 5, now: NOW },
    );

    expect(result.shipmentId).toBe(9999);
    // The shipment lookup query (3rd execute call) must include
    // ORDER BY id DESC LIMIT 1 fragment.
    const shipmentQuery = mock.calls[2];
    const queryStr = JSON.stringify(shipmentQuery);
    expect(queryStr).toContain("ORDER BY id DESC");
    expect(queryStr).toContain("LIMIT 1");
  });

  it("uses processed_at as refundedAt when present, falls back to now", async () => {
    // Smoke-check: cascade accepts both shapes. We don't assert the
    // bound parameter here (sql template tag opaque); we just assert
    // the cascade reaches the INSERT step in both cases.
    const mock1 = makeDb([
      { rows: [{ id: 42 }] },
      { rows: [] },
      { rows: [{ id: 7006 }] },
      { rows: [] },
    ]);
    const r1 = await applyShopifyRefundCascade(
      mock1.db,
      baseRefund({ processed_at: "2026-04-25T10:00:00Z" }),
      { resolveOmsOrder: buildResolveOmsOrder(99) },
      { channelId: 5, now: NOW },
    );
    expect(r1.outcome).toBe("return_recorded");

    const mock2 = makeDb([
      { rows: [{ id: 42 }] },
      { rows: [] },
      { rows: [{ id: 7007 }] },
      { rows: [] },
    ]);
    const r2 = await applyShopifyRefundCascade(
      mock2.db,
      baseRefund({ processed_at: undefined }),
      { resolveOmsOrder: buildResolveOmsOrder(99) },
      { channelId: 5, now: NOW },
    );
    expect(r2.outcome).toBe("return_recorded");
  });
});
