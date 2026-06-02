import { describe, expect, it, vi } from "vitest";

describe("InventoryLotService — pick idempotency + unpick COGS reversal", () => {
  /**
   * pickFromLots must be idempotent: if COGS rows already exist for the
   * order item, return them without inserting duplicates.
   */
  it("pickFromLots returns existing COGS rows on retry (no duplicate insert)", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const existingCogs = [
      { inventoryLotId: 10, qty: 3, unitCostCents: 500 },
      { inventoryLotId: 11, qty: 2, unitCostCents: 700 },
    ];

    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Idempotency check: return existing COGS rows
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(existingCogs),
          };
        }
        // Should not reach here — if idempotency works, no lot query needed
        throw new Error("Unexpected select call — idempotency check should have short-circuited");
      }),
      insert: vi.fn(() => {
        throw new Error("insert should not be called on retry");
      }),
      execute: vi.fn(async () => {
        throw new Error("execute should not be called on retry");
      }),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 5,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toEqual([
      { lotId: 10, qty: 3, unitCostCents: 500 },
      { lotId: 11, qty: 2, unitCostCents: 700 },
    ]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  /**
   * pickFromLots should proceed normally when no existing COGS rows are found.
   */
  it("pickFromLots inserts COGS on first pick (no prior rows)", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const lots = [
      {
        id: 10, lotNumber: "LOT-001", productVariantId: 10,
        warehouseLocationId: 20, unitCostCents: 500, qtyOnHand: 5,
        qtyReserved: 3, qtyPicked: 0, receivedAt: new Date(), status: "active",
      },
    ];

    let selectCallCount = 0;
    const insertedCosts: any[] = [];
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Idempotency check: no existing rows
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
          };
        }
        // Lot query for FIFO pick
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue(lots),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((vals: any) => {
          insertedCosts.push(...(Array.isArray(vals) ? vals : [vals]));
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 3,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ lotId: 10, qty: 3, unitCostCents: 500 });
    expect(insertedCosts).toHaveLength(1);
    expect(insertedCosts[0]).toMatchObject({
      orderId: 100,
      orderItemId: 200,
      inventoryLotId: 10,
      qty: 3,
      unitCostCents: 500,
      totalCostCents: 1500,
    });
  });

  /**
   * unpickFromLots must reverse COGS: delete order_item_costs rows and
   * restore lot quantities.
   */
  it("unpickFromLots deletes COGS rows and restores lot qty", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const cogsRows = [
      { id: 1, orderId: 100, orderItemId: 200, inventoryLotId: 10,
        productVariantId: 10, qty: 3, unitCostCents: 500, totalCostCents: 1500 },
      { id: 2, orderId: 100, orderItemId: 200, inventoryLotId: 11,
        productVariantId: 10, qty: 2, unitCostCents: 700, totalCostCents: 1400 },
    ];

    let deleteCalled = false;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(cogsRows),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => {
          deleteCalled = true;
          return Promise.resolve();
        }),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.unpickFromLots({
      orderId: 100,
      orderItemId: 200,
      productVariantId: 10,
      qty: 5, // full unpick
    });

    // Reversed cost = (3 × 500) + (2 × 700) = 2900
    expect(result.reversedCostCents).toBe(2900);
    // Lot quantities restored via execute (bulk update)
    expect(db.execute).toHaveBeenCalledTimes(1);
    // COGS rows deleted
    expect(deleteCalled).toBe(true);
  });
});
