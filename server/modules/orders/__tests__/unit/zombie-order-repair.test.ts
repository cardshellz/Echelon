import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cancel-wms-order", () => ({
  cancelWmsOrderAndRelease: vi.fn(async () => ({ transitioned: true, releasedItems: 1, releaseFailed: false })),
  completeWmsOrderAndRelease: vi.fn(async () => ({ transitioned: true, releasedItems: 0, releaseFailed: false })),
}));

import { cancelWmsOrderAndRelease, completeWmsOrderAndRelease } from "../../cancel-wms-order";
import {
  decideZombieRepairAction,
  runStartupZombieOrderRepair,
  ZOMBIE_REPAIR_REASON,
  ZOMBIE_REPAIR_SKIPPED_CODE,
} from "../../zombie-order-repair";
import { hasLiveOmsDemandNotCarriedByWms } from "../../wms-terminal-transition-guard";

const reservation = { releaseOrderReservation: vi.fn() } as any;

function fakeDb(rows: unknown[]) {
  return { execute: vi.fn(async () => ({ rows })) };
}

describe("startup zombie-order repair", () => {
  beforeEach(() => {
    vi.mocked(cancelWmsOrderAndRelease).mockClear();
    vi.mocked(completeWmsOrderAndRelease).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("decides terminal transitions only when the OMS owes nothing more", () => {
    expect(decideZombieRepairAction({ targetStatus: "cancelled", omsStillOwesUnmaterializedUnits: false })).toBe("cancel");
    expect(decideZombieRepairAction({ targetStatus: "completed", omsStillOwesUnmaterializedUnits: false })).toBe("complete");
    expect(decideZombieRepairAction({ targetStatus: "cancelled", omsStillOwesUnmaterializedUnits: true })).toBe("skip_oms_still_owes");
    expect(decideZombieRepairAction({ targetStatus: "completed", omsStillOwesUnmaterializedUnits: true })).toBe("skip_oms_still_owes");
  });

  it("cancels or completes finished orders through the reservation-releasing helpers", async () => {
    const db = fakeDb([
      { id: 1, order_number: "#1", oms_order_id: "11", target_status: "cancelled", oms_still_owes_unmaterialized_units: false },
      { id: 2, order_number: "#2", oms_order_id: "12", target_status: "completed", oms_still_owes_unmaterialized_units: false },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 1, ZOMBIE_REPAIR_REASON);
    expect(completeWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 2, ZOMBIE_REPAIR_REASON);
    expect(summary.transitioned).toEqual(["#1→cancelled", "#2→completed"]);
    expect(summary.skipped).toEqual([]);
  });

  it("skips and reports an order whose live OMS order still owes units (#63275 shape)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = fakeDb([
      { id: 208633, order_number: "#63275", oms_order_id: "913251", target_status: "cancelled", oms_still_owes_unmaterialized_units: true },
      { id: 208700, order_number: "#63300", oms_order_id: "920000", target_status: "completed", oms_still_owes_unmaterialized_units: true },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).not.toHaveBeenCalled();
    expect(completeWmsOrderAndRelease).not.toHaveBeenCalled();
    expect(summary.transitioned).toEqual([]);
    expect(summary.skipped.map((c) => c.wmsOrderId)).toEqual([208633, 208700]);
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      level: "error",
      code: ZOMBIE_REPAIR_SKIPPED_CODE,
      outcome: "skipped",
      context: { wms_order_id: 208633, oms_order_id: 913251, order_number: "#63275" },
    });
  });

  it("does not report a transition the helper declined", async () => {
    vi.mocked(cancelWmsOrderAndRelease).mockResolvedValueOnce({ transitioned: false, releasedItems: 0, releaseFailed: false } as any);
    const db = fakeDb([
      { id: 3, order_number: "#3", oms_order_id: null, target_status: "cancelled", oms_still_owes_unmaterialized_units: false },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(summary.transitioned).toEqual([]);
  });

  it("treats a malformed OMS link as unlinked rather than trusting it", async () => {
    const db = fakeDb([
      { id: 4, order_number: null, oms_order_id: "not-a-number", target_status: "cancelled", oms_still_owes_unmaterialized_units: false },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 4, ZOMBIE_REPAIR_REASON);
    expect(summary.transitioned).toEqual(["4→cancelled"]);
  });
});

describe("terminal-transition guard", () => {
  it("reports live OMS demand only when the guard query says so", async () => {
    expect(await hasLiveOmsDemandNotCarriedByWms(fakeDb([{ owes: true }]), 1)).toBe(true);
    expect(await hasLiveOmsDemandNotCarriedByWms(fakeDb([{ owes: false }]), 1)).toBe(false);
    expect(await hasLiveOmsDemandNotCarriedByWms(fakeDb([]), 1)).toBe(false);
  });

  it("guards the pick-queue zero-shippable self-heal before it completes an order", () => {
    const source = readFileSync(resolve(__dirname, "../../orders.storage.ts"), "utf8");
    const guard = source.indexOf("hasLiveOmsDemandNotCarriedByWms(db, order.id)");
    const complete = source.indexOf('"self_heal_zero_shippable"');

    expect(guard).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(guard);
  });
});
