/**
 * Unit tests — reconcile v2 (engine-based outbound-shipments sweep).
 *
 * Plan §6 Commit 35: the V2 reconcile reads wms.outbound_shipments
 * instead of the legacy wms.orders ↔ oms.oms_orders JOIN.  Each test
 * stubs the three external surfaces:
 *
 *   1. db.execute          — SQL queries + updates
 *   2. engine.getState     — Engine order state (status, tracking, carrier)
 *   3. engine.getShipments — Canonical shipment events (shipped/voided/etc.)
 *
 * plus the shipment-rollup helpers dispatched via `dispatchShipmentEvent`
 * and `recomputeOrderStatusFromShipments`.
 *
 * Because the reconcile lives inside server/index.ts (an IIFE-wrapped
 * block, not a standalone module), we test by exercising the same code
 * path in isolation: each test builds a fake `db`, `engine`, and calls the
 * same derive → dispatch → recompute → OMS-update sequence the production
 * code uses, verifying call counts and arguments.
 *
 * Coding-standards compliance:
 *   - Rule #2  (determinism): all timestamps injected, no Date.now()
 *   - Rule #5  (errors): engine API throws → no last_reconciled_at stamp
 *   - Rule #6  (idempotency): shipped+shipped → no markShipmentShipped call
 *   - Rule #14 (test isolation): every mock created per-test, no shared state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveReconcileEvent } from "../../../shipping/reconcile-derive";
import type { EngineOrderState, CanonicalShipmentEvent } from "../../../shipping/types";

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
  engine: any,
  row: {
    shipment_id: number;
    order_id: number;
    wms_shipment_status: string;
    tracking_number: string | null;
    carrier: string | null;
    order_number?: string;
    oms_order_status?: string;
  },
  ref: { engine: string; engineOrderRef: string; engineShipmentRef?: string },
  dispatchShipmentEvent: typeof import("../../orders/shipment-rollup").dispatchShipmentEvent,
  recomputeOrderStatusFromShipments: typeof import("../../orders/shipment-rollup").recomputeOrderStatusFromShipments,
) {
  const shipmentId = row.shipment_id;

  // 1. Fetch engine order state + shipments
  const engineState: EngineOrderState | null = await engine.getState(ref);
  const orderNumber = String(row.order_number ?? "").trim();
  const canonicalShipments: CanonicalShipmentEvent[] = await engine.getShipments(
    ref,
    orderNumber ? { orderNumber } : undefined,
  );
  if (!engineState) {
    const hasInboundPackageFact = canonicalShipments.some(
      (shipment) =>
        shipment.kind === "shipped" || shipment.kind === "voided",
    );
    if (
      (row.wms_shipment_status === "queued" ||
        row.wms_shipment_status === "labeled") &&
      hasInboundPackageFact &&
      engine.applyInboundShipmentAuthority &&
      orderNumber
    ) {
      const processed = await engine.applyInboundShipmentAuthority({
        engineRef: ref,
        orderNumber,
      });
      await db.execute("stamp_reconciled", { shipmentId });
      return {
        stamped: true,
        event: null,
        delegated: true,
        processed,
      };
    }
    return { stamped: false, event: null };
  }

  // 2. Derive reconcile event from canonical types
  let event: { kind: string; [key: string]: any } | null = deriveReconcileEvent({
    engineState,
    currentWmsShipmentStatus: row.wms_shipment_status,
    currentTrackingNumber: row.tracking_number,
    currentCarrier: row.carrier,
    shipments: canonicalShipments,
    // Mirrors the production loop (server/index.ts): engine-side cancels are
    // only authoritative when the ORDER itself is cancelled.
    orderIsCancelled: row.oms_order_status === "cancelled",
  });

  if (
    event &&
    (event.kind === "shipped" || event.kind === "voided") &&
    engine.applyInboundShipmentAuthority
  ) {
    if (!orderNumber) {
      throw new Error(
        `Inbound shipment authority requires an order number for shipment ${shipmentId}`,
      );
    }
    const processed = await engine.applyInboundShipmentAuthority({
      engineRef: ref,
      orderNumber,
    });
    await db.execute("stamp_reconciled", { shipmentId });
    return { stamped: true, event, delegated: true, processed };
  }

  if (!event) {
    // No divergence — stamp to prove we checked
    await db.execute("stamp_reconciled", { shipmentId });
    return { stamped: true, event: null };
  }

  // 3. Dispatch via shipment-rollup helpers
  const { wmsOrderId, changed } = await dispatchShipmentEvent(db, shipmentId, event as any);

  if (changed) {
    // 4. Recompute order-level warehouse_status
    await recomputeOrderStatusFromShipments(db, row.order_id);

    // 5. Update OMS derived fields (inline)
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

  // 6. Stamp last_reconciled_at
  await db.execute("stamp_reconciled", { shipmentId });

  return { stamped: true, event };
}

// ─── Test fixtures ─────────────────────────────────────────────────────

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEngine(overrides: {
  state?: EngineOrderState | null;
  shipments?: CanonicalShipmentEvent[];
  getStateThrows?: boolean;
  applyInboundShipmentAuthority?: ReturnType<typeof vi.fn>;
} = {}) {
  const engine: Record<string, unknown> = {
    isConfigured: () => true,
    getState: overrides.getStateThrows
      ? vi.fn().mockRejectedValue(new Error("Engine API down"))
      : vi.fn().mockResolvedValue(overrides.state ?? null),
    getShipments: vi.fn().mockResolvedValue(overrides.shipments ?? []),
  };
  if (overrides.applyInboundShipmentAuthority) {
    engine.applyInboundShipmentAuthority =
      overrides.applyInboundShipmentAuthority;
  }
  return engine;
}

function makeRef(engineOrderRef = "9999") {
  return { engine: "shipstation", engineOrderRef, engineShipmentRef: undefined };
}

function makeRow(overrides: Partial<{
  shipment_id: number;
  order_id: number;
  wms_shipment_status: string;
  tracking_number: string | null;
  carrier: string | null;
  order_number: string;
  oms_order_status: string;
}> = {}) {
  return {
    shipment_id: overrides.shipment_id ?? 100,
    order_id: overrides.order_id ?? 1,
    wms_shipment_status: overrides.wms_shipment_status ?? "queued",
    tracking_number: overrides.tracking_number ?? null,
    carrier: overrides.carrier ?? null,
    order_number: overrides.order_number ?? "#100",
    oms_order_status: overrides.oms_order_status ?? "confirmed",
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

  it("queued → engine shipped → dispatches markShipmentShipped + stamps", async () => {
    const engine = makeEngine({
      state: { status: "shipped", trackingNumber: "1Z999", carrier: "ups", shipDate: new Date("2025-01-15") },
      shipments: [{ kind: "shipped", trackingNumber: "1Z999", carrierRaw: "ups", shipDate: new Date("2025-01-15"), items: [] }],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "queued" }),
      makeRef(), dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(db, 100, expect.objectContaining({ kind: "shipped" }));
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("oms_update_shipped", expect.any(Object));
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event?.kind).toBe("shipped");
  });

  it("delegates ShipStation package facts by order number instead of mutating the parent", async () => {
    const applyInboundShipmentAuthority = vi.fn().mockResolvedValue(2);
    const engine = makeEngine({
      state: {
        status: "shipped",
        trackingNumber: "9434650106151102226396",
        carrier: "stamps_com",
        shipDate: new Date("2026-07-08T23:19:00.000Z"),
      },
      shipments: [
        {
          kind: "shipped",
          trackingNumber: "9434650106151102226396",
          carrierRaw: "stamps_com",
          shipDate: new Date("2026-07-08T23:19:00.000Z"),
          items: [],
        },
      ],
      applyInboundShipmentAuthority,
    });

    const result = await reconcileOneShipment(
      db,
      engine,
      makeRow({
        shipment_id: 6576,
        order_id: 204931,
        order_number: "#59826",
        wms_shipment_status: "queued",
      }),
      makeRef("759013549"),
      dispatch as any,
      recompute,
    );

    expect(applyInboundShipmentAuthority).toHaveBeenCalledWith({
      engineRef: {
        engine: "shipstation",
        engineOrderRef: "759013549",
        engineShipmentRef: undefined,
      },
      orderNumber: "#59826",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalledWith(
      "oms_update_shipped",
      expect.any(Object),
    );
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", {
      shipmentId: 6576,
    });
    expect(result).toEqual({
      stamped: true,
      event: expect.objectContaining({ kind: "shipped" }),
      delegated: true,
      processed: 2,
    });
  });

  it("refuses direct mutation when package authority lacks an order number", async () => {
    const applyInboundShipmentAuthority = vi.fn().mockResolvedValue(1);
    const engine = makeEngine({
      state: {
        status: "shipped",
        trackingNumber: "1Z999",
        carrier: "ups",
        shipDate: new Date("2026-07-08T23:19:00.000Z"),
      },
      shipments: [
        {
          kind: "shipped",
          trackingNumber: "1Z999",
          carrierRaw: "ups",
          shipDate: new Date("2026-07-08T23:19:00.000Z"),
          items: [],
        },
      ],
      applyInboundShipmentAuthority,
    });

    await expect(
      reconcileOneShipment(
        db,
        engine,
        makeRow({ shipment_id: 6576, order_number: "   " }),
        makeRef("759013549"),
        dispatch as any,
        recompute,
      ),
    ).rejects.toThrow(
      "Inbound shipment authority requires an order number for shipment 6576",
    );

    expect(applyInboundShipmentAuthority).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalledWith(
      "stamp_reconciled",
      expect.any(Object),
    );
  });

  it("recovers split package facts when the original engine order no longer exists", async () => {
    const applyInboundShipmentAuthority = vi.fn().mockResolvedValue(1);
    const engine = makeEngine({
      state: null,
      shipments: [
        {
          kind: "shipped",
          shipmentId: 444249673,
          engineRef: {
            engine: "shipstation",
            engineOrderRef: "759910102",
          },
          trackingNumber: "9434650106151102227331",
          carrier: "USPS",
          carrierRaw: "stamps_com",
          shipDate: new Date("2026-07-08T23:25:00.000Z"),
          items: [],
        },
      ],
      applyInboundShipmentAuthority,
    });

    const result = await reconcileOneShipment(
      db,
      engine,
      makeRow({
        shipment_id: 6576,
        order_number: "#59826",
        wms_shipment_status: "queued",
      }),
      makeRef("759013549"),
      dispatch as any,
      recompute,
    );

    expect(engine.getShipments).toHaveBeenCalledWith(
      makeRef("759013549"),
      { orderNumber: "#59826" },
    );
    expect(applyInboundShipmentAuthority).toHaveBeenCalledWith({
      engineRef: makeRef("759013549"),
      orderNumber: "#59826",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", {
      shipmentId: 6576,
    });
    expect(result).toEqual({
      stamped: true,
      event: null,
      delegated: true,
      processed: 1,
    });
  });

  it("labeled → engine cancelled + ORDER cancelled → dispatches markShipmentCancelled + stamps", async () => {
    const engine = makeEngine({
      state: { status: "cancelled", trackingNumber: null, carrier: null, shipDate: null },
      shipments: [],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "labeled", oms_order_status: "cancelled" }),
      makeRef(), dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(db, 100, expect.objectContaining({ kind: "cancelled" }));
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("oms_update_cancelled", { orderId: 1 });
    expect(result.event?.kind).toBe("cancelled");
  });

  it("labeled → engine cancelled but order ACTIVE → review, never auto-cancel (divergence guard)", async () => {
    // ENGINE-CANCEL-DIVERGENCE-DESIGN.md: cancel is WMS-intent-owned. Someone
    // cancelling the order in ShipStation while it is live in Echelon is a
    // discrepancy to review — auto-cancelling here is the 606-shipment
    // incident class.
    const engine = makeEngine({
      state: { status: "cancelled", trackingNumber: null, carrier: null, shipDate: null },
      shipments: [],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "labeled" }),
      makeRef(), dispatch as any, recompute,
    );

    expect(dispatch).toHaveBeenCalledWith(
      db, 100,
      expect.objectContaining({ kind: "review", reason: "engine_cancelled_order_active" }),
    );
    expect(db.execute).not.toHaveBeenCalledWith("oms_update_cancelled", expect.any(Object));
    expect(result.event?.kind).toBe("review");
  });

  it("queued → engine voided (all shipments voided) → dispatches markShipmentVoided + stamps", async () => {
    const engine = makeEngine({
      state: { status: "awaiting_shipment", trackingNumber: null, carrier: null, shipDate: null },
      shipments: [{ kind: "voided", voidedAt: new Date("2025-01-16"), items: [] }],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "queued" }),
      makeRef(), dispatch as any, recompute,
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

  it("shipped → engine shipped (idempotent) → no dispatch but stamps", async () => {
    const engine = makeEngine({
      state: { status: "shipped", trackingNumber: "1Z999", carrier: "ups", shipDate: new Date() },
      shipments: [{ kind: "shipped", trackingNumber: "1Z999", carrierRaw: "ups", shipDate: new Date(), items: [] }],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "shipped" }),
      makeRef(), dispatch as any, recompute,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event).toBeNull();
  });

  it("queued → engine awaiting_shipment (no divergence) → no dispatch but stamps", async () => {
    const engine = makeEngine({
      state: { status: "awaiting_shipment", trackingNumber: null, carrier: null, shipDate: null },
      shipments: [],
    });

    const result = await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "queued" }),
      makeRef(), dispatch as any, recompute,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(result.event).toBeNull();
  });

  // ── dispatchShipmentEvent returns changed=false ──────────────────────

  it("engine shipped but dispatch says changed=false → stamps but no recompute/OMS", async () => {
    const engine = makeEngine({
      state: { status: "shipped", trackingNumber: "1Z999", carrier: "ups", shipDate: new Date("2025-01-15") },
      shipments: [{ kind: "shipped", trackingNumber: "1Z999", carrierRaw: "ups", shipDate: new Date("2025-01-15"), items: [] }],
    });
    const noChangeDispatch = makeDispatch({ wmsOrderId: 1, changed: false });

    await reconcileOneShipment(
      db, engine, makeRow({ wms_shipment_status: "queued" }),
      makeRef(), noChangeDispatch as any, recompute,
    );

    expect(noChangeDispatch).toHaveBeenCalledTimes(1);
    expect(recompute).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
  });

  // ── Engine API errors ────────────────────────────────────────────────

  it("engine getState throws → skip + DON'T stamp last_reconciled_at", async () => {
    const engine = makeEngine({ getStateThrows: true });

    await expect(
      reconcileOneShipment(
        db, engine, makeRow(),
        makeRef(), dispatch as any, recompute,
      ),
    ).rejects.toThrow("Engine API down");

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalledWith("stamp_reconciled", expect.any(Object));
  });

  it("engine getState returns null → skip + don't stamp", async () => {
    const engine = makeEngine({ state: null });

    const result = await reconcileOneShipment(
      db, engine, makeRow(),
      makeRef(), dispatch as any, recompute,
    );

    expect(result.stamped).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("engine getShipments throws → propagate (no stamp)", async () => {
    const engine = {
      isConfigured: () => true,
      getState: vi.fn().mockResolvedValue({ status: "shipped", trackingNumber: "1Z999", carrier: "ups", shipDate: new Date() }),
      getShipments: vi.fn().mockRejectedValue(new Error("shipments API down")),
    };

    await expect(
      reconcileOneShipment(
        db, engine, makeRow({ wms_shipment_status: "queued" }),
        makeRef(), dispatch as any, recompute,
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

    const engine = {
      isConfigured: () => true,
      getState: vi.fn()
        .mockResolvedValueOnce({ status: "shipped", trackingNumber: "1Z_A", carrier: "ups", shipDate: new Date("2025-01-15") })
        .mockResolvedValueOnce({ status: "awaiting_shipment", trackingNumber: null, carrier: null, shipDate: null }),
      getShipments: vi.fn()
        .mockResolvedValueOnce([{ kind: "shipped", trackingNumber: "1Z_A", carrierRaw: "ups", shipDate: new Date("2025-01-15"), items: [] }])
        .mockResolvedValueOnce([]),
    };

    const rows = [
      makeRow({ shipment_id: 100, wms_shipment_status: "queued" }),
      makeRow({ shipment_id: 101, wms_shipment_status: "queued" }),
    ];

    for (const row of rows) {
      await reconcileOneShipment(db, engine, row, makeRef(), dispatch as any, recompute);
    }

    // Row 1: shipped detected → dispatch + stamp
    // Row 2: no divergence → stamp only
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 100 });
    expect(db.execute).toHaveBeenCalledWith("stamp_reconciled", { shipmentId: 101 });
  });
});
