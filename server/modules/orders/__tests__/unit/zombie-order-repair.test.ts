import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../cancel-wms-order", () => ({
  cancelWmsOrderAndRelease: vi.fn(async () => ({ transitioned: true, releasedItems: 1, releaseFailed: false })),
  completeWmsOrderAndRelease: vi.fn(async () => ({ transitioned: true, releasedItems: 0, releaseFailed: false })),
}));

import { logger } from "../../../../platform/observability/logger";
import { cancelWmsOrderAndRelease, completeWmsOrderAndRelease } from "../../cancel-wms-order";
import {
  decideZombieRepairAction,
  OMS_STILL_OWES_UNCARRIED_UNITS_FOR_WMS_ORDER_O,
  runStartupZombieOrderRepair,
  ZOMBIE_REPAIR_REASON,
  ZOMBIE_REPAIR_SKIPPED_CODE,
} from "../../zombie-order-repair";

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
    expect(decideZombieRepairAction({ targetStatus: "cancelled", omsStillOwesUncarriedUnits: false })).toBe("cancel");
    expect(decideZombieRepairAction({ targetStatus: "completed", omsStillOwesUncarriedUnits: false })).toBe("complete");
    expect(decideZombieRepairAction({ targetStatus: "cancelled", omsStillOwesUncarriedUnits: true })).toBe("skip_oms_still_owes");
    expect(decideZombieRepairAction({ targetStatus: "completed", omsStillOwesUncarriedUnits: true })).toBe("skip_oms_still_owes");
  });

  it("cancels or completes finished orders through the reservation-releasing helpers", async () => {
    const db = fakeDb([
      { id: 1, order_number: "#1", target_status: "cancelled", oms_still_owes_uncarried_units: false },
      { id: 2, order_number: "#2", target_status: "completed", oms_still_owes_uncarried_units: false },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 1, ZOMBIE_REPAIR_REASON);
    expect(completeWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 2, ZOMBIE_REPAIR_REASON);
    expect(summary.transitioned).toEqual(["#1→cancelled", "#2→completed"]);
    expect(summary.skipped).toEqual([]);
  });

  it("skips and reports an order whose live OMS order still owes units (#63861 shape)", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const db = fakeDb([
      { id: 209282, order_number: "#63861", target_status: "cancelled", oms_still_owes_uncarried_units: true },
      { id: 208700, order_number: "#63300", target_status: "completed", oms_still_owes_uncarried_units: true },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).not.toHaveBeenCalled();
    expect(completeWmsOrderAndRelease).not.toHaveBeenCalled();
    expect(summary.transitioned).toEqual([]);
    expect(summary.skipped.map((candidate) => candidate.wmsOrderId)).toEqual([209282, 208700]);
    expect(errorSpy).toHaveBeenCalledWith("wms_zombie_order_repair", expect.objectContaining({
      outcome: "skipped",
      error_code: ZOMBIE_REPAIR_SKIPPED_CODE,
      wms_order_id: 209282,
      order_number: "#63861",
      target_status: "cancelled",
    }));
  });

  it("only trusts an explicit true from the guard column", async () => {
    const db = fakeDb([
      { id: 5, order_number: "#5", target_status: "cancelled", oms_still_owes_uncarried_units: null },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(cancelWmsOrderAndRelease).toHaveBeenCalledWith(db, reservation, 5, ZOMBIE_REPAIR_REASON);
    expect(summary.transitioned).toEqual(["#5→cancelled"]);
  });

  it("does not report a transition the helper declined", async () => {
    vi.mocked(cancelWmsOrderAndRelease).mockResolvedValueOnce(
      { transitioned: false, releasedItems: 0, releaseFailed: false } as any,
    );
    const db = fakeDb([
      { id: 3, order_number: "#3", target_status: "cancelled", oms_still_owes_uncarried_units: false },
    ]);

    const summary = await runStartupZombieOrderRepair({ db, reservation });

    expect(summary.transitioned).toEqual([]);
  });
});

describe("live-OMS-demand guard SQL", () => {
  const rendered = new PgDialect().sqlToQuery(OMS_STILL_OWES_UNCARRIED_UNITS_FOR_WMS_ORDER_O).sql;

  it("binds the WMS order to its OMS order through the canonical link", () => {
    expect(rendered).toContain("WHEN o.source = 'oms'");
    expect(rendered).toContain("o.oms_fulfillment_order_id");
    expect(rendered).toContain("o.source_table_id");
  });

  it("ignores final OMS orders and lines that need no shipment", () => {
    expect(rendered).toContain("oo.status NOT IN ('cancelled', 'refunded', 'shipped')");
    expect(rendered).toContain("NOT IN ('refunded', 'voided')");
    expect(rendered).toContain("ol.requires_shipping IS DISTINCT FROM false");
  });

  it("compares OMS authority with non-cancelled WMS units across every WMS order", () => {
    expect(rendered).toMatch(
      /COALESCE\(ol\.authority_fulfillable_quantity, 0\) > COALESCE\(\(\s*SELECT SUM\(wi\.quantity\)\s*FROM wms\.order_items wi\s*WHERE wi\.oms_order_line_id = ol\.id\s*AND wi\.status <> 'cancelled'/,
    );
  });
});
