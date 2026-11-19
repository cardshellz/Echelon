import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { InterwarehouseTransferService } from "../../application/interwarehouse-transfer.service";

const now = new Date("2026-11-16T15:00:00.000Z");

function summaryRow() {
  return {
    id: 41, status: "in_transit", source_warehouse_id: 2, destination_warehouse_id: 1,
    source_location_id: 9, destination_location_id: 10, transit_location_id: 900,
    notes: "Restock Leon", exception_notes: null, created_by: "operator", dispatched_by: "operator",
    created_at: now, dispatched_at: now, completed_at: null, updated_at: now, revision: 1,
    source_warehouse_code: "RTE-19", source_warehouse_name: "Route 19",
    destination_warehouse_code: "LEON", destination_warehouse_name: "Leonberg",
    source_location_code: "FLOOR-01", destination_location_code: "FLOOR-03",
    product_variant_id: 174, requested_qty: 50, dispatched_qty: 50, received_qty: 0,
    damaged_qty: 0, lost_qty: 0, cancelled_qty: 0, sku: "SHLZ-SEMI-OVR-C2000", product_name: "Case of 2000",
  };
}

describe("InterwarehouseTransferService", () => {
  it("creates the order, isolated custody and dispatch movement in one transaction", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        source_location_id: 9, source_warehouse_id: 2, source_active: 1, source_type: "reserve",
        destination_location_id: 10, destination_warehouse_id: 1, destination_active: 1, destination_type: "pick",
        source_warehouse_active: 1, source_warehouse_type: "operations",
        destination_warehouse_active: 1, destination_warehouse_type: "operations",
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [{ id: 41 }] })
      .mockResolvedValueOnce({ rows: [{ id: 900 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 700 }] })
      .mockResolvedValueOnce({ rows: [{
        id: 700, transfer_id: 41, event_type: "dispatched", effects_completed_at: null,
        product_variant_id: 174, source_location_id: 9, destination_location_id: 10,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 700 }] })
      .mockResolvedValueOnce({ rows: [summaryRow()] });
    const tx = { execute };
    const database = {
      execute,
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const transfer = vi.fn(async () => ({ reservedMoved: 0, orderItemsRepointed: 0, transferReceiptId: 601 }));
    const inventory = { withTx: vi.fn(() => ({ transfer })) };
    const effects = { deliver: vi.fn(async () => undefined) };
    const service = new InterwarehouseTransferService(database as never, inventory as never, effects, () => now);

    const result = await service.createAndDispatch({
      commandKey: "inventory:dispatch:41",
      fromLocationId: 9,
      toLocationId: 10,
      variantId: 174,
      quantity: 50,
      notes: "Restock Leon",
    }, "operator");

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(inventory.withTx).toHaveBeenCalledExactlyOnceWith(tx);
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({
      fromLocationId: 9,
      toLocationId: 900,
      qty: 50,
      referenceType: "interwarehouse_transfer",
      interwarehouseTransfer: { transferId: 41, stage: "dispatch" },
    }));
    expect(effects.deliver).toHaveBeenCalledWith(expect.objectContaining({ eventId: 700, transferId: 41, eventType: "dispatched" }));
    expect(result).toMatchObject({ transferNumber: "WT-00000041", status: "in_transit", inTransitQuantity: 50, followupPending: false });
  });

  it("atomically receives accepted and damaged custody before publishing the event", async () => {
    const locked = {
      id: 41, status: "in_transit", source_warehouse_id: 2, destination_warehouse_id: 1,
      source_location_id: 9, destination_location_id: 10, transit_location_id: 900, revision: 1,
      product_variant_id: 174, requested_qty: 50, dispatched_qty: 50, received_qty: 0,
      damaged_qty: 0, lost_qty: 0, cancelled_qty: 0,
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // command advisory lock
      .mockResolvedValueOnce({ rows: [] }) // no replay event
      .mockResolvedValueOnce({ rows: [locked] })
      .mockResolvedValueOnce({ rows: [] }) // line counters
      .mockResolvedValueOnce({ rows: [] }) // transfer state
      .mockResolvedValueOnce({ rows: [{ id: 701 }] }) // immutable event
      .mockResolvedValueOnce({ rows: [{
        id: 701, transfer_id: 41, event_type: "received", effects_completed_at: null,
        product_variant_id: 174, source_location_id: 9, destination_location_id: 10,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 701 }] })
      .mockResolvedValueOnce({ rows: [{
        ...summaryRow(), status: "exception", received_qty: 40, damaged_qty: 5, revision: 2,
      }] });
    const tx = { execute };
    const database = {
      execute,
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const transfer = vi.fn(async () => ({ reservedMoved: 0, orderItemsRepointed: 0, transferReceiptId: 602 }));
    const adjustInventory = vi.fn(async () => ({ adjustmentTransactionId: 603 }));
    const inventory = { withTx: vi.fn(() => ({ transfer, adjustInventory })) };
    const effects = { deliver: vi.fn(async () => undefined) };
    const service = new InterwarehouseTransferService(database as never, inventory as never, effects, () => now);

    const result = await service.receive(41, {
      commandKey: "inventory:receive:41:1",
      quantity: 40,
      damagedQuantity: 5,
      notes: "Five crushed in transit",
    }, "receiver");

    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({
      fromLocationId: 900,
      toLocationId: 10,
      qty: 40,
      interwarehouseTransfer: { transferId: 41, stage: "receive" },
    }));
    expect(adjustInventory).toHaveBeenCalledWith(expect.objectContaining({
      warehouseLocationId: 900,
      qtyDelta: -5,
    }));
    const transferStateUpdate = execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query))
      .find(({ sql }) => sql.includes("exception_notes=CASE"));
    expect(transferStateUpdate).toBeDefined();
    expect(transferStateUpdate!.sql).toContain("NULLIF(exception_notes,''),$3::text)");
    expect(transferStateUpdate!.params[2]).toBe("Five crushed in transit");
    expect(effects.deliver).toHaveBeenCalledWith(expect.objectContaining({ eventId: 701, eventType: "received" }));
    expect(result).toMatchObject({ status: "exception", receivedQuantity: 40, damagedQuantity: 5, inTransitQuantity: 5 });
  });

  it("does not append workflow evidence when the atomic inventory movement fails", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 41, status: "in_transit", source_warehouse_id: 2, destination_warehouse_id: 1,
        source_location_id: 9, destination_location_id: 10, transit_location_id: 900, revision: 1,
        product_variant_id: 174, requested_qty: 50, dispatched_qty: 50, received_qty: 0,
        damaged_qty: 0, lost_qty: 0, cancelled_qty: 0,
      }] });
    const tx = { execute };
    const database = {
      execute,
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const transfer = vi.fn(async () => { throw new Error("FIFO custody move failed"); });
    const inventory = { withTx: vi.fn(() => ({ transfer })) };
    const effects = { deliver: vi.fn(async () => undefined) };
    const service = new InterwarehouseTransferService(database as never, inventory as never, effects, () => now);

    await expect(service.receive(41, {
      commandKey: "inventory:receive:41:failure",
      quantity: 50,
      damagedQuantity: 0,
    }, "receiver")).rejects.toThrow("FIFO custody move failed");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(effects.deliver).not.toHaveBeenCalled();
  });
});
