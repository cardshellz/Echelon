import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for order #63275 (2026-09-18): a transient authority drop
// cancelled a never-picked WMS line, and nothing restored it when authority
// recovered because every reconcile path skipped cancelled rows while still
// counting them as present.

const txExecute = vi.fn();
const tx = { execute: txExecute };

vi.mock("../../../../db", () => ({
  db: {
    transaction: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
  },
}));

vi.mock("../../../wms/order-item-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../wms/order-item-commands")>()),
  reconcileWmsOrderItemAuthority: vi.fn(async () => ({ status: "pending" })),
}));

import { db } from "../../../../db";
import { reconcileWmsOrderItemAuthority } from "../../../wms/order-item-commands";
import { WmsSyncService } from "../../wms-sync.service";

interface RestoreHarness {
  restoreCancelledLineForRecoveredAuthority(args: {
    omsOrderId: number;
    wmsOrderId: number;
    wmsItem: {
      id: number;
      omsOrderLineId: number | null;
      sku: string | null;
      pickedQuantity: number | null;
      fulfilledQuantity: number | null;
    };
    omsLine: {
      quantity?: number | null;
      authorityFulfillableQuantity?: number | null;
      wmsMaterializedQuantity?: number | null;
    } | undefined;
  }): Promise<void>;
  lockOmsLinesForMaterialization: ReturnType<typeof vi.fn>;
  incrementOmsLineMaterializedQuantities: ReturnType<typeof vi.fn>;
  recordWmsReconciliationAuditEvent: ReturnType<typeof vi.fn>;
  recordWmsReconciliationReviewException: ReturnType<typeof vi.fn>;
  reconcileOrderDemand: ReturnType<typeof vi.fn>;
}

const OMS_ORDER_ID = 913251;
const WMS_ORDER_ID = 208633;
const LINE_ID = 119132;
const ITEM_ID = 321488;

const cancelledItem = {
  id: ITEM_ID,
  omsOrderLineId: LINE_ID,
  sku: "SHLZ-TOP-35PT-CLR-P25",
  pickedQuantity: 0,
  fulfilledQuantity: 0,
};

function owedLine(materialized: number) {
  return {
    id: LINE_ID,
    quantity: 15,
    authorityFulfillableQuantity: 15,
    wmsMaterializedQuantity: materialized,
  };
}

function harness(
  lockedLine: ReturnType<typeof owedLine>,
  lockedItemRow: Record<string, unknown> | null,
  reconcileOrderDemand = vi.fn(async () => ({ reconciled: true, reservation: { reserved: 1, failed: [] } })),
) {
  const service = new WmsSyncService({ reservation: { reconcileOrderDemand } } as any) as unknown as RestoreHarness;
  service.reconcileOrderDemand = reconcileOrderDemand;
  service.lockOmsLinesForMaterialization = vi.fn(async () => [lockedLine]);
  service.incrementOmsLineMaterializedQuantities = vi.fn(async () => undefined);
  service.recordWmsReconciliationAuditEvent = vi.fn(async () => undefined);
  service.recordWmsReconciliationReviewException = vi.fn(async () => undefined);
  txExecute
    .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
    .mockResolvedValueOnce({ rows: lockedItemRow ? [lockedItemRow] : [] }); // item FOR UPDATE
  return service;
}

const CANCELLED_ROW = { status: "cancelled", quantity: 0, picked_quantity: 0, fulfilled_quantity: 0 };

describe("WMS sync restores lines cancelled by a transient authority drop", () => {
  beforeEach(() => {
    txExecute.mockReset();
    vi.mocked(reconcileWmsOrderItemAuthority).mockClear();
    vi.mocked(db.transaction).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("restores a cancelled, never-picked line to the owed quantity with an audit event", async () => {
    const service = harness(owedLine(0), CANCELLED_ROW);

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledWith(tx, {
      itemId: ITEM_ID,
      orderId: WMS_ORDER_ID,
      authorityQuantity: 15,
    });
    expect(service.incrementOmsLineMaterializedQuantities).toHaveBeenCalledWith(tx, [
      { omsOrderLineId: LINE_ID, quantity: 15 },
    ]);
    expect(service.recordWmsReconciliationAuditEvent).toHaveBeenCalledWith(
      tx,
      OMS_ORDER_ID,
      "restore_cancelled_line_for_recovered_authority",
      expect.objectContaining({
        wmsOrderId: WMS_ORDER_ID,
        wmsOrderItemId: ITEM_ID,
        omsOrderLineId: LINE_ID,
        before: { status: "cancelled", quantity: 0 },
        after: { status: "pending", quantity: 15 },
      }),
    );
    // Claim is reconciled after commit, outside the restore transaction: the
    // canonical claim service rejects a joined (dbOverride) transaction.
    expect(service.reconcileOrderDemand).toHaveBeenCalledTimes(1);
    const claimCommand = service.reconcileOrderDemand.mock.calls[0][0];
    expect(claimCommand).toMatchObject({
      orderId: WMS_ORDER_ID,
      sourceEventId: `wms_line_restore:${ITEM_ID}`,
      demandChanged: true,
    });
    expect(claimCommand).not.toHaveProperty("dbOverride");
  });

  it("records a durable review exception instead of throwing when the claim fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingClaim = vi.fn(async () => {
      throw Object.assign(new Error("claim store unavailable"), { code: "CANONICAL_DEMAND_RECONCILIATION_FAILED" });
    });
    const service = harness(owedLine(0), CANCELLED_ROW, failingClaim);

    await expect(service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    })).resolves.toBeUndefined();

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledTimes(1);
    expect(service.recordWmsReconciliationReviewException).toHaveBeenCalledWith(db, expect.objectContaining({
      rule: "restored_line_inventory_claim_not_reconciled",
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsOrderItemId: ITEM_ID,
      reviewMessage: "claim store unavailable",
    }));
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      level: "error",
      code: "WMS_LINE_RESTORE_CLAIM_NOT_RECONCILED",
      error_code: "CANONICAL_DEMAND_RECONCILIATION_FAILED",
    });
  });

  it("restores only the unmaterialized remainder when another partition carries part of the line", async () => {
    const service = harness(owedLine(10), CANCELLED_ROW);

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(10),
    });

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledWith(tx, expect.objectContaining({
      authorityQuantity: 5,
    }));
  });

  it("never touches a line that was ever picked or fulfilled", async () => {
    const service = harness(owedLine(0), CANCELLED_ROW);

    for (const progress of [{ pickedQuantity: 3 }, { fulfilledQuantity: 1 }]) {
      await service.restoreCancelledLineForRecoveredAuthority({
        omsOrderId: OMS_ORDER_ID,
        wmsOrderId: WMS_ORDER_ID,
        wmsItem: { ...cancelledItem, ...progress },
        omsLine: owedLine(0),
      });
    }

    expect(db.transaction).not.toHaveBeenCalled();
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(service.reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("does nothing when OMS no longer owes anything for the line", async () => {
    const service = harness(owedLine(15), CANCELLED_ROW);

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: { ...owedLine(0), authorityFulfillableQuantity: 0 },
    });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("re-checks under lock and skips when a concurrent sync already restored the line", async () => {
    const service = harness(owedLine(0), { ...CANCELLED_ROW, status: "pending", quantity: 15 });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(service.recordWmsReconciliationAuditEvent).not.toHaveBeenCalled();
    expect(service.reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("skips when the owed remainder is gone by the time the lock is held", async () => {
    const service = harness(owedLine(15), CANCELLED_ROW);

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
  });
});
