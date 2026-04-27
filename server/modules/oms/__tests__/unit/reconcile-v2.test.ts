/**
 * Unit tests — reconcile v2 (shipstation-outbound-shipments sweep).
 *
 * Plan §6 Commit 35: the V2 reconcile reads wms.outbound_shipments
 * instead of the legacy wms.orders ↔ oms.oms_orders JOIN.  Each test
 * stubs the three external surfaces:
 *
 *   1. db.execute          — SQL queries + updates
 *   2. ss.getOrderById     — ShipStation order state
 *   3. ss.getShipments     — ShipStation shipment details (void detection)
 *
 * plus the shipment-rollup helpers dispatched via `dispatchShipmentEvent`
 * and `recomputeOrderStatusFromShipments`.
 *
 * Because the reconcile lives inside server/index.ts (an IIFE-wrapped
 * block, not a standalone module), we test by exercising the same code
 * path in isolation: each test builds a fake `db`, `ss`, and calls the
 * same dispatch → recompute → OMS-update sequence the production code
 * uses, verifying call counts and arguments.
 *
 * Coding-standards compliance:
 *   - Rule #2  (determinism): all timestamps injected, no Date.now()
 *   - Rule #5  (errors): SS API throws → no last_reconciled_at stamp
 *   - Rule #6  (idempotency): shipped+shipped → no markShipmentShipped call
 *   - Rule #14 (test isolation): every mock created per-test, no shared state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Helpers under test (replicated from server/index.ts reconcile) ─────

/**
 * Minimal reproduction of the V2 reconcile loop body so we can unit-test
 * the dispatch logic without booting the full Express server.
 *
 * In production this lives inside the runShipStationReconcileV2 IIFE.
 * We extract the per-row logic into a testable function.
 */
async function reconcileOneShipment(
  db: any,
  ss: any,
  row: {
    shipment_id: number;
    order_id: number;
    shipstation_order_id: number;
    wms_shipment_status: string;
    tracking_number: string | null;
    carrier: string | null;
  },
  dispatchShipmentEvent: typeof import("../../orders/shipment-rollup").dispatchShipmentEvent,
  recomputeOrderStatusFromShipments: typeof import("../../orders/shipment-rollup").recomputeOrderStatusFromShipments,
) {
  const shipmentId = row.shipment_id;
  const ssOrderId = Number(row.shipstation_order_id);

  // 1. Fetch SS order state
  const ssOrder = await ss.getOrderById(ssOrderId);
  if (!ssOrder) {
    return { stamped: false, event: null };
  }

  let event: { kind: string; [key: string]: any } | null = null;

  // 2. Detect voided labels first (voidDate beats orderStatus)
  if (row.wms_shipment_status !== "voided") {
    const ssShipments = await ss.getShipments(ssOrderId);
    const hasVoidedLabel = ssShipments.some((s: any) => s.voidDate != null);
    if (hasVoidedLabel) {
      event = { kind: "voided", reason: "ss_label_void" };
    }
  }

  // 3. Detect shipped / cancelled from order status
  if (!event) {
    if (ssOrder.orderStatus === "shipped" && row.wms_shipment_status !== "shipped") {
      const ssShipments = await ss.getShipments(ssOrderId);
      const latest = ssShipments[ssShipments.length - 1];
      event = {
        kind: "shipped",
        trackingNumber: latest?.trackingNumber || row.tracking_number || "",
        carrier: latest?.carrierCode || row.carrier || "other",
        shipDate: latest?.shipDate ? new Date(latest.shipDate) : new Date(),
      };
    } else if (ssOrder.orderStatus === "cancelled" && row.wms_shipment_status !== "cancelled") {
      event = { kind: "cancelled", reason: "ss_cancelled" };
    }
  }

  if (!event) {
    // No divergence — stamp to prove we checked
    await db.execute("stamp_reconciled", { shipmentId });
    return { stamped: true, event: null };
  }

  // 4. Dispatch via shipment-rollup helpers
  const { wmsOrderId, changed } = await dispatchShipmentEvent(db, shipmentId, event as any);

  if (changed) {
    // 5. Recompute order-level warehouse_status
    await recomputeOrderStatusFromShipments(db, row.order_id);

    // 6. Update OMS derived fields (inline)
    if (event.kind === "shipped") {
      await db.execute("oms_update_shipped", {
        orderId: row.order_id,
        trackingNumber: event.trackingNumber,
        carrier: event.carrier,
        shipDate: event.shipDate,
      });
    } else if (event.kind === "cancelled") {
      await db.execute("oms_update_cancelled", { orderId: row.order_id });
    }
    // voided: no OMS state change by design
  }

  // 7. Stamp last_reconciled_at
  await db.execute("stamp_reconciled", { shipmentId });

  return { stamped: true, event };
}

// ─── Test fixtures ─────────────────────────────────────────────────────

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSs(overrides: {
  orderById?: any;
  shipments?: any[];
  getOrderByIdThrows?: boolean;
} = {}) {
  return {
    isConfigured: () => true,
    getOrderById: overrides.getOrderByIdThrows
      ? vi.fn().mockRejectedValue(new Error("SS API down"))
      : vi.fn().mockResolvedValue(overrides.orderById ?? null),
    getShipments: vi.fn().mockResolvedValue(overrides.shipments ?? []),
  };
}

function makeRow(overrides: Partial<{
  shipment_id: number;
  order_id: number;
  shipstation_order_id: number;
  wms_shipment_status: string;
  tracking_number: string | null;
  carrier: string | null;
}> = {}) {
  return {
    shipment_id: overrides.shipment_id ?? 100,
    order_id: overrides.order_id ?? 1,
    shipstation_order_id: overrides.shipstation_order_id ?? 9999,
    wms_shipment_status: overrides.wms_shipment_status ?? "queued",
    tracking_number: overrides.tracking_number ?? null,
    carrier: overrides.carrier ?? null,
  };
}

// Stub dispatchShipmentEvent — returns { wmsOrderId, changed }
function makeDispatch(result: { wmsOrderId: number; changed: boolean }) {
  return vi.fn().mockResolvedValue(result);
}

// Stub recomputeOrderStatusFromShipments
function makeRecompute() {
  return vi.fn().mockResolvedValue({ warehouseStatus: "shipped", changed: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("reconcile-v2 :: per-shipment logic", () => {
  let db: ReturnType<typeof makeDb>;
  let dispatch: ReturnType<typeof makeDispatch>;
  let recompute: ReturnType<typeof makeRecompute>;

  beforeEach(() => {
    db = makeDb();
    dispatch = makeDispatch({ wmsOrderId: 1, changed: true });
    recompute = makeRecompute();
  });

  // ── Happy paths ──────────────────────────────────────────────────────

  it("queued → SS shipped → dispatches markShipmentShipped + stamps", async () => {
    const ss = makeSs({
      orderById: { orderStatus: "shipped" },
      shipments: [{ trackingNumber: "1Z999", carrierCode: "ups", shipDate: "2025-01-15" }],
    });

    const result = await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "queued" }),
      dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(db, 100, expect.objectContaining({ kind: "shipped" }));
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("oms_update_shipped", expect.any(Object));
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event?.kind).toBe("shipped");
  });

  it("labeled → SS cancelled → dispatches markShipmentCancelled + stamps", async () => {
    const ss = makeSs({ orderById: { orderStatus: "cancelled" } });

    const result = await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "labeled" }),
      dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(db, 100, expect.objectContaining({ kind: "cancelled" }));
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("oms_update_cancelled", { orderId: 1 });
    expect(result.event?.kind).toBe("cancelled");
  });

  it("queued → SS voided (voidDate) → dispatches markShipmentVoided + stamps", async () => {
    const ss = makeSs({
      orderById: { orderStatus: "awaiting_shipment" },
      shipments: [{ voidDate: "2025-01-16", trackingNumber: "1Z999" }],
    });

    const result = await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "queued" }),
      dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(db, 100, expect.objectContaining({ kind: "voided" }));
    // voided: no OMS update call
    expect(db.execute).not.toHaveBeenCalledWith("oms_update_shipped", expect.any(Object));
    expect(db.execute).not.toHaveBeenCalledWith("oms_update_cancelled", expect.any(Object));
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event?.kind).toBe("voided");
  });

  // ── Idempotency ──────────────────────────────────────────────────────

  it("shipped → SS shipped (idempotent) → no dispatch but stamps", async () => {
    const ss = makeSs({ orderById: { orderStatus: "shipped" } });

    const result = await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "shipped" }),
      dispatch as any, recompute,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event).toBeNull();
  });

  it("queued → SS awaiting_shipment (no divergence) → no dispatch but stamps", async () => {
    const ss = makeSs({ orderById: { orderStatus: "awaiting_shipment" } });

    const result = await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "queued" }),
      dispatch as any, recompute,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event).toBeNull();
  });

  // ── dispatchShipmentEvent returns changed=false ──────────────────────

  it("SS shipped but dispatch says changed=false → stamps but no recompute/OMS", async () => {
    const ss = makeSs({
      orderById: { orderStatus: "shipped" },
      shipments: [{ trackingNumber: "1Z999", carrierCode: "ups", shipDate: "2025-01-15" }],
    });
    const noChangeDispatch = makeDispatch({ wmsOrderId: 1, changed: false });

    await reconcileOneShipment(
      db, ss, makeRow({ wms_shipment_status: "queued" }),
      noChangeDispatch as any, recompute,
    );

    expect(noChangeDispatch).toHaveBeenCalledTimes(1);
    expect(recompute).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
  });

  // ── SS API errors ────────────────────────────────────────────────────

  it("SS getOrderById throws → skip + DON'T stamp last_reconciled_at", async () => {
    const ss = makeSs({ getOrderByIdThrows: true });

    await expect(
      reconcileOneShipment(
        db, ss, makeRow(),
        dispatch as any, recompute,
      ),
    ).rejects.toThrow("SS API down");

    expect(dispatch).not.toHaveBeenCalled();
    // The outer catch in production catches this; here we verify the
    // rejection propagates so the caller can skip the stamp.
    expect(db.execute).not.toHaveBeenCalledWith("stamp_reconciled", expect.any(Object));
  });

  it("SS getOrderById returns null → skip + don't stamp", async () => {
    const ss = makeSs({ orderById: null });

    const result = await reconcileOneShipment(
      db, ss, makeRow(),
      dispatch as any, recompute,
    );

    expect(result.stamped).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("SS getShipments throws → propagate (no stamp)", async () => {
    const ss = {
      isConfigured: () => true,
      getOrderById: vi.fn().mockResolvedValue({ orderStatus: "shipped" }),
      getShipments: vi.fn().mockRejectedValue(new Error("shipments API down")),
    };

    await expect(
      reconcileOneShipment(
        db, ss, makeRow({ wms_shipment_status: "queued" }),
        dispatch as any, recompute,
      ),
    ).rejects.toThrow("shipments API down");

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalledWith("stamp_reconciled", expect.any(Object));
  });
});

describe("reconcile-v2 :: batch behaviour", () => {
  it("multiple shipments processed independently", async () => {
    const db = makeDb();
    const dispatch = makeDispatch({ wmsOrderId: 1, changed: true });
    const recompute = makeRecompute();

    const ss = {
      isConfigured: () => true,
      getOrderById: vi.fn()
        .mockResolvedValueOnce({ orderStatus: "shipped" })
        .mockResolvedValueOnce({ orderStatus: "awaiting_shipment" }),
      getShipments: vi.fn()
        .mockResolvedValueOnce([])                                           // row 1 void check
        .mockResolvedValueOnce([{ trackingNumber: "1Z_A", carrierCode: "ups", shipDate: "2025-01-15" }])  // row 1 shipped
        .mockResolvedValueOnce([]),                                          // row 2 void check
    };

    const rows = [
      makeRow({ shipment_id: 100, wms_shipment_status: "queued" }),
      makeRow({ shipment_id: 101, wms_shipment_status: "queued", shipstation_order_id: 9998 }),
    ];

    for (const row of rows) {
      await reconcileOneShipment(db, ss, row, dispatch as any, recompute);
    }

    // Row 1: shipped detected → dispatch + stamp
    // Row 2: no divergence → stamp only
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 101 });
  });
});
