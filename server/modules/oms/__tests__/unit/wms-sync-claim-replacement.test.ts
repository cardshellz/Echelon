import { afterEach, describe, expect, it, vi } from "vitest";

import { WmsShipmentPrerequisiteError, WmsSyncService } from "../../wms-sync.service";

// 2026-10-08, #63964: three lines were authorized after the order's first
// claim. reserveOrder refused the changed demand (ACTIVE_CLAIM_REPLACEMENT_REQUIRED),
// so every sync retry aborted before amending ShipStation, which kept 1 of 4 items.

interface Harness {
  reserveBeforeShipmentProcessing(wmsOrderId: number, omsOrderId: number | null, context: string): Promise<void>;
}

function claimChanged(claimId = "9") {
  return Object.assign(new Error("The locked order demand differs from its active canonical claim"), {
    code: "ACTIVE_CLAIM_REPLACEMENT_REQUIRED", context: { orderId: 209393, claimId },
  });
}

function harness(reservation: Record<string, unknown>): Harness {
  return new WmsSyncService({ reservation } as any) as unknown as Harness;
}

const reserved = { orderId: 209393, reserved: 4, promised: 0, failed: [], totalBaseUnits: 19, totalPromisedBaseUnits: 0 };

afterEach(() => vi.restoreAllMocks());

describe("late lines after the order's first claim", () => {
  it("replaces the changed claim and continues to the shipment step", async () => {
    const reserveOrder = vi.fn(async () => { throw claimChanged("9"); });
    const reconcileOrderDemand = vi.fn(async () => ({ reconciled: true, release: { released: 1, failed: [] }, reservation: reserved }));
    await expect(harness({ reserveOrder, reconcileOrderDemand })
      .reserveBeforeShipmentProcessing(209393, 120155, "existing_order_reconciliation")).resolves.toBeUndefined();
    expect(reconcileOrderDemand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      orderId: 209393, demandChanged: true, sourceEventId: "wms_sync_claim_replacement:209393:9",
    }));
  });

  it("uses the same idempotency key on a retry, so the replacement replays", async () => {
    const reserveOrder = vi.fn(async () => { throw claimChanged("9"); });
    const reconcileOrderDemand = vi.fn(async () => ({ reconciled: true, release: { released: 0, failed: [] }, reservation: reserved }));
    const service = harness({ reserveOrder, reconcileOrderDemand });
    await service.reserveBeforeShipmentProcessing(209393, 120155, "existing_order_reconciliation");
    await service.reserveBeforeShipmentProcessing(209393, 120155, "existing_order_reconciliation");
    expect(new Set(reconcileOrderDemand.mock.calls.map(([command]: any[]) => command.sourceEventId)).size).toBe(1);
  });

  it("does not replace a claim for any other reservation failure", async () => {
    const reserveOrder = vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "INVENTORY_LOCK_TIMEOUT" }); });
    const reconcileOrderDemand = vi.fn();
    await expect(harness({ reserveOrder, reconcileOrderDemand })
      .reserveBeforeShipmentProcessing(209393, 120155, "existing_order_reconciliation"))
      .rejects.toBeInstanceOf(WmsShipmentPrerequisiteError);
    expect(reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("still aborts the sync, for retry, when the replacement itself fails", async () => {
    const reserveOrder = vi.fn(async () => { throw claimChanged(); });
    const reconcileOrderDemand = vi.fn(async () => { throw Object.assign(new Error("serialization"), { code: "40001" }); });
    await expect(harness({ reserveOrder, reconcileOrderDemand })
      .reserveBeforeShipmentProcessing(209393, 120155, "existing_order_reconciliation"))
      .rejects.toBeInstanceOf(WmsShipmentPrerequisiteError);
  });
});
