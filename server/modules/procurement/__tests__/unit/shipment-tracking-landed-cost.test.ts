import { describe, expect, it, vi } from "vitest";
import { createShipmentTrackingService } from "../../shipment-tracking.service";

function buildStorage(overrides: Record<string, any> = {}) {
  return {
    db: { execute: vi.fn().mockResolvedValue({}) },
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
    getProvisionalLotsByShipment: vi.fn().mockResolvedValue([]),
    getInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    updateInventoryLot: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

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
