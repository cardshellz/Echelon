import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function makeService({
  cycleCount,
  locations,
}: {
  cycleCount: any;
  locations: any[];
}) {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(),
  };
  const storage = {
    getCycleCountById: vi.fn(async () => cycleCount),
    getAllWarehouseLocations: vi.fn(async () => locations),
    bulkCreateCycleCountItems: vi.fn(async (items: any[]) => items),
    updateCycleCount: vi.fn(async (_id: number, updates: any) => ({
      ...cycleCount,
      ...updates,
    })),
  };

  const service = new CycleCountUseCases(
    db as any,
    {} as any,
    {} as any,
    {} as any,
    storage as any,
  );

  return { db, service, storage };
}

describe("CycleCountUseCases.initialize", () => {
  it("rejects empty location scopes before creating count items", async () => {
    const { db, service, storage } = makeService({
      cycleCount: {
        id: 9,
        status: "draft",
        warehouseId: 1,
        locationCodes: "MISSING-01",
      },
      locations: [],
    });

    await expect(service.initialize(9)).rejects.toMatchObject({
      statusCode: 404,
      message: "No warehouse locations match cycle count scope: warehouse=1, locationCodes=MISSING-01",
    });

    expect(storage.bulkCreateCycleCountItems).not.toHaveBeenCalled();
    expect(storage.updateCycleCount).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects selected locations with active pickable non-pick metadata before writing count items", async () => {
    const { db, service, storage } = makeService({
      cycleCount: {
        id: 10,
        status: "draft",
        warehouseId: 35,
        locationCodes: "FLOOR-01",
      },
      locations: [
        {
          id: 1453,
          warehouseId: 35,
          code: "FLOOR-01",
          locationType: "storage",
          binType: "bin",
          isPickable: 1,
          isActive: 1,
        },
      ],
    });

    await expect(service.initialize(10)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("FLOOR-01 (warehouse=35)"),
    });

    expect(storage.bulkCreateCycleCountItems).not.toHaveBeenCalled();
    expect(storage.updateCycleCount).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("scopes location-code counts to the selected warehouse before validating duplicate bin codes", async () => {
    const { service, storage } = makeService({
      cycleCount: {
        id: 11,
        status: "draft",
        warehouseId: 1,
        locationCodes: "FLOOR-01",
      },
      locations: [
        {
          id: 1453,
          warehouseId: 35,
          code: "FLOOR-01",
          locationType: "storage",
          binType: "bin",
          isPickable: 1,
          isActive: 1,
        },
        {
          id: 1321,
          warehouseId: 1,
          code: "FLOOR-01",
          locationType: "pick",
          binType: "pallet",
          isPickable: 1,
          isActive: 1,
        },
      ],
    });

    await expect(service.initialize(11)).resolves.toEqual({
      success: true,
      binsCreated: 1,
      itemsCreated: 1,
    });

    expect(storage.bulkCreateCycleCountItems).toHaveBeenCalledWith([
      expect.objectContaining({
        cycleCountId: 11,
        warehouseLocationId: 1321,
        expectedQty: 0,
        status: "pending",
      }),
    ]);
  });
});
