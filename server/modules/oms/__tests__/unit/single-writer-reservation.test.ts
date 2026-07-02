import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P0.1a — SINGLE-WRITER RESERVATION source invariants.
 *
 * These are structural guards (same pattern as c2-tx-aware-pipeline.test.ts):
 * they pin the source so the double-reservation bug class cannot silently
 * return. Root cause (prod-confirmed 2026-07-02): reservations were written
 * from TWO id schemes — OMS-side reserveInventory keyed by
 * (oms_order_id, oms_order_line_id) and WMS sync keyed by
 * (wms_order_id, wms_order_item_id) — which the per-item dedup cannot match,
 * so orders double-reserved and the OMS-keyed half leaked forever.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

const OMS_SERVICE_SRC = read("../../oms.service.ts");
const WMS_SYNC_SRC = read("../../wms-sync.service.ts");
const RESERVATION_SRC = read("../../../channels/reservation.service.ts");
const DROPSHIP_ACCEPT_SRC = read(
  "../../../dropship/infrastructure/dropship-order-acceptance.repository.ts",
);
const INVENTORY_CORE_SRC = read(
  "../../../inventory/application/inventory.use-cases.ts",
);
const INDEX_SRC = readFileSync(
  resolve(__dirname, "../../../../index.ts"),
  "utf8",
);
const FLOW_RECON_SRC = read("../../oms-flow-reconciliation.service.ts");

describe("P0.1a — single reservation writer", () => {
  it("OMS reserveInventory delegates to the WMS path and never reserves with OMS line ids", () => {
    // The delegation call:
    expect(OMS_SERVICE_SRC).toContain("reservationService.reserveOrder(Number(wmsOrder.id))");
    // The old OMS-keyed per-line reserve is gone:
    expect(OMS_SERVICE_SRC).not.toContain("reservationService.reserveForOrder(");
  });

  it("dropship acceptance validates availability but writes no reservation", () => {
    expect(DROPSHIP_ACCEPT_SRC).toContain("validateInventoryAvailability(");
    expect(DROPSHIP_ACCEPT_SRC).not.toContain("reserved_qty = reserved_qty +");
    expect(DROPSHIP_ACCEPT_SRC).not.toMatch(/transaction_type[^\n]*'reserve'/);
  });

  it("WMS sync reserves via reserveOrder(wmsOrderId) — the one writer", () => {
    expect(WMS_SYNC_SRC).toContain("this.services.reservation.reserveOrder(wmsOrderId)");
  });
});

describe("P0.1b — atomic reserve + ledger-recorded quantities", () => {
  it("reserveForOrder serializes per product via advisory xact lock 918410", () => {
    expect(RESERVATION_SRC).toContain("RESERVATION_LOCK_NS = 918410");
    expect(RESERVATION_SRC).toContain("pg_advisory_xact_lock(${RESERVATION_LOCK_NS}, ${productId})");
  });

  it("reserve, unreserve and pick all record reserved_qty_delta on the ledger", () => {
    expect(INVENTORY_CORE_SRC).toContain("reservedQtyDelta: params.qty");
    expect(INVENTORY_CORE_SRC).toContain("reservedQtyDelta: -params.qty");
    expect(INVENTORY_CORE_SRC).toContain(
      "reservedQtyDelta: reservationRelease > 0 ? -reservationRelease : 0",
    );
  });

  it("release is ledger-driven (order-scoped), not order-quantity-driven", () => {
    expect(RESERVATION_SRC).toContain("SUM(reserved_qty_delta)");
    expect(RESERVATION_SRC).toContain("openQty");
  });

  it("the phantom inventoryCore.adjustLevel call is gone (audit F8b)", () => {
    expect(RESERVATION_SRC).not.toContain("inventoryCore.adjustLevel(");
    expect(RESERVATION_SRC).toContain("trimOrphanedReservation");
    expect(INVENTORY_CORE_SRC).toContain("async trimOrphanedReservation(");
  });
});

describe("P0.1c — cancels release, shortfalls hold, detector re-reserves", () => {
  it("wms-sync cancels via the single entrypoint (release + guarded transition)", () => {
    expect(WMS_SYNC_SRC).toContain("cancelWmsOrderAndRelease");
  });

  it("the hourly OMS↔WMS sweep cancels via the single entrypoint", () => {
    expect(INDEX_SRC).toContain("cancelWmsOrderAndRelease(db, services.reservation");
  });

  it("flow reconciliation releases reservations after reconcile-cancels", () => {
    expect(FLOW_RECON_SRC).toContain("releaseOrderReservation(");
    expect(FLOW_RECON_SRC).toContain("cancelledByThisRemediation");
  });

  it("reservation shortfall holds the order and skips the engine push", () => {
    expect(WMS_SYNC_SRC).toContain("reserveWithShortfallGuard");
    expect(WMS_SYNC_SRC).toContain("SET on_hold = 1");
    expect(WMS_SYNC_SRC).toContain("reservationShortfall");
  });

  it("the ready-but-unreserved detector exists and is wired into the sweep", () => {
    expect(FLOW_RECON_SRC).toContain("remediateMissingReservations(dbArg)");
    expect(FLOW_RECON_SRC).toContain("warehouse_status = 'ready'");
  });
});
