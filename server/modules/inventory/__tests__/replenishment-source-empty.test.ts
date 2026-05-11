import { describe, expect, it, vi } from "vitest";

vi.mock("../../notifications/notifications.service", () => ({
  notify: vi.fn(async () => undefined),
}));
vi.mock("../../warehouse/settings.resolver", () => ({
  getSettingsForWarehouse: vi.fn(async () => null),
}));

import { ReplenishmentUseCases } from "../application/replenishment.use-cases";
import {
  cycleCountItems,
  cycleCounts,
  inventoryLevels,
  locationReplenConfig,
  productVariants,
  replenRules,
  replenTasks,
  replenTierDefaults,
  warehouseLocations,
} from "@shared/schema";

function makeDb() {
  const inserts: Array<{ table: unknown; value: any }> = [];
  const updates: Array<{ table: unknown; value: any }> = [];
  const selectCounts = new Map<unknown, number>();

  const pickVariant = {
    id: 100,
    sku: "SKU-1",
    name: "Each",
    productId: 10,
    hierarchyLevel: 1,
    unitsPerVariant: 1,
  };
  const pickLocation = { id: 1, code: "A-01", warehouseId: 7, parentLocationId: null };
  const sourceLocation = { id: 2, code: "B-01", warehouseId: 7, parentLocationId: null };
  const sourceLevel = { id: 22, warehouseLocationId: 2, productVariantId: 100, variantQty: 5 };

  const selectRows = (table: unknown) => {
    const count = selectCounts.get(table) ?? 0;
    selectCounts.set(table, count + 1);
    if (table === replenTasks) return [];
    if (table === productVariants) return [pickVariant];
    if (table === warehouseLocations) return count === 0 ? [pickLocation] : [sourceLocation];
    if (table === locationReplenConfig) return [];
    if (table === replenRules) return [];
    if (table === replenTierDefaults) return [];
    if (table === inventoryLevels) return [sourceLevel];
    return [];
  };

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: vi.fn(async () => selectRows(table)),
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: any) => {
        inserts.push({ table, value });
        const inserted = table === replenTasks
          ? { id: 121, ...value }
          : table === cycleCounts
            ? { id: 333, ...value }
            : { id: 444, ...value };
        return {
          returning: vi.fn(async () => [inserted]),
          then: (resolve: (value: any) => void) => Promise.resolve([inserted]).then(resolve),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: any) => {
        updates.push({ table, value });
        return { where: vi.fn(async () => []) };
      }),
    })),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };

  return { db, inserts, updates };
}

describe("ReplenishmentUseCases source-empty blockers", () => {
  it("creates a linked cycle count for picker-reported source-empty replen blockers", async () => {
    const { db, inserts, updates } = makeDb();
    const service = new ReplenishmentUseCases(db as any, {} as any);

    const task = await service.recordSourceEmptyBlocker({
      pickVariantId: 100,
      pickLocationId: 1,
      orderId: 900,
      orderItemId: 500,
      orderNumber: "#900",
      sku: "SKU-1",
      sourceLocationCode: "B-01",
      userId: "picker-1",
    });

    expect(task).toMatchObject({
      id: 121,
      status: "blocked",
      blocksShipment: true,
      exceptionReason: "source_empty",
      linkedCycleCountId: 333,
    });

    expect(inserts.find(insert => insert.table === cycleCounts)?.value).toMatchObject({
      name: "Replen Source Empty - Task #121",
      status: "in_progress",
      warehouseId: 7,
      totalBins: 1,
      createdBy: "picker-1",
    });
    expect(inserts.find(insert => insert.table === cycleCountItems)?.value).toMatchObject({
      cycleCountId: 333,
      warehouseLocationId: 2,
      productVariantId: 100,
      productId: 10,
      expectedSku: "SKU-1",
      expectedQty: 5,
      countedSku: "SKU-1",
      countedQty: 0,
      status: "pending",
      countedBy: "picker-1",
    });
    expect(updates.find(update => update.table === replenTasks)?.value).toMatchObject({
      linkedCycleCountId: 333,
    });
  });
});
