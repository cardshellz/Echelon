import { describe, it, expect, vi } from "vitest";
import { completeWmsOrderAndRelease } from "../../cancel-wms-order";

/**
 * 'completed'-status fix (2026-07) — terminal-complete twin of the P0.1c
 * cancel entrypoint.
 *
 * 'completed' = all warehouse work done (every shippable item picked, short,
 * or cancelled). Picked units consumed their reservations at pick time, so
 * whatever the order-scoped ledger still holds is short/cancelled residue
 * that can never be consumed — it must be released on entry or it leaks
 * forever (the #55xxx cluster held 200+ phantom units this way).
 *
 * Invariants:
 *  1. A successful completion ALWAYS attempts the reservation release.
 *  2. A blocked transition (already completed/shipped/cancelled) releases
 *     NOTHING — the first completion already released.
 *  3. A release failure never rolls back the completion.
 */

function makeDb(executeResponses: any[]) {
  const q = [...executeResponses];
  return {
    execute: vi.fn(async () => (q.length > 0 ? q.shift()! : { rows: [] })),
  } as any;
}

describe("completeWmsOrderAndRelease", () => {
  it("releases leftover reservations after a successful completion", async () => {
    const db = makeDb([
      { rows: [{ new_status: "completed" }] }, // guarded UPDATE ... RETURNING
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 3, failed: [] })),
    };

    const outcome = await completeWmsOrderAndRelease(db, reservation, 59539, "self_heal_zero_shippable");

    expect(outcome.transitioned).toBe(true);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      59539,
      "self_heal_zero_shippable",
      undefined,
    );
    expect(outcome.releasedItems).toBe(3);
    expect(outcome.releaseFailed).toBe(false);
  });

  it("does NOT release when the transition is blocked (already completed)", async () => {
    const db = makeDb([
      { rows: [] },                                      // guarded UPDATE: no row
      { rows: [{ warehouse_status: "completed" }] },     // getCurrentStatus
    ]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 0, failed: [] })),
    };

    const outcome = await completeWmsOrderAndRelease(db, reservation, 59539, "re-run");

    expect(outcome.transitioned).toBe(false);
    expect(reservation.releaseOrderReservation).not.toHaveBeenCalled();
  });

  it("surfaces release failure without undoing the completion", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb([{ rows: [{ new_status: "completed" }] }]);
    const reservation = {
      releaseOrderReservation: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const outcome = await completeWmsOrderAndRelease(db, reservation, 59539, "self_heal");

    expect(outcome.transitioned).toBe(true); // completion stands
    expect(outcome.releaseFailed).toBe(true);
    errSpy.mockRestore();
  });
});
