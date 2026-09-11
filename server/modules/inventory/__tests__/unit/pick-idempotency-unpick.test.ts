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

  it("appends only the next pick delta when prior COGS matches WMS progress", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const insertedCosts: any[] = [];
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([{
              inventoryLotId: 10,
              productVariantId: 10,
              qty: 1,
              unitCostCents: 500,
            }]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([{
            id: 10,
            productVariantId: 10,
            warehouseLocationId: 20,
            unitCostCents: 500,
            unitCostMills: 50_000,
            qtyOnHand: 4,
            qtyReserved: 2,
            qtyPicked: 1,
            receivedAt: new Date(),
            status: "active",
          }]),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async (values: any[]) => { insertedCosts.push(...values); }),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
    } as any;

    const svc = new InventoryLotService(db);
    await expect(svc.pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 1,
      orderId: 100,
      orderItemId: 200,
      expectedExistingCostQuantity: 1,
    })).resolves.toEqual([{ lotId: 10, qty: 1, unitCostCents: 500 }]);

    expect(db.execute).toHaveBeenCalledOnce();
    expect(insertedCosts).toEqual([expect.objectContaining({
      orderId: 100,
      orderItemId: 200,
      inventoryLotId: 10,
      qty: 1,
      totalCostMills: 50_000,
    })]);
  });

  it("rejects a new pick delta when existing COGS does not match WMS progress", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{
          inventoryLotId: 10,
          productVariantId: 10,
          qty: 1,
          unitCostCents: 500,
        }]),
      })),
      insert: vi.fn(),
      execute: vi.fn(),
    } as any;

    await expect(new InventoryLotService(db).pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 1,
      orderId: 100,
      orderItemId: 200,
      expectedExistingCostQuantity: 2,
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({
        reason: "order_item_pick_cost_custody_mismatch",
        expectedExistingCostQuantity: 2,
        actualExistingCostQuantity: 1,
      }),
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects an incremental pick that would split legacy WMS custody across locations", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([{
              inventoryLotId: 10,
              productVariantId: 10,
              qty: 1,
              unitCostCents: 500,
            }]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([{
            id: 11,
            productVariantId: 10,
            warehouseLocationId: 21,
            unitCostCents: 500,
            qtyOnHand: 4,
            qtyReserved: 0,
            qtyPicked: 0,
            receivedAt: new Date(),
            status: "active",
          }]),
        };
      }),
      insert: vi.fn(),
      execute: vi.fn(),
    } as any;

    await expect(new InventoryLotService(db).pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 21,
      qty: 1,
      orderId: 100,
      orderItemId: 200,
      expectedExistingCostQuantity: 1,
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({
        reason: "order_item_pick_cost_location_mismatch",
        warehouseLocationId: 21,
        mismatchedInventoryLotIds: [10],
      }),
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not subtract already-picked units from remaining lot on-hand", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const lots = [
      {
        id: 10, lotNumber: "LOT-001", productVariantId: 10,
        warehouseLocationId: 20, unitCostCents: 500, qtyOnHand: 4,
        qtyReserved: 0, qtyPicked: 4, receivedAt: new Date(), status: "active",
      },
    ];

    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue(lots),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
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
      qty: 1,
      orderId: 100,
      orderItemId: 200,
    });

    expect(result).toEqual([{ lotId: 10, qty: 1, unitCostCents: 500 }]);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a COGS mill total that exceeds the safe integer range before inventory moves", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([{
            id: 10,
            productVariantId: 10,
            warehouseLocationId: 20,
            unitCostCents: 0,
            unitCostMills: Number.MAX_SAFE_INTEGER,
            qtyOnHand: 2,
            qtyReserved: 2,
            qtyPicked: 0,
            receivedAt: new Date(),
            status: "active",
          }]),
        };
      }),
      insert: vi.fn(),
      execute: vi.fn(),
    } as any;

    await expect(new InventoryLotService(db).pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 100,
      orderItemId: 200,
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({ field: "orderItemCost.totalCostMills" }),
    });

    expect(db.execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("keeps replacement picks out of stock reserved for customer orders", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");

    const lots = [
      {
        id: 10, lotNumber: "LOT-001", productVariantId: 10,
        warehouseLocationId: 20, unitCostCents: 500, qtyOnHand: 4,
        qtyReserved: 3, qtyPicked: 4, receivedAt: new Date(), status: "active",
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(lots),
      })),
      insert: vi.fn(),
      execute: vi.fn(async () => ({ rows: [] })),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    await expect(svc.pickFromLots({
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 100,
      recordOrderItemCosts: false,
      allowReservedStock: false,
    })).rejects.toThrow("required 2, available 1");

    expect(db.execute).not.toHaveBeenCalled();
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
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn(() => ({
          for: vi.fn().mockResolvedValue(cogsRows),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => {
          deleteCalled = true;
          return Promise.resolve();
        }),
      })),
      execute: vi.fn(async () => ({ rows: [{ id: 10 }, { id: 11 }] })),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(db);
    const result = await svc.unpickFromLots({
      orderId: 100,
      orderItemId: 200,
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 5, // full unpick
    });

    // Reversed cost = (3 × 500) + (2 × 700) = 2900
    expect(result.reversedCostCents).toBe(2900);
    // Lot quantities restored via execute (bulk update)
    expect(db.execute).toHaveBeenCalledTimes(1);
    // COGS rows deleted
    expect(deleteCalled).toBe(true);
  });

  it("partially unpicks the newest allocation without deleting remaining COGS", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const set = vi.fn().mockReturnThis();
    const where = vi.fn().mockReturnThis();
    const returning = vi.fn(async () => [{ id: 2 }]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn(() => ({
          for: vi.fn().mockResolvedValue([
            { id: 2, orderId: 100, orderItemId: 200, inventoryLotId: 11,
              productVariantId: 10, qty: 2, unitCostCents: 700, unitCostMills: 70_000, totalCostCents: 1400 },
            { id: 1, orderId: 100, orderItemId: 200, inventoryLotId: 10,
              productVariantId: 10, qty: 3, unitCostCents: 500, unitCostMills: 50_000, totalCostCents: 1500 },
          ]),
        })),
      })),
      execute: vi.fn(async () => ({ rows: [{ id: 11 }] })),
      delete: vi.fn(),
      update: vi.fn(() => ({ set, where, returning })),
    } as any;

    await expect(new InventoryLotService(db).unpickFromLots({
      orderId: 100,
      orderItemId: 200,
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 1,
    })).resolves.toEqual({ reversedCostCents: 700 });

    expect(db.delete).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({ qty: 1, totalCostMills: 70_000, totalCostCents: 700 });
    expect(returning).toHaveBeenCalledOnce();
  });

  it("rejects an unpick shortfall before changing lots or COGS", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryLotService } = await import("../../lots.service");
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn(() => ({
          for: vi.fn().mockResolvedValue([{
            id: 1,
            orderId: 100,
            orderItemId: 200,
            inventoryLotId: 10,
            productVariantId: 10,
            qty: 1,
            unitCostCents: 500,
          }]),
        })),
      })),
      execute: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    } as any;

    await expect(new InventoryLotService(db).unpickFromLots({
      orderId: 100,
      orderItemId: 200,
      productVariantId: 10,
      warehouseLocationId: 20,
      qty: 2,
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
      context: expect.objectContaining({
        reason: "order_item_unpick_cost_custody_shortfall",
        requestedQuantity: 2,
        availableQuantity: 1,
      }),
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
