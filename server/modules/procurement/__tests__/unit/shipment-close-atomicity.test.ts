import { recordShipmentCostRevisions, applyShipmentCostRevisions } from "../../shipment-cost-application.service";
vi.mock("../../shipment-cost-application.service", () => ({ recordShipmentCostRevisions: vi.fn(), applyShipmentCostRevisions: vi.fn() }));
import { describe, expect, it, vi } from "vitest";
import { createShipmentTrackingService } from "../../shipment-tracking.service";

const commandTime = new Date("2026-09-06T12:00:00.000Z");

function harness() {
  const state = {
    shipment: { id: 1, status: "costing", closedAt: null, closedBy: null } as any,
    lines: [{ id: 11, inboundShipmentId: 1, purchaseOrderLineId: 21, productVariantId: 10, qtyShipped: 5 }] as any[],
    snapshots: [] as any[],
    history: [] as any[],
  };
  const events: string[] = [];
  const transactions: any[] = [];
  const db = {
    transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      const tx = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }), state: structuredClone(state) };
      transactions.push(tx);
      try {
        const result = await work(tx);
        Object.assign(state, tx.state);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    }),
  };
  const inTransaction = (tx: any) => {
    if (!transactions.includes(tx)) throw new Error("Write/read escaped the active transaction");
    return tx.state as typeof state;
  };
  const storage = {
    getInboundShipmentById: vi.fn(async (_id: number, tx: any) => ({ ...inTransaction(tx).shipment })),
    getInboundShipmentLines: vi.fn(async (_id: number, tx: any) => inTransaction(tx).lines),
    getInboundFreightCosts: vi.fn(async (_id: number, tx: any) => { inTransaction(tx); return []; }),
    getPurchaseOrderLineById: vi.fn(async (_id: number, tx: any) => { inTransaction(tx); return { id: 21, unitCostCents: 100 }; }),
    deleteAllocationsForShipment: vi.fn(async (_id: number, tx: any) => { inTransaction(tx); }),
    bulkCreateInboundFreightCostAllocations: vi.fn(async (_data: unknown, tx: any) => { inTransaction(tx); return []; }),
    updateInboundShipmentLine: vi.fn(async (id: number, patch: any, tx: any) => {
      const line = inTransaction(tx).lines.find((candidate) => candidate.id === id)!;
      Object.assign(line, patch);
      return { ...line };
    }),
    getLandedCostSnapshots: vi.fn(async (_id: number, tx: any) => inTransaction(tx).snapshots),
    getAllocationsForLine: vi.fn(async (_id: number, tx: any) => { inTransaction(tx); return []; }),
    deleteLandedCostSnapshotsForShipment: vi.fn(async (_id: number, tx: any) => { inTransaction(tx).snapshots = []; }),
    bulkCreateLandedCostSnapshots: vi.fn(async (snapshots: any[], tx: any) => {
      inTransaction(tx).snapshots = structuredClone(snapshots);
      events.push("snapshots");
      return snapshots;
    }),
    updateInboundShipment: vi.fn(async (_id: number, patch: any, tx: any) => {
      Object.assign(inTransaction(tx).shipment, patch);
      events.push("closed");
      return { ...inTransaction(tx).shipment };
    }),
    createInboundShipmentStatusHistory: vi.fn(async (entry: any, tx: any) => {
      inTransaction(tx).history.push(structuredClone(entry));
      events.push("history");
      return entry;
    }),
    getProvisionalLotsByShipment: vi.fn(async (_id: number, tx: any) => {
      expect(inTransaction(tx).shipment.status).toBe("closed");
      events.push("push");
      return [];
    }),
  };
  vi.mocked(recordShipmentCostRevisions).mockReset().mockImplementation(async (tx) => {
    inTransaction(tx);
    events.push("source-revisions");
    return { revisions: [], issues: [] } as any;
  });
  vi.mocked(applyShipmentCostRevisions).mockReset().mockImplementation(async (tx) => {
    expect(inTransaction(tx).shipment.status).toBe("closed");
    events.push("push");
    return { updated: 0, total: 0, skipped: [], costApplications: [] };
  });
  const clock = vi.fn(() => commandTime);
  const cogs = { withTx: vi.fn(), updateLotLandedCostMills: vi.fn() };
  const service = createShipmentTrackingService(db, storage as any, cogs as any, clock);
  return { state, events, transactions, db, storage, clock, service };
}

describe("shipment close transaction", () => {
  it("commits finalized snapshots, closed fields and history together before the lot push", async () => {
    const h = harness();
    const result = await h.service.close(1, "operator-1", "Costs reviewed");
    expect(result).toMatchObject({ id: 1, status: "closed", closedBy: "operator-1", closedAt: commandTime });
    expect(h.state.snapshots).toEqual([expect.objectContaining({ totalLandedCostCents: 500, finalizedAt: commandTime })]);
    expect(h.state.history).toEqual([{
      inboundShipmentId: 1, fromStatus: "costing", toStatus: "closed", changedBy: "operator-1",
      notes: "Costs reviewed", changedAt: commandTime,
    }]);
    expect(h.clock).toHaveBeenCalledTimes(2);
    expect(h.events).toEqual(["snapshots", "source-revisions", "closed", "history", "commit", "push", "commit"]);
    expect(h.db.transaction).toHaveBeenCalledTimes(2);
    const closingTx = h.transactions[0];
    expect(recordShipmentCostRevisions).toHaveBeenCalledWith(closingTx, 1, "operator-1", commandTime, { allocationJustFinalized: true });
    expect(applyShipmentCostRevisions).toHaveBeenCalledWith(h.transactions[1], 1, expect.any(Object), "system:shipment-costs", commandTime);
    expect(h.storage.bulkCreateLandedCostSnapshots).toHaveBeenCalledWith(expect.any(Array), closingTx);
    expect(h.storage.updateInboundShipment).toHaveBeenCalledWith(1, expect.objectContaining({ status: "closed" }), closingTx);
    expect(h.storage.createInboundShipmentStatusHistory).toHaveBeenCalledWith(expect.any(Object), closingTx);
  });

  it("rolls back finalization and closure if status history cannot be persisted", async () => {
    const h = harness();
    h.storage.createInboundShipmentStatusHistory.mockRejectedValueOnce(new Error("History write failed"));
    await expect(h.service.close(1, "operator-1")).rejects.toThrow("History write failed");
    expect(h.state.shipment).toMatchObject({ status: "costing", closedAt: null });
    expect(h.state.snapshots).toEqual([]);
    expect(h.state.history).toEqual([]);
    expect(h.state.lines[0]).not.toHaveProperty("allocatedCostCents");
    expect(h.events).toEqual(["snapshots", "source-revisions", "closed", "rollback"]);
    expect(h.storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
    expect(applyShipmentCostRevisions).not.toHaveBeenCalled();
  });

  it("rolls back finalized snapshots if the header update fails", async () => {
    const h = harness();
    h.storage.updateInboundShipment.mockRejectedValueOnce(new Error("Header write failed"));
    await expect(h.service.close(1, "operator-1")).rejects.toThrow("Header write failed");
    expect(h.state.shipment.status).toBe("costing");
    expect(h.state.snapshots).toEqual([]);
    expect(h.storage.createInboundShipmentStatusHistory).not.toHaveBeenCalled();
    expect(h.storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
    expect(applyShipmentCostRevisions).not.toHaveBeenCalled();
  });

  it("does not close or push if finalization fails", async () => {
    const h = harness();
    h.storage.bulkCreateLandedCostSnapshots.mockRejectedValueOnce(new Error("Snapshot write failed"));
    await expect(h.service.close(1, "operator-1")).rejects.toThrow("Snapshot write failed");
    expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
    expect(h.storage.createInboundShipmentStatusHistory).not.toHaveBeenCalled();
    expect(h.storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
    expect(applyShipmentCostRevisions).not.toHaveBeenCalled();
    expect(h.state.lines[0]).not.toHaveProperty("allocatedCostCents");
  });

  it.each(["closed", "cancelled", "delivered"])("rejects %s under the lock before touching finalized records", async (status) => {
    const h = harness();
    h.state.shipment.status = status;
    await expect(h.service.close(1, "operator-1")).rejects.toThrow("Cannot transition");
    expect(h.transactions[0].execute).toHaveBeenCalledTimes(2);
    expect(h.storage.getInboundShipmentLines).not.toHaveBeenCalled();
    expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
    expect(h.storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
    expect(applyShipmentCostRevisions).not.toHaveBeenCalled();
  });

  it("keeps the committed close and logs a classified warning when the separate lot push fails", async () => {
    const h = harness();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(applyShipmentCostRevisions).mockRejectedValueOnce(new Error("Private DB diagnostic"));
    try {
      await expect(h.service.close(1, "operator-1")).resolves.toMatchObject({ status: "closed" });
      expect(h.state.shipment.status).toBe("closed");
      expect(h.state.snapshots).toHaveLength(1);
      expect(h.state.history).toHaveLength(1);
      expect(JSON.parse(String(warning.mock.calls[0][0]))).toEqual({
        event: "procurement.shipment.close_lot_cost_push_failed", shipmentId: 1, actorId: "operator-1",
        code: "SHIPMENT_LOT_COST_PUSH_FAILED", errorType: "Error",
      });
      expect(String(warning.mock.calls[0][0])).not.toContain("Private DB diagnostic");
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects an invalid injected clock before financial writes", async () => {
    const h = harness();
    h.clock.mockReturnValueOnce(new Date(NaN));
    await expect(h.service.close(1, "operator-1")).rejects.toMatchObject({
      details: { code: "SHIPMENT_FINALIZATION_CLOCK_INVALID" },
    });
    expect(h.storage.getInboundShipmentLines).not.toHaveBeenCalled();
    expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
  });
});

describe("shipment lifecycle transition transaction", () => {
  it("rechecks a cancellation that waited for close and preserves the committed close", async () => {
    const h = harness();
    const runTransaction = h.db.transaction.getMockImplementation()!;
    let previous: Promise<unknown> = Promise.resolve();
    h.db.transaction.mockImplementation((work) => {
      const current = previous.then(() => runTransaction(work));
      previous = current.catch(() => undefined);
      return current;
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotStarted = new Promise<void>((resolve) => { started = resolve; });
    const writeSnapshots = h.storage.bulkCreateLandedCostSnapshots.getMockImplementation()!;
    h.storage.bulkCreateLandedCostSnapshots.mockImplementation(async (snapshots, tx) => {
      const result = await writeSnapshots(snapshots, tx);
      started();
      await gate;
      return result;
    });

    const close = h.service.close(1, "operator-1");
    await snapshotStarted;
    const cancellation = expect(h.service.cancel(1, "operator-2", "Stale screen")).rejects.toThrow(
      "Cannot transition from 'closed' to 'cancelled'",
    );
    release();
    await Promise.all([close, cancellation]);

    expect(h.state.shipment.status).toBe("closed");
    expect(h.state.history).toHaveLength(1);
    expect(h.state.history[0].toStatus).toBe("closed");
    expect(h.state.snapshots).toHaveLength(1);
    expect(h.storage.updateInboundShipment).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicitly supplied event date and uses the clock for recorded history", async () => {
    const h = harness();
    h.state.shipment.status = "booked";
    const departure = new Date("2026-09-01T08:30:00.000Z");
    await h.service.markInTransit(1, "operator-1", "BOL confirmed", departure);
    expect(h.state.shipment).toMatchObject({ status: "in_transit", shipDate: departure });
    expect(h.state.history).toEqual([{
      inboundShipmentId: 1, fromStatus: "booked", toStatus: "in_transit",
      changedBy: "operator-1", notes: "BOL confirmed", changedAt: commandTime,
    }]);
    expect(departure.toISOString()).toBe("2026-09-01T08:30:00.000Z");
    expect(h.storage.updateInboundShipment).toHaveBeenCalledWith(1, expect.any(Object), h.transactions[0]);
    expect(h.storage.createInboundShipmentStatusHistory).toHaveBeenCalledWith(expect.any(Object), h.transactions[0]);
  });

  it("uses the injected clock for missing arrival dates", async () => {
    const h = harness();
    h.state.shipment.status = "in_transit";
    await h.service.markAtPort(1, "operator-1");
    expect(h.state.shipment.actualArrival).toEqual(commandTime);
    expect(h.state.history[0].changedAt).toEqual(commandTime);
    expect(h.clock).toHaveBeenCalledTimes(1);
  });

  it("validates booking lines inside the transaction and rolls back on history failure", async () => {
    const h = harness();
    h.state.shipment.status = "draft";
    h.storage.createInboundShipmentStatusHistory.mockRejectedValueOnce(new Error("History unavailable"));
    await expect(h.service.book(1, "operator-1")).rejects.toThrow("History unavailable");
    expect(h.storage.getInboundShipmentLines).toHaveBeenCalledWith(1, h.transactions[0]);
    expect(h.state.shipment.status).toBe("draft");
    expect(h.state.history).toEqual([]);
    expect(h.events).toEqual(["closed", "rollback"]);
  });
});
