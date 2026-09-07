import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 3: transferLots must preserve individual lot cost layers
 * instead of collapsing to a weighted average.
 */
describe("InventoryLotService.transferLots — layer preservation", () => {
  it("creates one destination lot per source layer with original cost", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const createdLots: any[] = [];
    const now = new Date("2024-06-01");
    const later = new Date("2024-06-15");

    // Two source lots at different costs (FIFO order)
    const sourceLots = [
      {
        id: 1, lotNumber: "LOT-001", productVariantId: 10,
        warehouseLocationId: 20, unitCostCents: 500, qtyOnHand: 5,
        qtyReserved: 0, qtyPicked: 0, receivedAt: now, status: "active",
        purchaseOrderId: 100, receivingOrderId: 200,
        inboundShipmentId: null, costProvisional: 0,
      },
      {
        id: 2, lotNumber: "LOT-002", productVariantId: 10,
        warehouseLocationId: 20, unitCostCents: 700, qtyOnHand: 10,
        qtyReserved: 0, qtyPicked: 0, receivedAt: later, status: "active",
        purchaseOrderId: 101, receivingOrderId: 201,
        inboundShipmentId: null, costProvisional: 0,
      },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ lotNumber: "LOT-20240601-001" }]),
    };
    // getLotsAtLocation returns sourceLots; generateLotNumber chain
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // getLotsAtLocation
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockResolvedValue(sourceLots),
          };
        }
        // generateLotNumber for each createLot call
        return selectChain;
      }),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          createdLots.push(val);
          return {
            returning: vi.fn().mockResolvedValue([{ id: 100 + createdLots.length, ...val }]),
          };
        }),
      })),
      execute: vi.fn(async (query: any) => {
        const compiled = new PgDialect().sqlToQuery(query);
        const statement = compiled.sql;
        if (statement.includes("SELECT source.qty_received AS source_qty")) {
          const source = sourceLots.find((lot) => lot.id === compiled.params[1])!;
          const output = createdLots[Number(compiled.params[0]) - 101];
          return { rows: [{ source_qty: source.qtyOnHand, output_qty: output.qtyReceived }] };
        }
        return { rows: statement.includes("UPDATE inventory.inventory_lots") ? [{ id: 1 }, { id: 2 }] : [] };
      }),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    await svc.transferLots({
      productVariantId: 10,
      fromLocationId: 20,
      toLocationId: 30,
      qty: 8, // 5 from lot 1 ($5) + 3 from lot 2 ($7)
      actorId: "unit-test", occurredAt: now,
    });

    // Source lots decremented
    const statements = db.execute.mock.calls.map(([query]: [any]) => new PgDialect().sqlToQuery(query));
    expect(statements[0].sql).toContain("pg_advisory_xact_lock");
    expect(statements.filter((row: any) => row.sql.includes("UPDATE inventory.inventory_lots"))).toHaveLength(1);
    const contributions = statements.filter((row: any) => row.sql.includes("INSERT INTO inventory.lot_cost_contributions"));
    expect(contributions.map((row: any) => row.params)).toEqual([
      [1, 101, "transfer", "inventory_transfer:1:101", 5, 5, 0, "unit-test", now],
      [2, 102, "transfer", "inventory_transfer:2:102", 3, 3, 0, "unit-test", now],
    ]);
    expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(db.select.mock.invocationCallOrder[0]);

    // Two separate destination lots created (not one averaged lot)
    expect(createdLots).toHaveLength(2);

    // First lot: 5 units at $5.00
    expect(createdLots[0]).toMatchObject({
      productVariantId: 10,
      warehouseLocationId: 30,
      qtyOnHand: 5,
      unitCostCents: 500,
    });

    // Second lot: 3 units at $7.00
    expect(createdLots[1]).toMatchObject({
      productVariantId: 10,
      warehouseLocationId: 30,
      qtyOnHand: 3,
      unitCostCents: 700,
    });
  });

  it.each([
    { patch: { qty: 0 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { qty: -1 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { qty: 1.5 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { qty: 2_147_483_648 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { productVariantId: Number.NaN }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { fromLocationId: 0 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { toLocationId: 20 }, code: "COST_TRANSFER_INPUT_INVALID" },
    { patch: { actorId: " " }, code: "COST_TRANSFER_AUDIT_REQUIRED" },
    { patch: { occurredAt: new Date("invalid") }, code: "COST_TRANSFER_AUDIT_REQUIRED" },
    { patch: { operationKey: " " }, code: "COST_TRANSFER_INPUT_INVALID" },
  ])("rejects invalid transfer evidence before any database operation: $patch", async ({ patch, code }) => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const db = { select: vi.fn(), execute: vi.fn(), insert: vi.fn() } as any;
    await expect(new InventoryLotService(db).transferLots({
      productVariantId: 10, fromLocationId: 20, toLocationId: 30, qty: 2,
      actorId: "unit-test", occurredAt: new Date("2024-06-01"), ...patch,
    })).rejects.toMatchObject({ code });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("fails closed before writing when exact unreserved FIFO quantity is unavailable", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn(async () => [{
          id: 1,
          productVariantId: 10,
          warehouseLocationId: 20,
          unitCostCents: 500,
          qtyOnHand: 4,
          qtyReserved: 3,
          qtyPicked: 0,
          receivedAt: new Date("2024-06-01"),
          status: "active",
        }]),
      })),
      execute: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as any;

    await expect(new InventoryLotService(db).transferLots({
      productVariantId: 10,
      fromLocationId: 20,
      toLocationId: 30,
      qty: 2,
      actorId: "unit-test", occurredAt: new Date("2024-06-01"),
    })).rejects.toMatchObject({
      code: "LOT_TRANSFER_SHORTFALL",
      context: expect.objectContaining({ requestedQty: 2, attributableQty: 1 }),
    });

    expect(db.execute).toHaveBeenCalledTimes(1); // Graph lock only; no quantity writes.
    expect(db.insert).not.toHaveBeenCalled();
  });
});
