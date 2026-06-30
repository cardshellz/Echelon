import { describe, expect, it, vi } from "vitest";
import { createShipmentTrackingService, computeLotLandedMills } from "../../shipment-tracking.service";

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

describe("ShipmentTrackingService.updateLineDimensions", () => {
  it("re-runs allocation after line weight changes", async () => {
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
    const service = createShipmentTrackingService({} as any, storage);

    await service.updateLineDimensions(11, { weightKg: "2" });

    expect(storage.deleteAllocationsForShipment).toHaveBeenCalledWith(1);
    expect(storage.bulkCreateInboundFreightCostAllocations).toHaveBeenCalledWith([
      expect.objectContaining({
        shipmentCostId: 31,
        inboundShipmentLineId: 11,
        allocationBasisValue: "20",
        allocationBasisTotal: "20",
        allocatedCents: 1000,
      }),
    ]);
    expect(storage.updateInboundShipmentLine).toHaveBeenCalledWith(11, expect.objectContaining({
      allocatedCostCents: 1000,
      landedUnitCostCents: 100,
    }));
  });
});

describe("ShipmentTrackingService.close (dimension hard gate)", () => {
  it("refuses to close when a dimensional cost has lines missing dimensions", async () => {
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
    const service = createShipmentTrackingService({} as any, storage);

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

  it("matches lots to landed cost by PO LINE — even when the shipment line is product-level (null variant) and the lot is a case variant", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
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
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.pushLandedCostsToLots(1);

    // Joined on po_line 21 despite variant null vs 469; lot updated via raw SQL.
    expect(db.execute).toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, total: 1, skipped: [] });
  });

  it("skips a lot whose PO line has no finalized snapshot", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
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
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
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

  it("close() finalizes AND pushes landed cost to lots — no manual Push step", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
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
    const service = createShipmentTrackingService(db as any, storage);

    await service.close(1, "user-1");

    // Transitioned to closed AND pushed the finalized landed cost onto the lot (db.execute
    // is only used by the push's raw-SQL lot update) — no separate "Push Costs to Lots".
    expect(storage.updateInboundShipment).toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalled();
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
