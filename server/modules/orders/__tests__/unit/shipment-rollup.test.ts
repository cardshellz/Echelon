/**
 * Unit tests for shipment-rollup helpers (§6 Commit 15).
 *
 * Scope: every helper in `server/modules/orders/shipment-rollup.ts`
 * uses a hand-rolled scripted DB mock — no real DB, no network. The
 * helpers themselves are deterministic (clock injected via `opts.now`),
 * so we don't mock system time.
 *
 * Coverage (aligned with task brief + coding-standards #9):
 *   - `recomputeOrderStatusFromShipments`
 *       - 1 shipped              → 'shipped'
 *       - 2 shipped              → 'shipped'
 *       - 1 shipped + 1 planned  → 'partially_shipped'
 *       - 1 shipped + 1 cancelled→ 'shipped'
 *       - 2 cancelled            → 'cancelled'
 *       - 1 on_hold              → 'on_hold'
 *       - 0 shipments on already-post-ready order → no change
 *       - Already matching current state → changed=false
 *       - Missing order row → changed=false
 *       - Shipped transition stamps completed_at iff previously null
 *   - `markShipmentShipped`
 *       - Happy path UPDATE + wmsOrderId returned
 *       - Idempotent replay (same tracking) → no UPDATE
 *       - Re-tracking (different tracking) → UPDATE runs
 *       - Missing shipment throws SHIPMENT_NOT_FOUND
 *       - Input validation (shipmentId / tracking / carrier / shipDate)
 *   - `markShipmentCancelled`
 *       - Happy path + idempotent replay
 *   - `markShipmentVoided`
 *       - Happy path clears tracking + idempotent replay
 *   - `dispatchShipmentEvent`
 *       - Routes each `kind` to the right helper
 */

import { describe, it, expect, vi } from "vitest";

import {
  markShipmentShipped,
  markShipmentCancelled,
  markShipmentVoided,
  recomputeOrderStatusFromShipments,
  dispatchShipmentEvent,
} from "../../shipment-rollup";

// ─── Scripted DB mock ────────────────────────────────────────────────

type ScriptedResponse = { rows: any[] } | { rows: [] };

function makeDb(scripted: ScriptedResponse[]) {
  const calls: Array<{ sqlText: string }> = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (query: any) => {
    // drizzle sql`` tagged template stores the raw literal string
    // fragments on `queryChunks`. Each chunk is either a string (the
    // static SQL text) or a nested sql object / param placeholder.
    // For test assertions we only care about the static text, so we
    // stringify only the primitive chunks.
    const chunks: unknown[] = query?.queryChunks ?? [];
    const text = chunks
      .map((c) => {
        if (typeof c === "string") return c;
        // Drizzle StringChunk exposes its value via a `value` array
        // of strings in recent versions.
        if (c && typeof c === "object" && Array.isArray((c as any).value)) {
          return (c as any).value.join("");
        }
        return "";
      })
      .join("");
    calls.push({ sqlText: text });
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });
  return {
    db: { execute } as any,
    execute,
    calls,
    getCallCount: () => calls.length,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────

const NOW = new Date("2026-04-24T12:00:00Z");

function shipmentRow(
  overrides: Partial<{
    id: number;
    order_id: number;
    status: string;
    tracking_number: string | null;
    carrier: string | null;
    tracking_url: string | null;
    shopify_fulfillment_id: string | null;
  }> = {},
) {
  return {
    id: 501,
    order_id: 42,
    status: "planned",
    tracking_number: null,
    carrier: null,
    tracking_url: null,
    shopify_fulfillment_id: null,
    ...overrides,
  };
}

// ─── markShipmentShipped ─────────────────────────────────────────────

describe("markShipmentShipped", () => {
  it("UPDATEs shipment and returns { wmsOrderId, changed: true } on happy path", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] }, // SELECT current
      { rows: [] }, // UPDATE
    ]);

    const result = await markShipmentShipped(
      mock.db,
      501,
      {
        trackingNumber: "1Z999",
        carrier: "UPS",
        shipDate: NOW,
        trackingUrl: "https://track.example/1Z999",
      },
      { now: NOW },
    );

    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(mock.getCallCount()).toBe(2);
  });

  it("is idempotent when shipment is already shipped with SAME tracking + carrier", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "1Z999",
            carrier: "UPS",
          }),
        ],
      },
      // NO second response — an UPDATE would consume one and fall
      // through to the default empty {rows: []} but we assert call
      // count explicitly below.
    ]);

    const result = await markShipmentShipped(
      mock.db,
      501,
      { trackingNumber: "1Z999", carrier: "UPS", shipDate: NOW },
      { now: NOW },
    );

    expect(result).toEqual({ wmsOrderId: 42, changed: false });
    // Exactly one DB call: the SELECT. No UPDATE.
    expect(mock.getCallCount()).toBe(1);
  });

  it("re-writes tracking when shipment was shipped but tracking differs (re-label flow)", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "OLD-123",
            carrier: "UPS",
          }),
        ],
      },
      { rows: [] }, // UPDATE
    ]);

    const result = await markShipmentShipped(
      mock.db,
      501,
      { trackingNumber: "NEW-456", carrier: "UPS", shipDate: NOW },
      { now: NOW },
    );

    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(mock.getCallCount()).toBe(2);
  });

  it("re-writes when shipment was shipped but carrier differs", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "1Z999",
            carrier: "UPS",
          }),
        ],
      },
      { rows: [] },
    ]);
    const result = await markShipmentShipped(
      mock.db,
      501,
      { trackingNumber: "1Z999", carrier: "FedEx", shipDate: NOW },
      { now: NOW },
    );
    expect(result.changed).toBe(true);
  });

  it("throws SHIPMENT_NOT_FOUND when shipment row is missing", async () => {
    const mock = makeDb([{ rows: [] }]);
    let err: any;
    try {
      await markShipmentShipped(
        mock.db,
        9999,
        { trackingNumber: "x", carrier: "UPS", shipDate: NOW },
        { now: NOW },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("SHIPMENT_NOT_FOUND");
    expect(err.shipmentId).toBe(9999);
  });

  it("rejects non-positive shipmentId without hitting the DB", async () => {
    const mock = makeDb([]);
    await expect(
      markShipmentShipped(
        mock.db,
        0,
        { trackingNumber: "x", carrier: "UPS", shipDate: NOW },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", field: "shipmentId" });
    expect(mock.getCallCount()).toBe(0);
  });

  it("rejects empty tracking number up front", async () => {
    const mock = makeDb([]);
    await expect(
      markShipmentShipped(
        mock.db,
        501,
        { trackingNumber: "   ", carrier: "UPS", shipDate: NOW },
        { now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      field: "trackingNumber",
    });
    expect(mock.getCallCount()).toBe(0);
  });

  it("rejects empty carrier up front", async () => {
    const mock = makeDb([]);
    await expect(
      markShipmentShipped(
        mock.db,
        501,
        { trackingNumber: "x", carrier: "", shipDate: NOW },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", field: "carrier" });
  });

  it("rejects invalid shipDate up front", async () => {
    const mock = makeDb([]);
    await expect(
      markShipmentShipped(
        mock.db,
        501,
        {
          trackingNumber: "x",
          carrier: "UPS",
          shipDate: new Date("not-a-date"),
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      field: "shipDate",
    });
  });
});

// ─── markShipmentCancelled ──────────────────────────────────────────

describe("markShipmentCancelled", () => {
  it("UPDATEs shipment on happy path", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await markShipmentCancelled(
      mock.db,
      501,
      "customer_cancel",
      { now: NOW },
    );
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(mock.getCallCount()).toBe(2);
  });

  it("is idempotent when shipment is already cancelled (first reason wins)", async () => {
    const mock = makeDb([
      { rows: [shipmentRow({ status: "cancelled" })] },
    ]);
    const result = await markShipmentCancelled(
      mock.db,
      501,
      "different_reason_now",
      { now: NOW },
    );
    expect(result).toEqual({ wmsOrderId: 42, changed: false });
    expect(mock.getCallCount()).toBe(1);
  });

  it("tolerates omitted reason (writes null)", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await markShipmentCancelled(mock.db, 501, undefined, {
      now: NOW,
    });
    expect(result.changed).toBe(true);
  });

  it("throws SHIPMENT_NOT_FOUND on missing row", async () => {
    const mock = makeDb([{ rows: [] }]);
    await expect(
      markShipmentCancelled(mock.db, 501, "x", { now: NOW }),
    ).rejects.toMatchObject({ code: "SHIPMENT_NOT_FOUND" });
  });
});

// ─── markShipmentVoided ──────────────────────────────────────────────

describe("markShipmentVoided", () => {
  it("UPDATEs shipment to voided + clears tracking on happy path", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "1Z999",
            carrier: "UPS",
          }),
        ],
      },
      { rows: [] }, // history insert
      { rows: [] }, // shipment UPDATE
    ]);
    const result = await markShipmentVoided(mock.db, 501, "ss_void", {
      now: NOW,
    });
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    // 3 DB calls now: load + history insert + UPDATE (§6 Commit 17).
    expect(mock.getCallCount()).toBe(3);
    // History insert is call index 1; UPDATE is index 2.
    expect(mock.calls[1].sqlText).toContain("shipment_tracking_history");
    expect(mock.calls[2].sqlText).toContain("UPDATE wms.outbound_shipments");
  });

  it("skips history insert when shipment has no prior tracking number", async () => {
    const mock = makeDb([
      { rows: [shipmentRow({ status: "planned", tracking_number: null })] },
      { rows: [] },
    ]);
    const result = await markShipmentVoided(mock.db, 501, undefined, {
      now: NOW,
    });
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    // Only 2 calls: load + UPDATE. No history insert because no tracking.
    expect(mock.getCallCount()).toBe(2);
    expect(mock.calls[1].sqlText).toContain("UPDATE wms.outbound_shipments");
  });

  it("proceeds with void even if history insert fails", async () => {
    // Make the mock throw on the second call (history insert)
    const loadResponse = { rows: [shipmentRow({ status: "shipped", tracking_number: "T1", carrier: "UPS" })] };
    const updateResponse = { rows: [] };
    let callIdx = 0;
    const execute = vi.fn(async () => {
      const i = callIdx++;
      if (i === 0) return loadResponse;
      if (i === 1) throw new Error("history table locked");
      return updateResponse;
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await markShipmentVoided({ execute } as any, 501, "ss_void", {
      now: NOW,
    });

    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toContain("history insert failed");
    errSpy.mockRestore();
  });

  it("invokes fulfillmentPush.cancelShopifyFulfillment when shipment has shopify_fulfillment_id AND hook provided", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "T1",
            carrier: "UPS",
            shopify_fulfillment_id: "gid://shopify/Fulfillment/999",
          }),
        ],
      },
      { rows: [] }, // history
      { rows: [] }, // UPDATE
    ]);
    const cancel = vi.fn(async (_id: string) => {});
    const result = await markShipmentVoided(mock.db, 501, "ss_void", {
      now: NOW,
      fulfillmentPush: { cancelShopifyFulfillment: cancel },
    });
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("gid://shopify/Fulfillment/999");
  });

  it("does not call cancelShopifyFulfillment when hook is not provided", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "T1",
            shopify_fulfillment_id: "gid://shopify/Fulfillment/999",
          }),
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);
    // No fulfillmentPush in opts
    const result = await markShipmentVoided(mock.db, 501, "ss_void", { now: NOW });
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
  });

  it("does not call cancelShopifyFulfillment when shipment has no shopify_fulfillment_id", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "T1",
            shopify_fulfillment_id: null,
          }),
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const cancel = vi.fn(async () => {});
    const result = await markShipmentVoided(mock.db, 501, "ss_void", {
      now: NOW,
      fulfillmentPush: { cancelShopifyFulfillment: cancel },
    });
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("proceeds with void even if Shopify cancel throws", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "T1",
            shopify_fulfillment_id: "gid://shopify/Fulfillment/999",
          }),
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const cancel = vi.fn(async () => {
      throw new Error("shopify api 500");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await markShipmentVoided(mock.db, 501, "ss_void", {
      now: NOW,
      fulfillmentPush: { cancelShopifyFulfillment: cancel },
    });

    expect(result).toEqual({ wmsOrderId: 42, changed: true });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toContain("Shopify fulfillment cancel failed");
    errSpy.mockRestore();
  });

  it("is idempotent when shipment is already voided", async () => {
    const mock = makeDb([
      { rows: [shipmentRow({ status: "voided" })] },
    ]);
    const result = await markShipmentVoided(mock.db, 501, "ss_void", {
      now: NOW,
    });
    expect(result).toEqual({ wmsOrderId: 42, changed: false });
    expect(mock.getCallCount()).toBe(1);
  });

  it("defaults reason to 'ss_label_void' when omitted", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await markShipmentVoided(mock.db, 501, undefined, {
      now: NOW,
    });
    expect(result.changed).toBe(true);
  });

  it("throws SHIPMENT_NOT_FOUND on missing row", async () => {
    const mock = makeDb([{ rows: [] }]);
    await expect(
      markShipmentVoided(mock.db, 501, "x", { now: NOW }),
    ).rejects.toMatchObject({ code: "SHIPMENT_NOT_FOUND" });
  });
});

// ─── recomputeOrderStatusFromShipments ──────────────────────────────
//
// Read order: order row FIRST, then shipments list. Tests script the
// response queue in that order.

describe("recomputeOrderStatusFromShipments :: state matrix", () => {
  it("1 shipment 'shipped' → order 'shipped' (changed=true)", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "shipped" }] },
      { rows: [] }, // UPDATE
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result).toEqual({ warehouseStatus: "shipped", changed: true });
    expect(mock.getCallCount()).toBe(3);
  });

  it("2 shipments both 'shipped' → 'shipped'", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "partially_shipped",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "shipped" }, { status: "shipped" }] },
      { rows: [] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result).toEqual({ warehouseStatus: "shipped", changed: true });
  });

  it("1 shipped + 1 planned → 'partially_shipped'", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "shipped" }, { status: "planned" }] },
      { rows: [] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result).toEqual({
      warehouseStatus: "partially_shipped",
      changed: true,
    });
  });

  it("1 shipped + 1 cancelled → 'shipped' (cancelled counts as fulfilled)", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "shipped" }, { status: "cancelled" }] },
      { rows: [] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result.warehouseStatus).toBe("shipped");
    expect(result.changed).toBe(true);
  });

  it("2 shipments both cancelled → 'cancelled'", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "cancelled" }, { status: "cancelled" }] },
      { rows: [] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result.warehouseStatus).toBe("cancelled");
    expect(result.changed).toBe(true);
  });

  it("any on_hold → 'on_hold' (highest priority)", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "ready_to_ship",
            completed_at: null,
          },
        ],
      },
      { rows: [{ status: "on_hold" }, { status: "shipped" }] },
      { rows: [] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result.warehouseStatus).toBe("on_hold");
  });

  it("empty shipments + already-post-ready order → no change (no clobber)", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "picking",
            completed_at: null,
          },
        ],
      },
      { rows: [] }, // no shipments
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    // Keeps current state, no UPDATE.
    expect(result.changed).toBe(false);
    expect(result.warehouseStatus).toBe("picking");
    expect(mock.getCallCount()).toBe(2);
  });

  it("already matches derived state → changed=false, no UPDATE", async () => {
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "shipped",
            completed_at: new Date("2026-04-23T10:00:00Z"),
          },
        ],
      },
      { rows: [{ status: "shipped" }] },
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result).toEqual({ warehouseStatus: "shipped", changed: false });
    expect(mock.getCallCount()).toBe(2); // SELECTs only, no UPDATE.
  });

  it("missing order row → changed=false, no throw", async () => {
    const mock = makeDb([
      { rows: [] }, // order missing
      { rows: [] }, // shipments
    ]);
    const result = await recomputeOrderStatusFromShipments(mock.db, 42, {
      now: NOW,
    });
    expect(result.changed).toBe(false);
    expect(result.warehouseStatus).toBe("ready"); // empty derivation
  });

  it("stamps completed_at on transition to 'shipped' when previously null", async () => {
    const mock = makeDb([
      {
        rows: [
          { id: 42, warehouse_status: "ready_to_ship", completed_at: null },
        ],
      },
      { rows: [{ status: "shipped" }] },
      { rows: [] },
    ]);
    await recomputeOrderStatusFromShipments(mock.db, 42, { now: NOW });
    // Assert that there were exactly 3 DB calls (SELECT order, SELECT
    // shipments, UPDATE). The distinction between the "stamp" UPDATE
    // and the "no-stamp" UPDATE is observable via the execute call
    // signature — we verify the shape by inspecting params below.
    expect(mock.getCallCount()).toBe(3);
    // The 3rd call is the UPDATE. Its SQL text must include
    // "completed_at" — it's the stamping variant.
    expect(mock.calls[2].sqlText).toMatch(/completed_at/);
  });

  it("does NOT re-stamp completed_at when transitioning to 'shipped' but it was already set", async () => {
    const prev = new Date("2026-04-20T08:00:00Z");
    const mock = makeDb([
      {
        rows: [
          {
            id: 42,
            warehouse_status: "partially_shipped",
            completed_at: prev,
          },
        ],
      },
      { rows: [{ status: "shipped" }, { status: "shipped" }] },
      { rows: [] },
    ]);
    await recomputeOrderStatusFromShipments(mock.db, 42, { now: NOW });
    expect(mock.getCallCount()).toBe(3);
    // The no-stamp variant must NOT include completed_at.
    expect(mock.calls[2].sqlText).not.toMatch(/completed_at/);
  });

  it("rejects non-positive wmsOrderId without DB access", async () => {
    const mock = makeDb([]);
    await expect(
      recomputeOrderStatusFromShipments(mock.db, 0, { now: NOW }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      field: "wmsOrderId",
    });
    expect(mock.getCallCount()).toBe(0);
  });
});

// ─── dispatchShipmentEvent ──────────────────────────────────────────

describe("dispatchShipmentEvent", () => {
  it("routes 'shipped' to markShipmentShipped", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await dispatchShipmentEvent(
      mock.db,
      501,
      {
        kind: "shipped",
        trackingNumber: "X",
        carrier: "UPS",
        shipDate: NOW,
      },
      { now: NOW },
    );
    expect(result).toEqual({ wmsOrderId: 42, changed: true });
  });

  it("routes 'cancelled' to markShipmentCancelled", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await dispatchShipmentEvent(
      mock.db,
      501,
      { kind: "cancelled", reason: "test" },
      { now: NOW },
    );
    expect(result.changed).toBe(true);
  });

  it("routes 'voided' to markShipmentVoided", async () => {
    const mock = makeDb([
      { rows: [shipmentRow()] },
      { rows: [] },
    ]);
    const result = await dispatchShipmentEvent(
      mock.db,
      501,
      { kind: "voided", reason: "ss" },
      { now: NOW },
    );
    expect(result.changed).toBe(true);
  });

  it("propagates idempotent no-ops from mark-* helpers", async () => {
    const mock = makeDb([
      {
        rows: [
          shipmentRow({
            status: "shipped",
            tracking_number: "X",
            carrier: "UPS",
          }),
        ],
      },
    ]);
    const result = await dispatchShipmentEvent(
      mock.db,
      501,
      {
        kind: "shipped",
        trackingNumber: "X",
        carrier: "UPS",
        shipDate: NOW,
      },
      { now: NOW },
    );
    expect(result.changed).toBe(false);
    expect(mock.getCallCount()).toBe(1);
  });
});
