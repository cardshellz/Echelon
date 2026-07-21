import { describe, expect, it, vi } from "vitest";
import {
  allocateCentsByBasis,
  computeLotLandedMills,
  createShipmentTrackingService,
} from "../../shipment-tracking.service";

function buildTransactionalDb() {
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
  };
  const db = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { db, tx };
}

function buildTransactionalCogs() {
  const service = {
    updateLotLandedCostMills: vi.fn().mockResolvedValue({ lotId: 501 }),
    withTx: vi.fn(),
  };
  service.withTx.mockReturnValue(service);
  return service;
}

function buildStorage(overrides: Record<string, any> = {}) {
  return {
    db: { execute: vi.fn().mockResolvedValue({}) },
    getInboundShipments: vi.fn().mockResolvedValue([]),
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
    updateInboundShipment: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
    getProvisionalLotsByShipment: vi.fn().mockResolvedValue([]),
    getInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundShipmentLineById: vi.fn().mockResolvedValue(undefined),
    getInboundFreightCosts: vi.fn().mockResolvedValue([]),
    getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    createInboundFreightCost: vi.fn().mockResolvedValue({ id: 31, inboundShipmentId: 1 }),
    updateInboundFreightCost: vi.fn().mockResolvedValue({ id: 31, inboundShipmentId: 1 }),
    deleteInboundFreightCost: vi.fn().mockResolvedValue(true),
    deleteAllocationsForShipment: vi.fn().mockResolvedValue(undefined),
    bulkCreateInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    updateInboundShipmentLine: vi.fn().mockResolvedValue({}),
    getAllocationsForLine: vi.fn().mockResolvedValue([]),
    getInboundFreightCostById: vi.fn().mockResolvedValue(null),
    getPurchaseOrderLineById: vi.fn().mockResolvedValue(null),
    getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    getLandedCostSnapshotByPoLine: vi.fn().mockResolvedValue(null),
    deleteLandedCostSnapshotsForShipment: vi.fn().mockResolvedValue(undefined),
    bulkCreateLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    createLandedCostAdjustment: vi.fn().mockResolvedValue({}),
    updateInventoryLot: vi.fn().mockResolvedValue({}),
    getProductVariantById: vi.fn().mockResolvedValue({ id: 10, unitsPerVariant: 1 }),
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

describe("ShipmentTrackingService.getAllocationStatus", () => {
  it("reports costs that still need allocation", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, totalVolumeCbm: "1.2" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: null },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getAllocationStatus(1);

    expect(result.status).toBe("needs_allocation");
    expect(result.effectiveCostCents).toBe(1200);
    expect(result.allocatedCostCents).toBe(0);
    expect(result.unallocatedCents).toBe(1200);
    expect(result.blockerCount).toBe(1);
    expect(result.costs[0]).toEqual(expect.objectContaining({
      costId: 31,
      method: "by_volume",
      methodSource: "shipment_default",
      status: "needs_allocation",
    }));
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: "cost_not_allocated",
      costId: 31,
      severity: "blocker",
    }));
  });

  it("escalates a dimensional method with missing line dimensions to a BLOCKER", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, totalWeightKg: "0" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: "by_weight" },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 1200 },
      ]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getAllocationStatus(1);

    expect(result.status).toBe("needs_allocation");
    expect(result.blockerCount).toBe(1);
    expect(result.warningCount).toBe(0);
    expect(result.costs[0]).toEqual(expect.objectContaining({ costId: 31, status: "missing_dimensions" }));
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: "missing_dimensions",
      severity: "blocker",
      costId: 31,
    }));
  });

  it("keeps NON-dimensional (by_value) fallback as a warning, not a blocker", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, purchaseOrderLineId: 21 },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: "by_value" },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 1200 },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, unitCostCents: 0 }),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getAllocationStatus(1);

    expect(result.blockerCount).toBe(0);
    expect(result.warningCount).toBe(1);
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: "allocation_basis_fallback",
      severity: "warning",
    }));
  });

  it("flags allocations whose saved basis no longer matches current line basis", async () => {
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_chargeable_weight" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, chargeableWeightKg: "29" },
        { id: 12, sku: "SKU-2", qtyShipped: 5, chargeableWeightKg: "26" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 44660, allocationMethod: null },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "2", allocatedCents: 22330 },
        { shipmentCostId: 31, inboundShipmentLineId: 12, allocationBasisValue: "1", allocationBasisTotal: "2", allocatedCents: 22330 },
      ]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getAllocationStatus(1);

    expect(result.status).toBe("needs_allocation");
    expect(result.blockerCount).toBe(1);
    expect(result.costs[0]).toEqual(expect.objectContaining({
      costId: 31,
      status: "stale_allocation_basis",
      rawBasisTotal: 55,
      basisTotal: 55,
    }));
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: "stale_allocation_basis",
      severity: "blocker",
      costId: 31,
    }));
  });
});

describe("ShipmentTrackingService.getEnrichedLines", () => {
  it("returns PO SKU, mills unit costs, and allocation category breakdowns for the allocation tab", async () => {
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 11,
          sku: null,
          purchaseOrderLineId: 21,
          productVariantId: null,
          qtyShipped: 5,
          allocatedCostCents: 1275,
          landedUnitCostCents: 355,
        },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1000 },
        { id: 32, costType: "brokerage", actualCents: 200 },
        { id: 33, costType: "insurance", actualCents: 50 },
        { id: 34, costType: "warehousing", actualCents: 25 },
      ]),
      getInboundFreightCostAllocations: vi.fn((costId: number) => Promise.resolve(({
        31: [{ shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 1000 }],
        32: [{ shipmentCostId: 32, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 200 }],
        33: [{ shipmentCostId: 33, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 50 }],
        34: [{ shipmentCostId: 34, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 25 }],
      } as Record<number, any[]>)[costId] ?? [])),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({
        id: 21,
        sku: "PO-SKU",
        productName: "PO Product",
        orderQty: 5,
        unitCostCents: 100,
        unitCostMills: 10000,
      }),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getEnrichedLines(1);

    expect(result[0]).toEqual(expect.objectContaining({
      sku: "PO-SKU",
      productName: "PO Product",
      poQtyOrdered: 5,
      poUnitCostCents: 100,
      poUnitCostMills: 10000,
      allocatedCostCents: 1275,
      freightAllocatedCents: 1000,
      dutyAllocatedCents: 200,
      insuranceAllocatedCents: 50,
      otherAllocatedCents: 25,
      freightAllocatedMillsPerUnit: 20000,
      dutyAllocatedMillsPerUnit: 4000,
      insuranceAllocatedMillsPerUnit: 1000,
      otherAllocatedMillsPerUnit: 500,
      totalAllocatedMillsPerUnit: 25500,
      landedUnitCostMills: 35500,
    }));
  });
});

describe("ShipmentTrackingService.getLandedCostMillsForPoLine", () => {
  it("reconstructs finalized landed unit cost in mills from snapshot allocations", async () => {
    const storage = buildStorage({
      getLandedCostSnapshotByPoLine: vi.fn().mockResolvedValue({
        purchaseOrderLineId: 21,
        poUnitCostCents: 100,
        freightAllocatedCents: 1,
        dutyAllocatedCents: 0,
        insuranceAllocatedCents: 0,
        otherAllocatedCents: 0,
        landedUnitCostCents: 100,
        qty: 3,
      }),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({
        id: 21,
        unitCostMills: 10000,
        unitCostCents: 100,
      }),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getLandedCostMillsForPoLine(21);

    expect(result).toBe(10033);
    expect(storage.getLandedCostSnapshotByPoLine).toHaveBeenCalledWith(21);
    expect(storage.getPurchaseOrderLineById).toHaveBeenCalledWith(21);
  });
});

describe("ShipmentTrackingService.updateLineDimensions", () => {
  it("re-runs allocation after line weight changes", async () => {
    const { db, tx } = buildTransactionalDb();
    const originalLine = {
      id: 11,
      inboundShipmentId: 1,
      sku: "SKU-1",
      qtyShipped: 10,
      cartonCount: null,
      weightKg: "1",
      lengthCm: null,
      widthCm: null,
      heightCm: null,
    };
    const updatedLine = {
      ...originalLine,
      weightKg: "2",
      totalWeightKg: "20",
      chargeableWeightKg: "20",
    };
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_weight" }),
      getInboundShipmentLineById: vi.fn()
        .mockResolvedValueOnce(originalLine)
        .mockResolvedValueOnce(updatedLine),
      getInboundShipmentLines: vi.fn().mockResolvedValue([updatedLine]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1000, allocationMethod: "by_weight" },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await service.updateLineDimensions(11, { weightKg: "2" });

    expect(storage.deleteAllocationsForShipment).toHaveBeenCalledWith(1, tx);
    expect(storage.bulkCreateInboundFreightCostAllocations).toHaveBeenCalledWith([
      expect.objectContaining({
        shipmentCostId: 31,
        inboundShipmentLineId: 11,
        allocationBasisValue: "20",
        allocationBasisTotal: "20",
        allocatedCents: 1000,
      }),
    ], tx);
    expect(storage.updateInboundShipmentLine).toHaveBeenCalledWith(11, expect.objectContaining({
      allocatedCostCents: 1000,
      landedUnitCostCents: 100,
    }), tx);
  });
});

describe("ShipmentTrackingService.close (dimension hard gate)", () => {
  it("refuses to close when a dimensional cost has lines missing dimensions", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, totalVolumeCbm: "0" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: "by_volume" },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocatedCents: 1200 },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(service.close(1, "user-1")).rejects.toThrow(/dimension/i);
    // gate fires before any allocation/state change
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
  });
});

describe("ShipmentTrackingService.getLandedCostHealth", () => {
  it("reports closed shipments with stale provisional lots", async () => {
    const storage = buildStorage({
      getInboundShipments: vi.fn().mockResolvedValue([
        { id: 1, shipmentNumber: "INB-1", status: "closed", allocationMethodDefault: "by_volume" },
      ]),
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5, totalVolumeCbm: "1" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 500 },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 500 },
      ]),
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 10, costProvisional: 1 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        { inboundShipmentLineId: 11, landedUnitCostCents: 110 },
      ]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getLandedCostHealth({ limit: 25 });

    expect(storage.getInboundShipments).toHaveBeenCalledWith({ status: ["costing", "closed"], limit: 25 });
    expect(result.status).toBe("critical");
    expect(result.counts.staleProvisionalLots).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      type: "stale_provisional_lots",
      severity: "critical",
      shipmentId: 1,
      provisionalLotCount: 1,
      action: "push_costs_to_lots",
    }));
  });

  it("reports finalized costing shipments that still need costs pushed to lots", async () => {
    const storage = buildStorage({
      getInboundShipments: vi.fn().mockResolvedValue([
        { id: 1, shipmentNumber: "INB-1", status: "costing", allocationMethodDefault: "by_volume" },
      ]),
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5, totalVolumeCbm: "1" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 500 },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 500 },
      ]),
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 10, costProvisional: 1 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        { inboundShipmentLineId: 11, landedUnitCostCents: 110 },
      ]),
    });
    const service = createShipmentTrackingService({} as any, storage);

    const result = await service.getLandedCostHealth();

    expect(result.status).toBe("warning");
    expect(result.counts.finalizedNotPushed).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      type: "finalized_not_pushed",
      severity: "warning",
      shipmentId: 1,
      action: "push_costs_to_lots",
    }));
  });
});

describe("ShipmentTrackingService.finalizeAllocations", () => {
  it("rejects finalization outside costing or closed status", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "delivered" }),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(service.finalizeAllocations(1, "user-1")).rejects.toThrow(
      "Landed costs can only be finalized while shipment is in costing or closed status",
    );
    expect(storage.getInboundShipmentLines).not.toHaveBeenCalled();
  });

  it("rejects direct finalization when a dimensional allocation is missing its basis", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing", allocationMethodDefault: "by_weight" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 5, totalWeightKg: "0" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: "by_weight" },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocatedCents: 1200 },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(service.finalizeAllocations(1, "user-1")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ code: "MISSING_ALLOCATION_DIMENSIONS" }),
    });
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
    expect(storage.deleteLandedCostSnapshotsForShipment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
  });

  it("does not delete and recreate matching finalized snapshots on retry", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5 },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([finalizedSnapshot]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(result).toEqual({ finalized: 1, unchanged: true, adjustments: 0 });
    expect(storage.deleteLandedCostSnapshotsForShipment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
    expect(storage.createLandedCostAdjustment).not.toHaveBeenCalled();
  });

  it("records an adjustment and refreshes snapshots when closed shipment costs change", async () => {
    const { db, tx } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderLineId: 21, qtyShipped: 5, totalVolumeCbm: "1" },
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
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(storage.createLandedCostAdjustment).toHaveBeenCalledWith({
      inboundShipmentLineId: 11,
      purchaseOrderLineId: 21,
      adjustmentAmountCents: 50,
      reason: "Post-close landed cost reallocation",
      createdBy: "user-1",
    }, tx);
    expect(storage.deleteLandedCostSnapshotsForShipment).toHaveBeenCalledWith(1, tx);
    expect(storage.bulkCreateLandedCostSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        inboundShipmentLineId: 11,
        purchaseOrderLineId: 21,
        freightAllocatedCents: 50,
        totalLandedCostCents: 550,
        landedUnitCostCents: 110,
      }),
    ], tx);
    expect(result).toEqual({ finalized: 1, unchanged: false, adjustments: 1 });
  });
});

describe("ShipmentTrackingService.pushLandedCostsToLots", () => {
  it("rejects cancelled shipments", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "cancelled" }),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(service.pushLandedCostsToLots(1)).rejects.toThrow(
      "Cannot push landed costs for a cancelled shipment",
    );
    expect(storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
  });

  it("matches lots to landed cost by PO LINE — even when the shipment line is product-level (null variant) and the lot is a case variant", async () => {
    const { db, tx } = buildTransactionalDb();
    const cogs = buildTransactionalCogs();
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: 21, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        { inboundShipmentLineId: 11, purchaseOrderLineId: 21, poUnitCostCents: 70, freightAllocatedCents: 1000, dutyAllocatedCents: 0, insuranceAllocatedCents: 0, otherAllocatedCents: 0, totalLandedCostCents: 2400, landedUnitCostCents: 120, qty: 20 },
      ]),
      getProductVariantById: vi.fn().mockResolvedValue({ id: 469, unitsPerVariant: 10 }),
    });
    const service = createShipmentTrackingService(db as any, storage, cogs as any);

    const result = await service.pushLandedCostsToLots(1);

    // Joined on po_line 21 despite variant null vs 469; COGS owns lot recost + cascade.
    expect(cogs.withTx).toHaveBeenCalledWith(tx);
    expect(cogs.updateLotLandedCostMills).toHaveBeenCalledWith(501, 50000);
    expect(db.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, total: 1, skipped: [] });
  });

  it("skips a lot whose PO line has no finalized snapshot", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: 21, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    expect(db.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: 0,
      total: 1,
      skipped: [{ lotId: 501, productVariantId: 469, reason: "landed_cost_not_finalized" }],
    });
  });

  it("skips a lot with no PO line link", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: null, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20 },
      ]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        { inboundShipmentLineId: 11, purchaseOrderLineId: 21, totalLandedCostCents: 2400, freightAllocatedCents: 1000, qty: 20 },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    expect(db.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: 0,
      total: 1,
      skipped: [{ lotId: 501, productVariantId: 469, reason: "lot_missing_po_line" }],
    });
  });

  it("does not revalue any lot when another lot fails preflight", async () => {
    const { db } = buildTransactionalDb();
    const cogs = buildTransactionalCogs();
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: 21, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
        { id: 502, productVariantId: 470, poLineId: 22, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20 },
        { id: 12, productVariantId: null, purchaseOrderLineId: 22, qtyShipped: 20 },
      ]),
      getLandedCostSnapshots: vi.fn()
        .mockResolvedValueOnce([
          { inboundShipmentLineId: 11, purchaseOrderLineId: 21, totalLandedCostCents: 2400, freightAllocatedCents: 1000, qty: 20 },
        ])
        .mockResolvedValueOnce([]),
      getProductVariantById: vi.fn().mockResolvedValue({ id: 469, unitsPerVariant: 10 }),
    });
    const service = createShipmentTrackingService(db as any, storage, cogs as any);

    const result = await service.pushLandedCostsToLots(1);

    expect(result).toEqual({
      updated: 0,
      total: 2,
      skipped: [{ lotId: 502, productVariantId: 470, reason: "landed_cost_not_finalized" }],
    });
    expect(cogs.withTx).not.toHaveBeenCalled();
    expect(cogs.updateLotLandedCostMills).not.toHaveBeenCalled();
  });

  it("rejects the transaction when any lot revaluation fails", async () => {
    const { db, tx } = buildTransactionalDb();
    const cogs = buildTransactionalCogs();
    cogs.updateLotLandedCostMills
      .mockResolvedValueOnce({ lotId: 501 })
      .mockRejectedValueOnce(new Error("lot write failed"));
    const storage = buildStorage({
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: 21, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
        { id: 502, productVariantId: 470, poLineId: 22, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
      ]),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20 },
        { id: 12, productVariantId: null, purchaseOrderLineId: 22, qtyShipped: 20 },
      ]),
      getLandedCostSnapshots: vi.fn()
        .mockResolvedValueOnce([
          { inboundShipmentLineId: 11, purchaseOrderLineId: 21, totalLandedCostCents: 2400, freightAllocatedCents: 1000, qty: 20 },
        ])
        .mockResolvedValueOnce([
          { inboundShipmentLineId: 12, purchaseOrderLineId: 22, totalLandedCostCents: 2400, freightAllocatedCents: 1000, qty: 20 },
        ]),
      getProductVariantById: vi.fn().mockImplementation(async (id: number) => ({ id, unitsPerVariant: 10 })),
    });
    const service = createShipmentTrackingService(db as any, storage, cogs as any);

    await expect(service.pushLandedCostsToLots(1)).rejects.toMatchObject({
      statusCode: 500,
      details: expect.objectContaining({
        code: "LANDED_COST_LOT_REVALUE_FAILED",
        lotId: 502,
      }),
    });

    expect(cogs.withTx).toHaveBeenCalledWith(tx);
    expect(cogs.updateLotLandedCostMills).toHaveBeenCalledTimes(2);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("close() finalizes AND pushes landed cost to lots — no manual Push step", async () => {
    const { db } = buildTransactionalDb();
    const cogs = buildTransactionalCogs();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
      updateInboundShipment: vi.fn().mockResolvedValue({}),
      createInboundShipmentStatusHistory: vi.fn().mockResolvedValue({}),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        // has volume so the by_volume dimension gate passes and close proceeds to push
        { id: 11, productVariantId: null, purchaseOrderLineId: 21, qtyShipped: 20, totalVolumeCbm: "2.0" },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, unitCostCents: 70 }),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "freight", actualCents: 1000 }]),
      getAllocationsForLine: vi.fn().mockResolvedValue([{ shipmentCostId: 31, allocatedCents: 1000 }]),
      getInboundFreightCostById: vi.fn().mockResolvedValue({ id: 31, costType: "freight" }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([{
        inboundShipmentLineId: 11, purchaseOrderLineId: 21, poUnitCostCents: 70,
        freightAllocatedCents: 1000, dutyAllocatedCents: 0, insuranceAllocatedCents: 0, otherAllocatedCents: 0,
        totalLandedCostCents: 2400, landedUnitCostCents: 120, qty: 20,
      }]),
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([
        { id: 501, productVariantId: 469, poLineId: 21, poUnitCostMills: 70000, packagingCostMills: 0, costProvisional: 1 },
      ]),
      getProductVariantById: vi.fn().mockResolvedValue({ id: 469, unitsPerVariant: 10 }),
    });
    const service = createShipmentTrackingService(db as any, storage, cogs as any);

    await service.close(1, "user-1");

    // Transitioned to closed AND pushed finalized landed cost through the COGS authority.
    expect(storage.updateInboundShipment).toHaveBeenCalled();
    expect(cogs.updateLotLandedCostMills).toHaveBeenCalledWith(501, 50000);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("allocateCentsByBasis", () => {
  it("preserves the exact total and breaks equal remainders by line id", () => {
    const allocations = allocateCentsByBasis(2, [
      { lineId: 30, basis: 1 },
      { lineId: 10, basis: 1 },
      { lineId: 20, basis: 1 },
    ]);

    expect(allocations.reduce((sum, row) => sum + row.allocatedCents, 0)).toBe(2);
    expect(allocations).toEqual([
      expect.objectContaining({ lineId: 30, allocatedCents: 0 }),
      expect.objectContaining({ lineId: 10, allocatedCents: 1 }),
      expect.objectContaining({ lineId: 20, allocatedCents: 1 }),
    ]);
  });
});

describe("ShipmentTrackingService cost mutation integrity", () => {
  it("propagates allocation failure from the same transaction as cost creation", async () => {
    const { db, tx } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, sku: "SKU-1", qtyShipped: 0, totalWeightKg: "1" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, inboundShipmentId: 1, costType: "freight", actualCents: 100, allocationMethod: "by_weight" },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(service.addCost(1, { costType: "freight", actualCents: 100 })).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "INVALID_SHIPMENT_LINE_QUANTITY" }),
    });

    expect(storage.createInboundFreightCost).toHaveBeenCalledWith(
      expect.objectContaining({ inboundShipmentId: 1, costType: "freight", actualCents: 100 }),
      tx,
    );
    expect(storage.updateInboundShipment).toHaveBeenCalledWith(1, expect.any(Object), tx);
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("computeLotLandedMills", () => {
  it("allocates freight per case in mills, folding into product + packaging", () => {
    // $10.00 freight (1000c) over 20 pieces; lot = Case-of-10, product $7.00/case = 70000 mills.
    // freight/case = round_half_up(1000 × 100 × 10 / 20) = 50000 mills ($5.00).
    const out = computeLotLandedMills({
      landedNonProductCents: 1000, unitsPerVariant: 10, qty: 20,
      poUnitCostMills: 70000, packagingCostMills: 0,
    });
    expect(out.landedCostMills).toBe(50000);
    expect(out.totalMills).toBe(120000);
    expect(out.totalCents).toBe(1200);
  });

  it("rounds half-up once from the line total — no per-piece amplification", () => {
    // freight 1800c over 150 pieces, Case-of-50: round(1800 × 100 × 50 / 150) = 60000 mills.
    const out = computeLotLandedMills({
      landedNonProductCents: 1800, unitsPerVariant: 50, qty: 150,
      poUnitCostMills: 333333, packagingCostMills: 0,
    });
    expect(out.landedCostMills).toBe(60000);
    expect(out.totalMills).toBe(393333);
  });
});
