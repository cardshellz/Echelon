import { describe, expect, it, vi } from "vitest";

/**
 * COGS Phase 1 regression: recordShipment must NOT call the retired
 * recordShipmentCOGS path. That path wrote to the dead
 * inventory.order_line_costs ledger and re-decremented lot.qty_consumed,
 * double-counting consumption already booked at pick time
 * (pickFromLots → oms.order_item_costs). COGS is recorded at pick, not ship.
 */
describe("InventoryUseCases.recordShipment — no dead COGS write", () => {
  it("ships without invoking cogsService.recordShipmentCOGS", async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");

    // tx.execute is used for the ship-idempotency probe (returns no prior ship).
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
    };

    const rootDb = {
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(async (fn: (t: any) => Promise<unknown>) => fn(tx)),
    };

    const storage = {
      lockInventoryLevel: vi.fn(async () => ({
        id: 10,
        warehouseLocationId: 20,
        productVariantId: 30,
        variantQty: 5,
        reservedQty: 0,
        pickedQty: 2, // ship comes from already-picked stock
        packedQty: 0,
        backorderQty: 0,
        updatedAt: new Date(),
      })),
      adjustInventoryLevel: vi.fn(async () => null),
      createInventoryTransaction: vi.fn(async () => undefined),
    } as any;

    const shipFromLots = vi.fn(async () => undefined);
    const lotService = {
      withTx: vi.fn(() => ({ shipFromLots })),
    };

    // Spy cogsService: if recordShipment ever calls into it, this trips.
    const recordShipmentCOGS = vi.fn(async () => []);
    const cogsService = {
      withTx: vi.fn(() => ({ recordShipmentCOGS })),
      recordShipmentCOGS,
    } as any;

    const inventory = new InventoryUseCases(
      rootDb as any,
      storage,
      lotService as any,
      cogsService,
    );

    await inventory.recordShipment({
      productVariantId: 30,
      warehouseLocationId: 20,
      qty: 2,
      orderId: 40,
      orderItemId: 50,
      shipmentId: "SHIP-1",
      userId: "tester",
    });

    // The dead COGS path must never fire.
    expect(recordShipmentCOGS).not.toHaveBeenCalled();
    // Lot depletion at ship still happens (qty_picked -> shipped).
    expect(shipFromLots).toHaveBeenCalledTimes(1);
    // Audit transaction still written.
    expect(storage.createInventoryTransaction).toHaveBeenCalledTimes(1);
  });
});
