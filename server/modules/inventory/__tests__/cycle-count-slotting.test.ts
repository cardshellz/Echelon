import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function makeService() {
  const storage = {
    getWarehouseLocationById: vi.fn(),
    getProductLocationByComposite: vi.fn(),
    deleteProductLocation: vi.fn(),
    createProductLocation: vi.fn(),
    getProductById: vi.fn(),
  };

  const service = new CycleCountUseCases(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    storage as any,
    null,
  );

  return { service, storage };
}

describe("CycleCountUseCases slotting preservation", () => {
  it("does not clear a pick assignment when an expected SKU is missing", async () => {
    const { service, storage } = makeService();

    await (service as any).reconcileBinAssignment({
      id: 1,
      cycleCountId: 305,
      warehouseLocationId: 1143,
      productId: 3,
      productVariantId: 5,
      expectedSku: "SHLZ-TOP-180PT-CLR-P10",
      countedSku: null,
      countedQty: 0,
      varianceType: "unexpected_item",
      mismatchType: "expected_missing",
    });

    expect(storage.getProductLocationByComposite).not.toHaveBeenCalled();
    expect(storage.deleteProductLocation).not.toHaveBeenCalled();
    expect(storage.createProductLocation).not.toHaveBeenCalled();
  });

  it("does not create a pick assignment when an unexpected SKU is found", async () => {
    const { service, storage } = makeService();

    await (service as any).reconcileBinAssignment({
      id: 2,
      cycleCountId: 305,
      warehouseLocationId: 1143,
      productId: 232,
      productVariantId: 463,
      expectedSku: null,
      countedSku: "SHLZ-TOP-180PT-BLU-P10",
      countedQty: 14,
      varianceType: "unexpected_item",
      mismatchType: "unexpected_found",
    });

    expect(storage.getProductLocationByComposite).not.toHaveBeenCalled();
    expect(storage.deleteProductLocation).not.toHaveBeenCalled();
    expect(storage.createProductLocation).not.toHaveBeenCalled();
  });
});
