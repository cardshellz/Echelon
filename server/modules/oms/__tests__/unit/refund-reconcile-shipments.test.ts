/**
 * Unit tests for `applyRefundLineAdjustmentsToWms` — the Phase 1c rewrite that
 * reconciles PRE-SHIP shipments to a refund WITHOUT ever "holding" them.
 *
 * A refund is a PAYMENT state, not a fulfillment action. After reducing the
 * affected line-item quantities, each affected pre-ship shipment is reconciled
 * to physical reality:
 *   - empty (all items refunded) -> cancel the shipment (+ engine cancel)
 *   - queued, items remain       -> re-push the SS order with reduced contents
 *   - labeled, items remain      -> flag for review (operator must find the package)
 *   - planned, items remain      -> nothing (qty already reduced; never pushed)
 * It must NEVER write status='on_hold' or held=true.
 *
 * Standards: coding-standards Rule #6 (idempotent retry-safety), Rule #9
 * (happy + edge cases), Rule #13 (__test__ escape hatch).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Import-time safety: oms-webhooks transitively imports server/db.
vi.mock("../../../../db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    execute: async () => ({ rows: [] }),
  },
}));

// The reconcile loop dynamically imports these from shipment-rollup. Mock so we
// can assert calls without driving their real query sequences.
vi.mock("../../../orders/shipment-rollup", () => ({
  markShipmentCancelled: vi.fn(async () => undefined),
  recomputeOrderStatusFromShipments: vi.fn(async () => undefined),
}));

import { __test__ } from "../../oms-webhooks";
import * as rollup from "../../../orders/shipment-rollup";

const { applyRefundLineAdjustmentsToWms } = __test__;
const markCancelled = rollup.markShipmentCancelled as unknown as ReturnType<typeof vi.fn>;
const recompute = rollup.recomputeOrderStatusFromShipments as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-06-20T12:00:00Z");
const ADJ = [{ externalLineItemId: "L1", quantity: 1, restockPolicy: "cancel" as const }];

// Flatten a drizzle sql object's chunks (static text + bound param values) so we
// can assert on both the SQL shape and the bound review_reason.
function qtext(q: any): string {
  return (q?.queryChunks ?? [])
    .flatMap((c: any) => {
      if (c == null) return [];
      if (typeof c === "string") return [c];
      if (Array.isArray(c.value)) return c.value;
      if (c.value !== undefined) return [String(c.value)];
      return [];
    })
    .join(" ");
}

function makeDb(scripted: Array<{ rows: any[] }>) {
  const calls: any[] = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (query: any) => {
    calls.push(query);
    return remaining.length ? remaining.shift()! : { rows: [] };
  });
  return { db: { execute } as any, execute, calls };
}

const shipment = (over: Record<string, any>) => ({
  id: 0,
  status: "queued",
  shipping_engine: "shipstation",
  engine_order_ref: "SO-1",
  engine_shipment_ref: null,
  shipstation_order_id: 555,
  shipstation_order_key: "echelon-wms-shp-0",
  remaining_qty: 1,
  ...over,
});

// Asserts the handler never regressed a shipment to a hold.
function expectNoHoldWrites(calls: any[]) {
  for (const c of calls) {
    const t = qtext(c);
    expect(t).not.toMatch(/on_hold/);
    expect(t).not.toMatch(/held\s*=\s*true/);
  }
}

describe("applyRefundLineAdjustmentsToWms (Phase 1c reconcile)", () => {
  beforeEach(() => {
    markCancelled.mockClear();
    recompute.mockClear();
  });

  it("early-returns with zeroed counts when there are no adjustments", async () => {
    const mock = makeDb([]);
    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: [],
      now: NOW,
    });
    expect(res).toEqual({ adjustedLines: 0, cancelledShipments: 0, repushedShipments: 0, flaggedShipments: 0 });
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("queued shipment with items remaining -> re-pushes, never holds", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] }, // quantity CTE (adjustedLines)
      { rows: [shipment({ id: 10, status: "queued", remaining_qty: 2 })] }, // affected
    ]);
    const pushShipment = vi.fn(async () => undefined);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
    });

    expect(pushShipment).toHaveBeenCalledExactlyOnceWith(10);
    expect(markCancelled).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ repushedShipments: 1, cancelledShipments: 0, flaggedShipments: 0 });
    expectNoHoldWrites(mock.calls);
  });

  it("queued shipment but no pushShipment wired -> flags for review", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      { rows: [shipment({ id: 10, status: "queued", remaining_qty: 2 })] },
      { rows: [] }, // flagForReview UPDATE
    ]);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
    });

    const flag = mock.calls[2];
    expect(qtext(flag)).toMatch(/requires_review\s*=\s*true/);
    expect(qtext(flag)).toContain("refund_repush_unavailable");
    expect(res).toMatchObject({ flaggedShipments: 1, repushedShipments: 0 });
    expectNoHoldWrites(mock.calls);
  });

  it("labeled shipment with items remaining -> flags 'refund_after_label', no re-push", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      { rows: [shipment({ id: 11, status: "labeled", remaining_qty: 1 })] },
      { rows: [] }, // flagForReview UPDATE
    ]);
    const pushShipment = vi.fn(async () => undefined);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
    });

    expect(pushShipment).not.toHaveBeenCalled();
    expect(markCancelled).not.toHaveBeenCalled();
    const flag = mock.calls[2];
    expect(qtext(flag)).toMatch(/requires_review\s*=\s*true/);
    expect(qtext(flag)).toContain("refund_after_label");
    expect(res).toMatchObject({ flaggedShipments: 1 });
    expectNoHoldWrites(mock.calls);
  });

  it("emptied shipment (all items refunded) -> cancels (+engine) and recomputes the order", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      { rows: [shipment({ id: 12, status: "queued", remaining_qty: 0 })] },
    ]);
    const pushShipment = vi.fn(async () => undefined);
    const shippingEngine = { cancel: vi.fn(async () => undefined) };
    const shipstation = { cancelOrder: vi.fn(async () => undefined) };

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
      shippingEngine,
      shipstation,
    });

    expect(markCancelled).toHaveBeenCalledTimes(1);
    expect(markCancelled.mock.calls[0][1]).toBe(12);
    expect(markCancelled.mock.calls[0][2]).toBe("refund_fully_cancelled");
    expect(typeof markCancelled.mock.calls[0][3].engineCancel).toBe("function");
    expect(pushShipment).not.toHaveBeenCalled();
    expect(recompute).toHaveBeenCalledTimes(1); // cancels changed status -> rollup
    expect(res).toMatchObject({ cancelledShipments: 1, repushedShipments: 0, flaggedShipments: 0 });
    expectNoHoldWrites(mock.calls);
  });

  it("planned shipment with items remaining -> qty reduced only, no further action", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      { rows: [shipment({ id: 13, status: "planned", remaining_qty: 3, engine_order_ref: null, shipstation_order_id: null })] },
    ]);
    const pushShipment = vi.fn(async () => undefined);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
    });

    expect(pushShipment).not.toHaveBeenCalled();
    expect(markCancelled).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ cancelledShipments: 0, repushedShipments: 0, flaggedShipments: 0 });
    expect(mock.execute).toHaveBeenCalledTimes(2); // qty + affected only
    expectNoHoldWrites(mock.calls);
  });

  it("multi-shipment order: each affected shipment reconciled independently", async () => {
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      {
        rows: [
          shipment({ id: 20, status: "queued", remaining_qty: 2 }),
          shipment({ id: 21, status: "labeled", remaining_qty: 1 }),
          shipment({ id: 22, status: "queued", remaining_qty: 0 }),
        ],
      },
      { rows: [] }, // flag UPDATE for the labeled one
    ]);
    const pushShipment = vi.fn(async () => undefined);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
      shippingEngine: { cancel: vi.fn(async () => undefined) },
    });

    expect(pushShipment).toHaveBeenCalledExactlyOnceWith(20);
    expect(markCancelled).toHaveBeenCalledTimes(1);
    expect(markCancelled.mock.calls[0][1]).toBe(22);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ repushedShipments: 1, flaggedShipments: 1, cancelledShipments: 1 });
    expectNoHoldWrites(mock.calls);
  });

  it("one shipment failing does not abort the others (best-effort + flag)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // markShipmentCancelled throws for the empty one; the queued one must still re-push.
    markCancelled.mockRejectedValueOnce(new Error("engine down"));
    const mock = makeDb([
      { rows: [{ id: 1 }] },
      {
        rows: [
          shipment({ id: 30, status: "queued", remaining_qty: 0 }), // will throw in cancel
          shipment({ id: 31, status: "queued", remaining_qty: 2 }),
        ],
      },
      { rows: [] }, // flagForReview('refund_reconcile_failed') for #30
    ]);
    const pushShipment = vi.fn(async () => undefined);

    const res = await applyRefundLineAdjustmentsToWms(mock.db, {
      wmsOrderId: 42,
      adjustments: ADJ,
      now: NOW,
      pushShipment,
      shippingEngine: { cancel: vi.fn(async () => undefined) },
    });

    expect(pushShipment).toHaveBeenCalledExactlyOnceWith(31);
    expect(res.repushedShipments).toBe(1);
    expect(res.flaggedShipments).toBe(1); // the failed cancel fell back to a flag
    expect(qtext(mock.calls[2])).toContain("refund_reconcile_failed");
    expectNoHoldWrites(mock.calls);
    errSpy.mockRestore();
  });
});
