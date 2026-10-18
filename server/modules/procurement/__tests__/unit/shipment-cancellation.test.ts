import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createShipmentTrackingService } from "../../shipment-tracking.service";
import { readShipmentCancellationEvidence } from "../../shipment-cancellation.repository";
import { shipmentCancellationBlockers, type ShipmentCancellationEvidence } from "../../domain/shipment-cancellation";

const now = new Date("2026-10-16T12:00:00Z");
const emptyEvidence: ShipmentCancellationEvidence = {
  receivingHistory: false, inventoryHistory: false, finalizedCostHistory: false, invoiceHistory: false,
};
function harness(status = "delivered", evidence: unknown = emptyEvidence) {
  const state = { shipment: { id: 1, status }, history: [] as unknown[] };
  const queries: string[] = [];
  const storage = {
    getInboundShipmentById: vi.fn(async (_id: number, tx: { state: typeof state }) => ({ ...tx.state.shipment })),
    updateInboundShipment: vi.fn(async (_id: number, values: typeof state.shipment, tx: { state: typeof state }) => {
      Object.assign(tx.state.shipment, values); return { ...tx.state.shipment };
    }),
    createInboundShipmentStatusHistory: vi.fn(async (entry: unknown, tx: { state: typeof state }) => {
      tx.state.history.push(entry); return entry;
    }),
  };
  const db = { transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    const tx = { state: structuredClone(state), execute: vi.fn(async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql; queries.push(text);
      if (text.includes('AS "receivingHistory"')) return { rows: evidence === undefined ? [] : [evidence] };
      if (text.includes("FOR UPDATE")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    }) };
    const result = await work(tx); Object.assign(state, tx.state); return result;
  }) };
  return { state, storage, db, queries,
    service: createShipmentTrackingService(db, storage as unknown as Parameters<typeof createShipmentTrackingService>[1], undefined, () => now) };
}

describe("shipment cancellation evidence boundary", () => {
  it.each(["draft", "booked", "in_transit", "at_port", "customs_clearance", "delivered", "costing"])(
    "retains cancellation of %s shipments with no retained evidence", async status => {
      const h = harness(status);
      await expect(h.service.cancel(1, "operator", "  Supplier withdrew shipment  ")).resolves.toMatchObject({ status: "cancelled" });
      expect(h.queries).toHaveLength(3);
      expect(h.queries[0]).toContain("pg_advisory_xact_lock");
      expect(h.queries[1]).toContain("FOR UPDATE");
      expect(h.queries[2]).toContain('AS "receivingHistory"');
      expect(h.state.history).toEqual([{ inboundShipmentId: 1, fromStatus: status, toStatus: "cancelled",
        changedBy: "operator", notes: "Cancelled: Supplier withdrew shipment", changedAt: now }]);
    });
  it.each(Object.keys(emptyEvidence) as (keyof ShipmentCancellationEvidence)[])(
    "preserves shipment and audit history when %s exists", async blocker => {
      const h = harness("costing", { ...emptyEvidence, [blocker]: true });
      await expect(h.service.cancel(1, "operator", "Cancel" )).rejects.toMatchObject({ statusCode: 409,
        details: { code: "SHIPMENT_CANCELLATION_HISTORY_PROTECTED", shipmentId: 1, blockers: [blocker] } });
      expect(h.state).toEqual({ shipment: { id: 1, status: "costing" }, history: [] });
      expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
      expect(h.storage.createInboundShipmentStatusHistory).not.toHaveBeenCalled();
    });
  it("reports every retained boundary without mutating its evidence", () => {
    const evidence = Object.freeze({ receivingHistory: true, inventoryHistory: true, finalizedCostHistory: true, invoiceHistory: true });
    expect(shipmentCancellationBlockers(evidence)).toEqual(["receivingHistory", "inventoryHistory", "finalizedCostHistory", "invoiceHistory"]);
    expect(evidence).toEqual({ receivingHistory: true, inventoryHistory: true, finalizedCostHistory: true, invoiceHistory: true });
  });
  it.each([null, {}, { ...emptyEvidence, receivingHistory: "false" }, { ...emptyEvidence, inventoryHistory: null }])(
    "fails closed when source evidence cannot be validated: %j", async evidence => {
      const h = harness("delivered", evidence);
      await expect(h.service.cancel(1, "operator", "Cancel")).rejects.toThrow();
      expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
      expect(h.state.shipment.status).toBe("delivered");
    });
  it("does not infer permission from a missing or duplicate evidence result", async () => {
    for (const rows of [[], [emptyEvidence, emptyEvidence]]) {
      await expect(readShipmentCancellationEvidence({ execute: async () => ({ rows }) }, 1)).rejects.toThrow();
    }
  });
  it("rolls back cancellation if history cannot be recorded", async () => {
    const h = harness();
    h.storage.createInboundShipmentStatusHistory.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(h.service.cancel(1, "operator", "Cancel")).rejects.toThrow("history unavailable");
    expect(h.storage.updateInboundShipment).toHaveBeenCalledTimes(1);
    expect(h.state).toEqual({ shipment: { id: 1, status: "delivered" }, history: [] });
  });
  it.each(["closed", "cancelled"])("preserves terminal %s before reading cancellation evidence", async status => {
    const h = harness(status);
    await expect(h.service.cancel(1, "operator", "Cancel")).rejects.toThrow("Cannot transition");
    expect(h.queries).toHaveLength(2);
    expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.NaN, 2147483648])("rejects invalid shipment ID %s before opening a transaction", async id => {
    const h = harness();
    await expect(h.service.cancel(id, "operator", "Cancel")).rejects.toMatchObject({ statusCode: 400,
      details: { code: "SHIPMENT_CANCELLATION_INPUT_INVALID" } });
    expect(h.db.transaction).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "   ", "x".repeat(10001)])("rejects missing, blank or excessive reasons before writes", async reason => {
    const h = harness();
    await expect(h.service.cancel(1, "operator", reason)).rejects.toMatchObject({ statusCode: 400,
      details: { code: "SHIPMENT_CANCELLATION_INPUT_INVALID" } });
    expect(h.db.transaction).not.toHaveBeenCalled();
  });
});
