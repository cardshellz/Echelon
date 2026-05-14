import { describe, expect, it, vi } from "vitest";

import { BinAssignmentService } from "../../bin-assignment.service";
import { validateWarehouseLocationIntegrity } from "../../location-integrity";

describe("warehouse location integrity", () => {
  it("requires active operational locations to belong to a warehouse", () => {
    expect(() => validateWarehouseLocationIntegrity({
      code: "A-FLOOR",
      locationType: "pick",
      isPickable: 1,
      isActive: 1,
      warehouseId: null,
    })).toThrow(/must be assigned to a warehouse/);
  });

  it("requires pickable locations to be pick locations", () => {
    expect(() => validateWarehouseLocationIntegrity({
      code: "A-FLOOR",
      locationType: "reserve",
      isPickable: 1,
      isActive: 1,
      warehouseId: 1,
    })).toThrow(/pickable but has location_type/);
  });

  it("allows inactive historical locations to remain orphaned for cleanup", () => {
    expect(() => validateWarehouseLocationIntegrity({
      code: "OLD-FLOOR",
      locationType: "pick",
      isPickable: 1,
      isActive: 0,
      warehouseId: null,
    })).not.toThrow();
  });

  it("blocks SKU assignment to orphan pick faces", async () => {
    const storage = {
      getProductVariantById: vi.fn(async () => ({ id: 206, productId: 91, sku: "SHLZ-TOP-35PT-BLU-C1000" })),
      getWarehouseLocationById: vi.fn(async () => ({
        id: 1354,
        code: "A-FLOOR",
        locationType: "pick",
        isPickable: 1,
        isActive: 1,
        warehouseId: null,
      })),
    };
    const service = new BinAssignmentService({} as any, storage as any);

    await expect(service.assignVariantToLocation({
      productVariantId: 206,
      warehouseLocationId: 1354,
    })).rejects.toThrow(/not assigned to a warehouse/);
  });
});
