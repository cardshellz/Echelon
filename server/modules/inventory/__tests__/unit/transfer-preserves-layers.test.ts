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
      execute: vi.fn(async () => ({ rows: [] })),
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
    });

    // Source lots decremented
    expect(db.execute).toHaveBeenCalledTimes(1);

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
});
