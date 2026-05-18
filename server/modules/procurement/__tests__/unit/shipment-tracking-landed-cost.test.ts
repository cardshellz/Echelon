import { describe, expect, it, vi } from "vitest";
import { createShipmentTrackingService } from "../../shipment-tracking.service";

function buildStorage(overrides: Record<string, any> = {}) {
  return {
    db: { execute: vi.fn().mockResolvedValue({}) },
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
    getProvisionalLotsByShipment: vi.fn().mockResolvedValue([]),
    getInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundFreightCosts: vi.fn().mockResolvedValue([]),
    deleteAllocationsForShipment: vi.fn().mockResolvedValue(undefined),
    bulkCreateInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    updateInboundShipmentLine: vi.fn().mockResolvedValue({}),
    getAllocationsForLine: vi.fn().mockResolvedValue([]),
    getInboundFreightCostById: vi.fn().mockResolvedValue(null),
    getPurchaseOrderLineById: vi.fn().mockResolvedValue(null),
    getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    deleteLandedCostSnapshotsForShipment: vi.fn().mockResolvedValue(undefined),
    bulkCreateLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    createLandedCostAdjustment: vi.fn().mockResolvedValue({}),
    updateInventoryLot: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

const finalizedSnapshot = {
  inboundShipmentLineId: 11,
  purchaseOrderLineId: 21,
  productVariantId: 10,
  poUnitCostCents: 100,
  freightAllocatedCents: 0,
  dutyAllocatedCents: 0,
  insuranceAllocatedCents: 0,
  otherAllocatedCents: 0,
  totalLandedCostCents: 500,
  landedUnitCostCents: 100,
  qty: 5,
};

describe("ShipmentTrackingService.finalizeAllocations", () => {
  it("rejects finalization outside costing or closed status", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "delivered" }),
    });
    const service = createShipmentTrackingService({} as any, storage);

    await expect(service.finalizeAllocations(1, "user-1")).rejects.toThrow(
      "Landed costs can only be finalized while shipment is in costing or closed status",
    );
    expect(storage.getInboundShipmentLines).not.toHaveBeenCalled();
  });

  it("does not delete and recreate matching finalized snapshots on retry", async () => {
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5 },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([finalizedSnapshot]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(result).toEqual({ finalized: 1, unchanged: true, adjustments: 0 });
    expect(storage.deleteLandedCostSnapshotsForShipment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
    expect(storage.createLandedCostAdjustment).not.toHaveBeenCalled();
  });

  it("records an adjustment and refreshes snapshots when closed shipment costs change", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5 },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 50 },
      ]),
      getAllocationsForLine: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, allocatedCents: 50 },
      ]),
      getInboundFreightCostById: vi.fn().mockResolvedValue({ id: 31, costType: "freight" }),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([finalizedSnapshot]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(storage.createLandedCostAdjustment).toHaveBeenCalledWith({
      inboundShipmentLineId: 11,
      purchaseOrderLineId: 21,
      adjustmentAmountCents: 50,
      reason: "Post-close landed cost reallocation",
      createdBy: "user-1",
    });
    expect(storage.deleteLandedCostSnapshotsForShipment).toHaveBeenCalledWith(1);
    expect(storage.bulkCreateLandedCostSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        inboundShipmentLineId: 11,
        purchaseOrderLineId: 21,
        freightAllocatedCents: 50,
        totalLandedCostCents: 550,
        landedUnitCostCents: 110,
      }),
    ]);
    expect(result).toEqual({ finalized: 1, unchanged: false, adjustments: 1 });
  });
});

describe("ShipmentTrackingService.pushLandedCostsToLots", () => {
  it("rejects cancelled shipments", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "cancelled" }),
    });
    const service = createShipmentTrackingService({} as any, storage);

    await expect(service.pushLandedCostsToLots(1)).rejects.toThrow(
      "Cannot push landed costs for a cancelled shipment",
    );
    expect(storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
  });

  it("pushes finalized snapshot costs to provisional lots", async () => {
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 10, unitCostCents: 100, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, landedUnitCostCents: 999 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        { inboundShipmentLineId: 11, productVariantId: 10, poUnitCostCents: 100, landedUnitCostCents: 125 },
      ]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    expect(storage.updateInventoryLot).toHaveBeenCalledWith(501, {
      unitCostCents: 125,
      costProvisional: 0,
    });
    expect(storage.db.execute).toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, total: 1, skipped: [] });
  });

  it("does not use mutable shipment line cost before a finalized snapshot exists", async () => {
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 10, unitCostCents: 100, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, landedUnitCostCents: 300 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    expect(storage.updateInventoryLot).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: 0,
      total: 1,
      skipped: [
        {
          lotId: 501,
          productVariantId: 10,
          reason: "landed_cost_not_finalized",
          lineIds: undefined,
        },
      ],
    });
  });

  it("skips ambiguous same-variant shipment lines with different finalized costs", async () => {
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 10, unitCostCents: 100, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10 },
        { id: 12, productVariantId: 10 },
      ]),
      getLandedCostSnapshots: vi.fn((lineId: number) =>
        Promise.resolve([
          {
            inboundShipmentLineId: lineId,
            productVariantId: 10,
            poUnitCostCents: 100,
            landedUnitCostCents: lineId === 11 ? 125 : 150,
          },
        ]),
      ),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    expect(storage.updateInventoryLot).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: 0,
      total: 1,
      skipped: [
        {
          lotId: 501,
          productVariantId: 10,
          reason: "ambiguous_variant_landed_cost",
          lineIds: [11, 12],
        },
      ],
    });
  });
});
