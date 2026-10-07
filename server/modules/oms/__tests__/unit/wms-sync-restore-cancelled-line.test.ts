import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #63275 (2026-09-18) and #63861 (2026-10-06): a Shopify
// fulfillment hold (Global-e) zeroed OMS line authority, the WMS sync cancelled
// the never-picked line, and nothing restored it when the hold lifted because
// every reconcile path skipped cancelled rows while still counting them as
// present.

const h = vi.hoisted(() => {
  const txExecute = vi.fn();
  const tx = { execute: txExecute };
  const tableRows = new Map<unknown, () => unknown[]>();
  function chain(table: unknown) {
    const builder: any = {
      where: () => builder,
      limit: () => builder,
      orderBy: () => builder,
      then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
        Promise.resolve((tableRows.get(table) ?? (() => []))()).then(resolve, reject),
    };
    return builder;
  }
  const db = {
    transaction: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => ({ from: (table: unknown) => chain(table) })),
  };
  return { txExecute, tx, tableRows, db };
});

vi.mock("../../../../db", () => ({ db: h.db }));

vi.mock("../../../wms/order-item-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../wms/order-item-commands")>()),
  reconcileWmsOrderItemAuthority: vi.fn(async () => ({ status: "pending" })),
}));

import { omsOrders, omsOrderLines } from "@shared/schema/oms.schema";
import { wmsOrders, wmsOrderItems } from "@shared/schema";
import { logger } from "../../../../platform/observability/logger";
import { reconcileWmsOrderItemAuthority } from "../../../wms/order-item-commands";
import { deriveOmsLineAuthority } from "../../oms-line-authority";
import { WmsSyncService } from "../../wms-sync.service";

interface CancelledItem {
  id: number;
  omsOrderLineId: number | null;
  sku: string | null;
  pickedQuantity: number | null;
  fulfilledQuantity: number | null;
}

interface OwedLine {
  id: number;
  quantity: number;
  authorityFulfillableQuantity: number;
  wmsMaterializedQuantity: number;
}

interface Harness {
  restoreCancelledLineForRecoveredAuthority(args: {
    omsOrderId: number;
    wmsOrderId: number;
    wmsItem: CancelledItem;
    omsLine: Partial<OwedLine> | undefined;
  }): Promise<void>;
  reconcileExistingWmsOrderLines(
    omsOrderId: number,
    wmsOrderId: number,
  ): Promise<{ insertedItems: number; updatedShipments: number }>;
  refreshOmsLineMaterializedQuantities: ReturnType<typeof vi.fn>;
  lockOmsLinesForMaterialization: ReturnType<typeof vi.fn>;
  incrementOmsLineMaterializedQuantities: ReturnType<typeof vi.fn>;
  recordWmsReconciliationAuditEvent: ReturnType<typeof vi.fn>;
  recordWmsReconciliationReviewException: ReturnType<typeof vi.fn>;
}

const OMS_ORDER_ID = 913251;
const WMS_ORDER_ID = 209282;
const LINE_ID = 119132;
const ITEM_ID = 321488;
const SKU = "SHLZ-TOP-35PT-CLR-P25";

const cancelledItem: CancelledItem = {
  id: ITEM_ID,
  omsOrderLineId: LINE_ID,
  sku: SKU,
  pickedQuantity: 0,
  fulfilledQuantity: 0,
};

function owedLine(materialized: number, authority = 15): OwedLine {
  return {
    id: LINE_ID,
    quantity: 15,
    authorityFulfillableQuantity: authority,
    wmsMaterializedQuantity: materialized,
  };
}

const CANCELLED_ROW = { status: "cancelled", quantity: 0, picked_quantity: 0, fulfilled_quantity: 0 };

function harness(options: {
  lockedLine: OwedLine;
  lockedItemRow: Record<string, unknown> | null;
  reconcileOrderDemand?: ReturnType<typeof vi.fn>;
}) {
  const reconcileOrderDemand = options.reconcileOrderDemand
    ?? vi.fn(async () => ({ reconciled: true, reservation: { reserved: 1, failed: [] } }));
  const service = new WmsSyncService({ reservation: { reconcileOrderDemand } } as any) as unknown as Harness;
  service.refreshOmsLineMaterializedQuantities = vi.fn(async () => undefined);
  service.lockOmsLinesForMaterialization = vi.fn(async () => [options.lockedLine]);
  service.incrementOmsLineMaterializedQuantities = vi.fn(async () => undefined);
  service.recordWmsReconciliationAuditEvent = vi.fn(async () => undefined);
  service.recordWmsReconciliationReviewException = vi.fn(async () => undefined);
  h.txExecute
    .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
    .mockResolvedValueOnce({ rows: options.lockedItemRow ? [options.lockedItemRow] : [] }); // item FOR UPDATE
  return { service, reconcileOrderDemand };
}

beforeEach(() => {
  h.txExecute.mockReset();
  h.db.transaction.mockClear();
  h.db.execute.mockClear();
  h.tableRows.clear();
  vi.mocked(reconcileWmsOrderItemAuthority).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("WMS sync restores lines cancelled by a transient authority drop", () => {
  it("restores a cancelled, never-picked line to the owed quantity with an audit event", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { service, reconcileOrderDemand } = harness({ lockedLine: owedLine(0), lockedItemRow: CANCELLED_ROW });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledWith(h.tx, {
      itemId: ITEM_ID,
      orderId: WMS_ORDER_ID,
      authorityQuantity: 15,
    });
    expect(service.incrementOmsLineMaterializedQuantities).toHaveBeenCalledWith(h.tx, [
      { omsOrderLineId: LINE_ID, quantity: 15 },
    ]);
    expect(service.recordWmsReconciliationAuditEvent).toHaveBeenCalledWith(
      h.tx,
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
    // The claim is reconciled after commit, outside the restore transaction:
    // the canonical claim service rejects a joined (dbOverride) transaction.
    expect(reconcileOrderDemand).toHaveBeenCalledTimes(1);
    const claimCommand = reconcileOrderDemand.mock.calls[0][0];
    expect(claimCommand).toMatchObject({
      orderId: WMS_ORDER_ID,
      sourceEventId: `wms_line_restore:${ITEM_ID}`,
      demandChanged: true,
    });
    expect(claimCommand).not.toHaveProperty("dbOverride");
    expect(infoSpy).toHaveBeenCalledWith("wms_sync_restore_cancelled_line", expect.objectContaining({
      outcome: "restored",
      oms_order_id: OMS_ORDER_ID,
      wms_order_id: WMS_ORDER_ID,
      before: { status: "cancelled", quantity: 0 },
      after: { status: "pending", quantity: 15 },
    }));
  });

  it("records a durable review exception instead of throwing when the claim fails", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const failingClaim = vi.fn(async () => {
      throw Object.assign(new Error("claim store unavailable"), { code: "CANONICAL_DEMAND_RECONCILIATION_FAILED" });
    });
    const { service } = harness({
      lockedLine: owedLine(0),
      lockedItemRow: CANCELLED_ROW,
      reconcileOrderDemand: failingClaim,
    });

    await expect(service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    })).resolves.toBeUndefined();

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledTimes(1);
    expect(service.recordWmsReconciliationReviewException).toHaveBeenCalledWith(h.db, expect.objectContaining({
      rule: "restored_line_inventory_claim_not_reconciled",
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsOrderItemId: ITEM_ID,
      reviewMessage: "claim store unavailable",
    }));
    expect(errorSpy).toHaveBeenCalledWith("wms_sync_restore_cancelled_line_claim", expect.objectContaining({
      outcome: "claim_failed",
      error_class: "permanent",
      error_code: "WMS_LINE_RESTORE_CLAIM_NOT_RECONCILED",
      cause_code: "CANONICAL_DEMAND_RECONCILIATION_FAILED",
      wms_order_id: WMS_ORDER_ID,
    }));
  });

  it("restores only the unmaterialized remainder when another partition carries part of the line", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { service } = harness({ lockedLine: owedLine(10), lockedItemRow: CANCELLED_ROW });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(10),
    });

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledWith(h.tx, expect.objectContaining({
      authorityQuantity: 5,
    }));
  });

  it("never touches a cancelled line that was ever picked or fulfilled", async () => {
    const { service, reconcileOrderDemand } = harness({ lockedLine: owedLine(0), lockedItemRow: CANCELLED_ROW });

    for (const progress of [{ pickedQuantity: 3 }, { fulfilledQuantity: 1 }]) {
      await service.restoreCancelledLineForRecoveredAuthority({
        omsOrderId: OMS_ORDER_ID,
        wmsOrderId: WMS_ORDER_ID,
        wmsItem: { ...cancelledItem, ...progress },
        omsLine: owedLine(0),
      });
    }

    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("re-checks progress under the row lock before restoring", async () => {
    const { service, reconcileOrderDemand } = harness({
      lockedLine: owedLine(0),
      lockedItemRow: { ...CANCELLED_ROW, picked_quantity: 1 },
    });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("does nothing when OMS no longer owes anything for the line", async () => {
    const { service } = harness({ lockedLine: owedLine(15), lockedItemRow: CANCELLED_ROW });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0, 0),
    });

    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it("skips when a concurrent sync already restored the line", async () => {
    const { service, reconcileOrderDemand } = harness({
      lockedLine: owedLine(0),
      lockedItemRow: { ...CANCELLED_ROW, status: "pending", quantity: 15 },
    });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(service.recordWmsReconciliationAuditEvent).not.toHaveBeenCalled();
    expect(reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("skips when the owed remainder is gone by the time the lock is held", async () => {
    const { service } = harness({ lockedLine: owedLine(15), lockedItemRow: CANCELLED_ROW });

    await service.restoreCancelledLineForRecoveredAuthority({
      omsOrderId: OMS_ORDER_ID,
      wmsOrderId: WMS_ORDER_ID,
      wmsItem: cancelledItem,
      omsLine: owedLine(0),
    });

    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
  });
});

// Drives the real reconcileExistingWmsOrderLines loop over a fake database: the
// line-level decision it makes for each Global-e webhook in turn.
describe("WMS line reconciliation across a Global-e hold", () => {
  const PAID_ORDER = { id: OMS_ORDER_ID, status: "confirmed", financialStatus: "paid" };
  const READY_ORDER = { warehouseStatus: "ready", channelId: 36, warehouseId: 1 };

  function seed(input: {
    authority: number;
    materialized: number;
    item: { status: string; quantity: number; pickedQuantity?: number; fulfilledQuantity?: number };
  }) {
    const line = {
      id: LINE_ID,
      quantity: 1,
      paidQuantity: 1,
      authorityFulfillableQuantity: input.authority,
      wmsMaterializedQuantity: input.materialized,
      requiresShipping: true,
      sku: SKU,
    };
    h.tableRows.set(omsOrders, () => [PAID_ORDER]);
    h.tableRows.set(omsOrderLines, () => [line]);
    h.tableRows.set(wmsOrders, () => [READY_ORDER]);
    h.tableRows.set(wmsOrderItems, () => [{
      id: ITEM_ID,
      omsOrderLineId: LINE_ID,
      sku: SKU,
      quantity: input.item.quantity,
      pickedQuantity: input.item.pickedQuantity ?? 0,
      fulfilledQuantity: input.item.fulfilledQuantity ?? 0,
      status: input.item.status,
    }]);
    return line;
  }

  function globalESequence(currentQuantity: number | null) {
    const paid = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:paid",
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: null,
    });
    const update = (fulfillableQuantity: number, previous: typeof paid) => deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:update",
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity,
      currentQuantity,
      previous,
    });
    const held = update(0, paid);
    const released = update(1, held);
    return [paid, held, released];
  }

  it("never cancels the materialized WMS line while Shopify holds the order", async () => {
    for (const step of globalESequence(1)) {
      expect(step.authorityFulfillableQuantity).toBeGreaterThanOrEqual(step.paidQuantity);
      seed({ authority: step.authorityFulfillableQuantity, materialized: 1, item: { status: "pending", quantity: 1 } });
      const { service } = harness({ lockedLine: owedLine(1, 1), lockedItemRow: null });
      h.txExecute.mockReset();

      await service.reconcileExistingWmsOrderLines(OMS_ORDER_ID, WMS_ORDER_ID);
    }

    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it("does not cancel a materialized line when a legacy payload omits current_quantity", async () => {
    const [, held] = globalESequence(null);
    seed({ authority: held.authorityFulfillableQuantity, materialized: 1, item: { status: "pending", quantity: 1 } });
    const { service } = harness({ lockedLine: owedLine(1, 1), lockedItemRow: null });
    h.txExecute.mockReset();

    await service.reconcileExistingWmsOrderLines(OMS_ORDER_ID, WMS_ORDER_ID);

    expect(held.authorityFulfillableQuantity).toBe(1);
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it("restores a line an earlier hold cancelled once its authority is owed again", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    seed({ authority: 1, materialized: 0, item: { status: "cancelled", quantity: 0 } });
    const { service, reconcileOrderDemand } = harness({
      lockedLine: { ...owedLine(0, 1), quantity: 1 },
      lockedItemRow: CANCELLED_ROW,
    });

    await service.reconcileExistingWmsOrderLines(OMS_ORDER_ID, WMS_ORDER_ID);

    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledTimes(1);
    expect(reconcileWmsOrderItemAuthority).toHaveBeenCalledWith(h.tx, {
      itemId: ITEM_ID,
      orderId: WMS_ORDER_ID,
      authorityQuantity: 1,
    });
    expect(reconcileOrderDemand).toHaveBeenCalledWith(expect.objectContaining({
      orderId: WMS_ORDER_ID,
      sourceEventId: `wms_line_restore:${ITEM_ID}`,
    }));
  });

  it("neither restores nor cancels a line with picked units", async () => {
    // Cancelled but picked: never restored.
    seed({ authority: 1, materialized: 0, item: { status: "cancelled", quantity: 0, pickedQuantity: 1 } });
    const first = harness({ lockedLine: owedLine(0, 1), lockedItemRow: CANCELLED_ROW });
    h.txExecute.mockReset();
    await first.service.reconcileExistingWmsOrderLines(OMS_ORDER_ID, WMS_ORDER_ID);

    // Live and picked while authority falls below the picked units: flagged
    // for review, never reduced or cancelled.
    seed({ authority: 0, materialized: 1, item: { status: "completed", quantity: 1, pickedQuantity: 1 } });
    const second = harness({ lockedLine: owedLine(1, 0), lockedItemRow: null });
    h.txExecute.mockReset();
    await second.service.reconcileExistingWmsOrderLines(OMS_ORDER_ID, WMS_ORDER_ID);

    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(reconcileWmsOrderItemAuthority).not.toHaveBeenCalled();
    expect(first.reconcileOrderDemand).not.toHaveBeenCalled();
    expect(second.service.recordWmsReconciliationReviewException).toHaveBeenCalledWith(h.db, expect.objectContaining({
      rule: "picked_quantity_exceeds_oms_authority",
      wmsOrderItemId: ITEM_ID,
      pickedQuantity: 1,
    }));
  });
});
