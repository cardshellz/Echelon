import { describe, it, expect, vi } from "vitest";
import { cancelWmsOrderAndRelease } from "../../cancel-wms-order";

/**
 * P0.1c — the single WMS-order cancel entrypoint.
 *
 * Invariants under test:
 *  1. A successful cancel ALWAYS attempts the reservation release
 *     (pre-P0.1, reconciler cancels were status-only and leaked reservations).
 *  2. A blocked transition (already shipped/cancelled) releases NOTHING —
 *     a shipped order's reservations were consumed by its picks.
 *  3. A release failure never rolls back the cancel; it surfaces as
 *     releaseFailed for requires_review handling.
 */

function makeDb(executeResponses: any[]) {
  const q = [...executeResponses];
  return {
    execute: vi.fn(async () => (q.length > 0 ? q.shift()! : { rows: [] })),
  } as any;
}

describe("cancelWmsOrderAndRelease (P0.1c)", () => {
  it("releases reservations after a successful cancel", async () => {
    const db = makeDb([
      { rows: [{ new_status: "cancelled" }] }, // guarded UPDATE ... RETURNING
      { rows: [] },                            // picker clear
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 2, failed: [] })),
    };

    const outcome = await cancelWmsOrderAndRelease(db, reservation, 42, "test_reason");

    expect(outcome.transitioned).toBe(true);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledTimes(1);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(42, "test_reason", undefined);
    expect(outcome.releasedItems).toBe(2);
    expect(outcome.releaseFailed).toBe(false);
  });

  it("does NOT release when the transition is blocked (already shipped)", async () => {
    const db = makeDb([
      { rows: [] },                                     // guarded UPDATE: no row
      { rows: [{ warehouse_status: "shipped" }] },      // getCurrentStatus
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 0, failed: [] })),
    };

    const outcome = await cancelWmsOrderAndRelease(db, reservation, 42, "test_reason");

    expect(outcome.transitioned).toBe(false);
    expect(reservation.releaseOrderReservation).not.toHaveBeenCalled();
    expect(outcome.releasedItems).toBe(0);
  });

  it("surfaces release failure without undoing the cancel", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb([
      { rows: [{ new_status: "cancelled" }] },
      { rows: [] },
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const outcome = await cancelWmsOrderAndRelease(db, reservation, 42, "test_reason");

    expect(outcome.transitioned).toBe(true); // cancel stands
    expect(outcome.releaseFailed).toBe(true);
    errSpy.mockRestore();
  });

  it("flags partial release failures for review", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb([
      { rows: [{ new_status: "cancelled" }] },
      { rows: [] },
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({
        released: 1,
        failed: [{ sku: "SKU-A", orderItemId: 700, reason: "variant missing" }],
      })),
    };

    const outcome = await cancelWmsOrderAndRelease(db, reservation, 42, "test_reason");

    expect(outcome.releaseFailed).toBe(true);
    expect(outcome.releasedItems).toBe(1);
    errSpy.mockRestore();
  });
});
