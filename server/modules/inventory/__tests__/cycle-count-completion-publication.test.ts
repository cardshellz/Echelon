import { describe, expect, it, vi } from "vitest";
import type { CycleCountItem } from "@shared/schema";
import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";
import { projectCanonicalAtp, sealSupplySnapshot } from "../../inventory-planning/domain/inventory-availability-planner";
import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function stockSnapshot(frozen: boolean): SupplySnapshotContentDto {
  return {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: "2026-10-15T15:00:12.000Z",
    productId: 10,
    legacyInventoryStrategy: "physical_fungible",
    variants: [{ id: 164, productId: 10, sku: "QUAD-BOX-TRED-CLR-P4", name: "Pack 4", unitsPerVariant: 4, isActive: true }],
    warehouses: [{ id: 1, code: "LEON", isActive: true, hubWarehouseId: null }],
    locations: [{ id: 1198, warehouseId: 1, code: "D-16", locationType: "pick", isPickable: true,
      isActive: true, isFrozen: frozen, promisePolicy: null }],
    inventoryPositions: [{ inventoryLevelId: 1, warehouseLocationId: 1198, productVariantId: 164,
      variantQty: "500", reservedQty: "0", pickedQty: "3", packedQty: "0" }],
    safetyPolicies: [{ policyId: 1, version: 1, lifecycleSelection: "active_head", scopeKey: "business",
      scopeType: "business", productVariantId: null, warehouseId: null, policyMode: "fixed_units", fixedUnits: "0",
      daysOfCoverMilliDays: null, untrustedDemandFallbackUnits: null, demandMethodVersion: null, definitionHash: "a".repeat(64) }],
    demandEvidence: [],
    transformationModels: [{ modelId: 1, productId: 10, version: 1, lifecycleSelection: "active_head",
      lifecycleStatus: "sealed", buildToPromiseEnabled: false, definitionHash: "a".repeat(64),
      validationState: "valid", validationErrors: [], paths: [], recipeBindings: [] }],
    legacyRecipes: [],
    outputLocations: [],
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
}

function fixture(variantIds: Array<number | null> = [164]) {
  let frozen = true;
  const desired: string[] = [];
  const items = variantIds.map((productVariantId, index) => ({
    id: index + 1, cycleCountId: 500, warehouseLocationId: 1198,
    productVariantId, status: "approved", varianceType: null,
  })) as CycleCountItem[];
  const db = {
    execute: vi.fn(async () => { frozen = false; return { rows: [] }; }),
  };
  const storage = {
    getCycleCountById: vi.fn(async () => ({ id: 500, status: "in_progress" })),
    getCycleCountItems: vi.fn(async () => items),
    updateCycleCount: vi.fn(async () => {
      storage.getCycleCountById.mockResolvedValue({ id: 500, status: "completed" });
      return { id: 500, status: "completed" };
    }),
  };
  const currentAtp = () => {
    const projection = projectCanonicalAtp(sealSupplySnapshot(stockSnapshot(frozen)), {
      targetVariantId: 164, scope: { kind: "warehouse", warehouseId: 1 },
    });
    expect(projection.blockers).toEqual([]);
    return projection.atpUnits;
  };
  const channelSync = { queueSyncAfterInventoryChange: vi.fn(async (_id: number, _trigger?: string) => {
    desired.push(currentAtp());
  }) };
  const service = new CycleCountUseCases(db as never, {} as never, channelSync,
    {} as never, storage as never, {} as never);
  return { service, db, storage, channelSync, currentAtp, desired };
}

describe("cycle-count completion refreshes publication after freeze release", () => {
  it("replaces the frozen-bin zero with 500 using the real availability planner", async () => {
    const f = fixture();
    await f.channelSync.queueSyncAfterInventoryChange(164);
    expect(f.desired).toEqual(["0"]);

    await expect(f.service.complete(500)).resolves.toMatchObject({ success: true });

    expect(f.desired).toEqual(["0", "500"]);
    expect(f.channelSync.queueSyncAfterInventoryChange).toHaveBeenLastCalledWith(164, "cycle_count_completed");
  });

  it("refreshes unchanged counts once per SKU, ignoring items without a variant", async () => {
    const f = fixture([164, null, 164]);
    await f.service.complete(500);
    expect(f.channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledExactlyOnceWith(164, "cycle_count_completed");
    expect(f.desired).toEqual(["500"]);
  });

  it("does not publish if releasing the freeze fails", async () => {
    const f = fixture();
    f.db.execute.mockRejectedValueOnce(new Error("release failed"));
    await expect(f.service.complete(500)).rejects.toThrow("release failed");
    expect(f.channelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(f.currentAtp()).toBe("0");
  });

  it("reports refresh failure, attempts other SKUs, and permits retry without stock writes", async () => {
    const f = fixture([164, 165]);
    f.channelSync.queueSyncAfterInventoryChange.mockRejectedValueOnce(new Error("publication unavailable"));
    await expect(f.service.complete(500)).rejects.toMatchObject({ statusCode: 502 });
    expect(f.channelSync.queueSyncAfterInventoryChange.mock.calls.map(call => call[0])).toEqual([164, 165]);
    expect(f.currentAtp()).toBe("500");

    f.channelSync.queueSyncAfterInventoryChange.mockClear();
    await expect(f.service.complete(500)).resolves.toMatchObject({ success: true });
    expect(f.channelSync.queueSyncAfterInventoryChange.mock.calls.map(call => call[0])).toEqual([164, 165]);
    expect(f.db.execute).toHaveBeenCalledTimes(3); // release, then retry release + replen close
    expect(f.storage.updateCycleCount).toHaveBeenCalledTimes(1);
  });

  it("waits for the refresh before returning success", async () => {
    const f = fixture();
    let release!: () => void;
    const refresh = new Promise<void>(resolve => { release = resolve; });
    f.channelSync.queueSyncAfterInventoryChange.mockImplementationOnce(() => refresh);
    let completed = false;
    const completion = f.service.complete(500).then(() => { completed = true; });
    await vi.waitFor(() => expect(f.channelSync.queueSyncAfterInventoryChange).toHaveBeenCalled());
    expect(completed).toBe(false);
    release();
    await completion;
    expect(completed).toBe(true);
  });
});
