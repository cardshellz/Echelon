import { readShipmentCostReviewInTransaction } from "../../shipment-cost-review.repository";
import { readShipmentHealthEvidence, type ShipmentHealthReadEvidence } from "../../shipment-health-evidence.repository";
vi.mock("../../shipment-health-evidence.repository", () => ({ readShipmentHealthEvidence: vi.fn() }));
import { shipmentCostReviewSchema, type ShipmentCostReview } from "@shared/procurement/shipment-cost-workflow";
import { landedCostHealthSchema } from "@shared/procurement/landed-cost-health";
vi.mock("../../shipment-cost-review.repository", () => ({ readShipmentCostReview: vi.fn(), readShipmentCostReviewInTransaction: vi.fn() }));
import { recordShipmentCostRevisions, applyShipmentCostRevisions } from "../../shipment-cost-application.service";
vi.mock("../../shipment-cost-application.service", () => ({ recordShipmentCostRevisions: vi.fn(), applyShipmentCostRevisions: vi.fn() }));
import { shipmentLineVersion } from "../../shipment-line-version";
import { buildShipmentAllocationBasis, buildShipmentAllocationEvidence } from "../../domain/shipment-allocation-basis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  allocateCentsByBasis,
  computeLotLandedMills,
  createShipmentTrackingService,
} from "../../shipment-tracking.service";

beforeEach(() => {
  vi.mocked(readShipmentCostReviewInTransaction).mockReset().mockResolvedValue({ shipmentId: 1,
    lines: [{ lineId: 11, sku: "SKU-1", sourceIssue: null, exceptionReview: null, application: null }] });
  vi.mocked(recordShipmentCostRevisions).mockReset().mockResolvedValue({ revisions: [], issues: [] } as any);
  vi.mocked(applyShipmentCostRevisions).mockReset().mockResolvedValue({ updated: 0, total: 0, skipped: [], costApplications: [] });
});

function buildTransactionalDb() {
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
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
  const storage = {
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
    getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 1, currency: "USD" }),
    getLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    getLandedCostSnapshotByPoLine: vi.fn().mockResolvedValue(null),
    deleteLandedCostSnapshotsForShipment: vi.fn().mockResolvedValue(undefined),
    bulkCreateLandedCostSnapshots: vi.fn().mockResolvedValue([]),
    createLandedCostAdjustment: vi.fn().mockResolvedValue({}),
    updateInventoryLot: vi.fn().mockResolvedValue({}),
    getProductVariantById: vi.fn().mockResolvedValue({ id: 10, unitsPerVariant: 1 }),
    ...overrides,
  } as any;
  // Preserve the existing scenarios at the raw evidence boundary. The real
  // batched SQL/grouping is covered by repository and PostgreSQL tests.
  vi.mocked(readShipmentHealthEvidence).mockImplementation(async (tx, ids) => {
    const result = new Map<number, ShipmentHealthReadEvidence>();
    for (const id of ids) {
      const lines = await storage.getInboundShipmentLines(id, tx);
      const costs = await storage.getInboundFreightCosts(id, tx);
      result.set(id, { lines, costs, provisionalLots: await storage.getProvisionalLotsByShipment(id, tx),
        allocationsByCostId: new Map(await Promise.all(costs.map(async (cost: any) => [cost.id, await storage.getInboundFreightCostAllocations(cost.id, tx)]))),
        snapshotsByLineId: new Map((await Promise.all(lines.map((line: any) => storage.getLandedCostSnapshots(line.id, tx)))).flat().map((snapshot: any) => [snapshot.inboundShipmentLineId, snapshot])),
        purchaseLinesById: new Map((await Promise.all(lines.filter((line: any) => line.purchaseOrderLineId != null).map((line: any) => storage.getPurchaseOrderLineById(line.purchaseOrderLineId, tx)))).filter(Boolean).map((line: any) => [line.id, line])),
        purchaseOrdersById: new Map((await Promise.all(lines.filter((line: any) => line.purchaseOrderId != null).map((line: any) => storage.getPurchaseOrderById(line.purchaseOrderId, tx)))).filter(Boolean).map((order: any) => [order.id, order])),
      });
    }
    return result;
  });
  return storage;
}

function productValueEvidence(totalProductCostCents: number, orderQty = 5, qtyShipped = 5) {
  return buildShipmentAllocationEvidence(buildShipmentAllocationBasis([{ lineId: 11, poLineId: 21,
    poOrderQty: orderQty, poTotalProductCostCents: totalProductCostCents, qtyShipped, poCurrency: "USD",
    totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null }], "by_value"), 11);
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
  productValueEvidence: productValueEvidence(500),
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
        { id: 11, sku: "SKU-1", qtyShipped: 5, purchaseOrderId: 1, purchaseOrderLineId: 21 },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1200, allocationMethod: "by_value" },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, inboundShipmentLineId: 11, allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 1200,
          basisEvidence: productValueEvidence(0) },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 5, totalProductCostCents: 0, unitCostCents: 0 }),
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

  it("requires an explicit rerun for legacy value rows even when their cent mirrors still match", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, qtyShipped: 5, purchaseOrderId: 1, purchaseOrderLineId: 21 }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 5,
        totalProductCostCents: 500, unitCostCents: 100 }),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "duty", actualCents: 1200 }]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([{ shipmentCostId: 31, inboundShipmentLineId: 11,
        allocationBasisValue: "500", allocationBasisTotal: "500", allocatedCents: 1200 }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    const stale = await service.getAllocationStatus(1);
    expect(stale.blockerCount).toBe(1);
    expect(stale.costs[0].status).toBe("stale_allocation_basis");
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
    await service.runAllocation(1);
    const saved = storage.bulkCreateInboundFreightCostAllocations.mock.calls[0][0];
    expect(saved).toEqual([expect.objectContaining({ allocatedCents: 1200, basisEvidence: productValueEvidence(500) })]);
    storage.getInboundFreightCostAllocations.mockResolvedValue(saved);
    expect((await service.getAllocationStatus(1)).blockerCount).toBe(0);
  });

  it("reports missing product totals for review and rejects allocation before replacing rows", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, qtyShipped: 5, purchaseOrderId: 1, purchaseOrderLineId: 21 }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 5,
        totalProductCostCents: null, unitCostCents: 100 }),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "duty", actualCents: 1200 }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    expect((await service.getAllocationStatus(1)).issues).toEqual([expect.objectContaining({ code: "invalid_value_basis", severity: "blocker" })]);
    await expect(service.runAllocation(1)).rejects.toMatchObject({ statusCode: 409, details: { code: "INVALID_ALLOCATION_BASIS" } });
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
    expect(storage.updateInboundShipmentLine).not.toHaveBeenCalled();
  });

  it.each(["by_weight", "by_volume", "by_line_count"])("reports invalid product sources even when %s allocations reconcile", async (method) => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, sku: "SKU-1", qtyShipped: 5,
        purchaseOrderId: 1, purchaseOrderLineId: 21, totalWeightKg: "1", totalVolumeCbm: "1" }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product",
        orderQty: 5, totalProductCostCents: null }),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "freight", actualCents: 1200, allocationMethod: method }]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([{ shipmentCostId: 31, inboundShipmentLineId: 11,
        allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 1200 }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    const status = await service.getAllocationStatus(1);
    expect(status).toMatchObject({ status: "needs_allocation", blockerCount: 1,
      costs: [expect.objectContaining({ status: "allocated" })],
      issues: [expect.objectContaining({ code: "invalid_product_value", lineId: 11, severity: "blocker" })] });
    expect(status.issues[0].message).toContain("SKU-1");
    await expect(service.finalizeAllocations(1)).rejects.toMatchObject({ statusCode: 409,
      details: { code: "INVALID_ALLOCATION_BASIS" } });
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
  });

  it.each([{ costs: [] }, { costs: [{ id: 31, costType: "freight", actualCents: 0 }] }])("checks the product snapshot source when charges are $costs", async ({ costs }) => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, qtyShipped: 5, purchaseOrderId: 1, purchaseOrderLineId: 21 }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product",
        orderQty: 5, totalProductCostCents: 100 }),
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 1, currency: "EUR" }),
      getInboundFreightCosts: vi.fn().mockResolvedValue(costs),
    });
    const service = createShipmentTrackingService(db as any, storage);
    expect(await service.getAllocationStatus(1)).toMatchObject({ status: "needs_allocation", blockerCount: 1,
      issues: [expect.objectContaining({ code: "invalid_product_value", lineId: 11 })] });
    await expect(service.finalizeAllocations(1)).rejects.toMatchObject({ statusCode: 409,
      details: { code: "INVALID_ALLOCATION_BASIS" } });
    storage.getPurchaseOrderById.mockResolvedValue({ id: 1, currency: "USD" });
    expect(await service.getAllocationStatus(1)).toMatchObject({ status: "no_costs", blockerCount: 0, issues: [] });
  });

  it.each([{ purchaseOrderId: null, purchaseOrderLineId: 21 }, { purchaseOrderId: 1, purchaseOrderLineId: null }])(
    "preserves legacy orphan source handling for %j", async (source) => {
      const storage = buildStorage({ getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, qtyShipped: 5, ...source }]) });
      const service = createShipmentTrackingService({} as any, storage);
      expect(await service.getAllocationStatus(1)).toMatchObject({ status: "no_costs", blockerCount: 0, issues: [] });
      expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
    },
  );

  it("does not disguise a source read failure as invalid product evidence", async () => {
    const failure = new Error("Source database unavailable");
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, qtyShipped: 5, purchaseOrderId: 1, purchaseOrderLineId: 21 }]),
      getPurchaseOrderLineById: vi.fn().mockRejectedValue(failure),
    });
    await expect(createShipmentTrackingService({} as any, storage).getAllocationStatus(1)).rejects.toBe(failure);
  });
});

describe("ShipmentTrackingService.getEnrichedLines", () => {
  it("returns PO SKU, mills unit costs, and allocation category breakdowns for the allocation tab", async () => {
    const storage = buildStorage({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 11,
          sku: null,
          purchaseOrderId: 1,
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
        purchaseOrderId: 1,
        lineType: "product",
        sku: "PO-SKU",
        productName: "PO Product",
        orderQty: 5,
        totalProductCostCents: 500,
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

  it("uses finalized product evidence after the current PO price changes", async () => {
    const storage = buildStorage({
      getLandedCostSnapshotByPoLine: vi.fn().mockResolvedValue({ ...finalizedSnapshot, freightAllocatedCents: 1,
        qty: 3, productValueEvidence: productValueEvidence(300, 3, 3) }),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product",
        orderQty: 3, totalProductCostCents: 900, unitCostCents: 300, unitCostMills: 30000 }),
    });
    const service = createShipmentTrackingService({} as any, storage);
    expect(await service.getLandedCostMillsForPoLine(21)).toBe(10033);
    expect(await service.getLandedCostForPoLine(21)).toBe(100);
    expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
  });

  it("rejects forged frozen product values instead of falling back to the live PO", async () => {
    const evidence = productValueEvidence(300, 3, 3);
    const storage = buildStorage({
      getLandedCostSnapshotByPoLine: vi.fn().mockResolvedValue({ ...finalizedSnapshot, qty: 3,
        productValueEvidence: { ...evidence, rawRatio: { numerator: "900", denominator: "1" } } }),
    });
    const service = createShipmentTrackingService({} as any, storage);
    await expect(service.getLandedCostMillsForPoLine(21)).rejects.toMatchObject({ statusCode: 409,
      details: { code: "LANDED_SNAPSHOT_VALUE_EVIDENCE_INVALID" } });
    expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
  });
});

describe("ShipmentTrackingService direct command lock order", () => {
  it.each(["cost", "line"] as const)("waits for the cost graph before reading a %s command source or locking its shipment", async (kind) => {
    const { db, tx } = buildTransactionalDb();
    let releaseGraph!: () => void;
    const graphLock = new Promise<void>((resolve) => { releaseGraph = resolve; });
    tx.execute.mockImplementationOnce(() => graphLock);
    const sourceFailure = new Error("Stop after the first protected source read");
    const storage = buildStorage({
      getInboundFreightCostById: vi.fn().mockRejectedValue(sourceFailure),
      getInboundShipmentLineById: vi.fn().mockRejectedValue(sourceFailure),
    });
    const service = createShipmentTrackingService(db as any, storage);
    const command = { operation: "update" as const, resourceId: 11,
      body: { expectedVersion: "a".repeat(64), notes: "Reviewed source" } };
    const now = new Date("2026-09-06T16:00:00Z");
    const pending = kind === "cost"
      ? service.executeCostCommandInTransaction(tx, command, "operator", now)
      : service.executeLineCommandInTransaction(tx, command, "operator", now);
    const settled = expect(pending).rejects.toBe(sourceFailure);

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]).sql).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))",
    );
    expect(storage.getInboundFreightCostById).not.toHaveBeenCalled();
    expect(storage.getInboundShipmentLineById).not.toHaveBeenCalled();
    expect(storage.getInboundShipmentById).not.toHaveBeenCalled();

    releaseGraph();
    await settled;
    const sourceReader = kind === "cost" ? storage.getInboundFreightCostById : storage.getInboundShipmentLineById;
    expect(sourceReader).toHaveBeenCalledExactlyOnceWith(11, tx);
    expect(storage.getInboundShipmentById).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("ShipmentTrackingService.executeLineCommandInTransaction", () => {
  it("re-runs allocation after line weight changes", async () => {
    const { db, tx } = buildTransactionalDb();
    const originalLine = {
      id: 11,
      inboundShipmentId: 1,
      sku: "SKU-1",
      qtyShipped: 10,
      purchaseOrderId: 1,
      purchaseOrderLineId: 21,
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
      getInboundShipmentLines: vi.fn().mockResolvedValueOnce([originalLine]).mockResolvedValue([updatedLine]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 1000, allocationMethod: "by_weight", currency: "USD", exchangeRate: "1" },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 10, totalProductCostCents: 0, unitCostCents: 0 }),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const now = new Date("2026-09-06T16:00:00.000Z");
    await service.executeLineCommandInTransaction(tx, {
      operation: "update", resourceId: 11,
      body: { expectedVersion: shipmentLineVersion(originalLine as any), weightKg: "2" },
    }, "operator", now);

    expect(storage.deleteAllocationsForShipment).toHaveBeenCalledWith(1, tx);
    expect(storage.bulkCreateInboundFreightCostAllocations).toHaveBeenCalledWith([
      expect.objectContaining({
        shipmentCostId: 31,
        inboundShipmentLineId: 11,
        allocationBasisValue: "20.000000",
        allocationBasisTotal: "20.000000",
        allocatedCents: 1000,
      }),
    ], tx);
    expect(storage.updateInboundShipmentLine).toHaveBeenCalledWith(11, expect.objectContaining({
      allocatedCostCents: 1000,
      landedUnitCostCents: 100,
    }), tx, now);
  });

  it("rejects reallocation of an unsupported historical currency basis", async () => {
    const { db, tx } = buildTransactionalDb();
    const line = { id: 11, inboundShipmentId: 1, qtyShipped: 5, cartonCount: null, weightKg: "1", totalWeightKg: "5", totalVolumeCbm: "0", chargeableWeightKg: "5" };
    const storage = buildStorage({
      getInboundShipmentLineById: vi.fn().mockResolvedValue(line),
      getInboundShipmentLines: vi.fn().mockResolvedValue([line]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "freight", actualCents: 100, currency: "EUR", exchangeRate: "0.9" }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    await expect(service.executeLineCommandInTransaction(tx, {
      operation: "update", resourceId: 11,
      body: { expectedVersion: shipmentLineVersion(line as any), cartonCount: 5 },
    }, "operator", new Date("2026-09-06T16:00:00Z"))).rejects.toMatchObject({ details: { code: "SHIPMENT_COST_CURRENCY_UNSUPPORTED" } });
    expect(storage.deleteAllocationsForShipment).not.toHaveBeenCalled();
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
    const { db, tx } = buildTransactionalDb();
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.getLandedCostHealth({ limit: 25 });

    expect(storage.getInboundShipments).toHaveBeenCalledWith({ status: ["costing", "closed"], limit: 100, offset: 0 }, tx);
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
    const { db, tx } = buildTransactionalDb();
    const service = createShipmentTrackingService(db as any, storage);

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

  function healthFixture(overrides: Record<string, unknown> = {}) {
    const storage = buildStorage({
      getInboundShipments: vi.fn().mockResolvedValue([{ id: 1, shipmentNumber: "INB-1", status: "closed" }]),
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed", allocationMethodDefault: "by_volume" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, productVariantId: 10, purchaseOrderLineId: 21,
        qtyShipped: 5, totalVolumeCbm: "1" }]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "freight", estimatedCents: 500, actualCents: null }]),
      getInboundFreightCostAllocations: vi.fn().mockResolvedValue([{ shipmentCostId: 31, inboundShipmentLineId: 11,
        allocationBasisValue: "1", allocationBasisTotal: "1", allocatedCents: 500 }]),
      getProvisionalLotsByShipment: vi.fn().mockResolvedValue([{ id: 501, productVariantId: 10, costProvisional: 1 }]),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([{ inboundShipmentLineId: 11, landedUnitCostCents: 110 }]),
      ...overrides,
    });
    const { db, tx } = buildTransactionalDb();
    return { storage, db, tx, service: createShipmentTrackingService(db as any, storage) };
  }
  function application(status: "applied" | "review_required" = "applied", issues: ShipmentCostReview["lines"][number]["sourceIssue"][] = []) {
    return { id: 8, recordedAt: "2026-10-16T12:00:00Z", status, lotsUpdated: 1, cogsRowsUpdated: 0,
      issues: issues.filter((issue): issue is NonNullable<typeof issue> => issue !== null) };
  }
  function setReview(line: Partial<ShipmentCostReview["lines"][number]> = {}) {
    const review = shipmentCostReviewSchema.parse({ shipmentId: 1, lines: [{ lineId: 11, sku: "SKU-1",
      sourceIssue: null, exceptionReview: null, application: application(), ...line }] });
    vi.mocked(readShipmentCostReviewInTransaction).mockResolvedValue(review);
    return review;
  }
  const historicalIssue = { code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Historical receipt source is missing." };
  function historicalReview(status: "posted" | "review_required" | "unresolved" = "posted") {
    return { state: "open" as const, fingerprint: "a".repeat(64), kind: "missing_receipt_history" as const,
      currency: "USD", allocatedMills: 50000, amountMills: 50000, lotsUpdated: 0, cogsRowsUpdated: 0,
      issues: [historicalIssue], decision: null, reconciliation: { status, postedMills: status === "posted" ? 50000 : 0,
        unassignedMills: status === "posted" ? 0 : 50000, destination: status === "posted" ? "historical_cogs" as const : null } };
  }

  it("treats a current applied estimate as posted while retaining other provisional sources", async () => {
    const { service, storage, db, tx } = healthFixture();
    setReview();
    const result = await service.getLandedCostHealth();
    expect(result).toMatchObject({ status: "warning", critical: 0, warning: 1,
      counts: { staleProvisionalLots: 0, finalizedNotPushed: 0, provisionalOtherCosts: 1 } });
    expect(result.items).toEqual([expect.objectContaining({ type: "provisional_other_costs",
      action: "review_cost_evidence", detail: expect.stringContaining("Landed costs are posted.") })]);
    expect(result.items[0].detail).toContain("1 lot retains a provisional flag");
    expect(result.items[0].detail).toContain("this flag alone does not mean freight is unposted");
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(readShipmentCostReviewInTransaction).toHaveBeenCalledWith(tx, 1);
    expect(storage.getProvisionalLotsByShipment).toHaveBeenCalledWith(1, tx);
    expect(storage.getLandedCostSnapshots).toHaveBeenCalledWith(11, tx);
  });

  it("recognizes approved historical posting without recommending re-finalization or another push", async () => {
    const { service } = healthFixture({ getLandedCostSnapshots: vi.fn().mockResolvedValue([]) });
    setReview({ application: application("review_required", [historicalIssue]), exceptionReview: historicalReview() });
    const result = await service.getLandedCostHealth();
    expect(result.status).toBe("warning");
    expect(result.counts.pendingFinalization).toBe(0);
    expect(result.items.map(item => item.type)).toEqual(["provisional_other_costs"]);
    expect(result.items.every(item => item.action === "review_cost_evidence")).toBe(true);
  });

  it("reports healthy landed posting when no other provisional evidence remains", async () => {
    const { service } = healthFixture({ getProvisionalLotsByShipment: vi.fn().mockResolvedValue([]) });
    setReview({ application: application("review_required", [historicalIssue]), exceptionReview: historicalReview() });
    expect(await service.getLandedCostHealth()).toMatchObject({ status: "healthy", critical: 0, warning: 0, items: [] });
  });

  it.each(["COST_UPDATE_OUTDATED", "COST_CURRENCY_REVIEW", "COST_SOURCE_UNKNOWN"])("keeps %s source evidence actionable after a recorded posting", async code => {
    const { service } = healthFixture();
    setReview({ sourceIssue: { code, message: "Review the current source." },
      application: application("review_required", [historicalIssue]), exceptionReview: historicalReview() });
    const result = await service.getLandedCostHealth();
    expect(result.status).toBe("critical");
    expect(result.counts.provisionalOtherCosts).toBe(0);
    expect(result.items).toEqual([expect.objectContaining({ type: "stale_provisional_lots", action: "review_cost_evidence" })]);
  });

  it.each(["review_required", "unresolved"] as const)("does not clear %s reconciliation", async status => {
    const { service } = healthFixture();
    setReview({ application: application("review_required", [historicalIssue]), exceptionReview: historicalReview(status) });
    const result = await service.getLandedCostHealth();
    expect(result).toMatchObject({ status: "critical", counts: { staleProvisionalLots: 1, provisionalOtherCosts: 0 } });
    expect(result.items[0].action).toBe("review_cost_evidence");
  });

  it("keeps a contradictory applied result with retained issues in review", async () => {
    const { service } = healthFixture();
    setReview({ application: application("applied", [historicalIssue]) });
    const result = await service.getLandedCostHealth();
    expect(result.status).toBe("critical");
    expect(result.items[0].action).toBe("review_cost_evidence");
  });

  it("finds changed current sources even when the legacy provisional flag was cleared", async () => {
    const { service } = healthFixture({ getProvisionalLotsByShipment: vi.fn().mockResolvedValue([]) });
    setReview({ sourceIssue: { code: "COST_UPDATE_OUTDATED", message: "Costs changed." } });
    const result = await service.getLandedCostHealth();
    expect(result).toMatchObject({ status: "critical", counts: { postingReviewRequired: 1 } });
    expect(result.items[0]).toMatchObject({ type: "posting_review_required", action: "review_cost_evidence" });
  });

  it("retains allocation blockers after a posted application", async () => {
    const { service } = healthFixture({ getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]) });
    setReview();
    const result = await service.getLandedCostHealth();
    expect(result.status).toBe("critical");
    expect(result.counts.allocationBlockers).toBe(1);
  });

  it.each([null, { shipmentId: 2, lines: [{ lineId: 11, sku: null, sourceIssue: null, application: null }] }, { shipmentId: 1, lines: [] }, { shipmentId: 1, lines: [
    { lineId: 12, sku: null, sourceIssue: null, application: null }] }])("refuses incomplete line evidence: %j", async review => {
    const { service } = healthFixture();
    vi.mocked(readShipmentCostReviewInTransaction).mockResolvedValue(review);
    await expect(service.getLandedCostHealth()).rejects.toMatchObject({ statusCode: 503,
      details: { code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" } });
  });

  it("does not turn a failed posting read into healthy or an actionable push", async () => {
    const { service } = healthFixture();
    vi.mocked(readShipmentCostReviewInTransaction).mockRejectedValue(new Error("posting read failed"));
    await expect(service.getLandedCostHealth()).rejects.toThrow("posting read failed");
  });

  it.each([0, -1, 1.5, Number.NaN, 251])("validates health limit %s", async limit => {
    const { service, db } = healthFixture();
    await expect(service.getLandedCostHealth({ limit })).rejects.toThrow("Cost health limit");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects conflicting completion counts at the shared response boundary", () => {
    expect(landedCostHealthSchema.safeParse({ status: "healthy", scannedShipments: 1, critical: 1, warning: 0,
      counts: { allocationBlockers: 0, allocationWarnings: 0, pendingFinalization: 0, finalizedNotPushed: 0, staleProvisionalLots: 0 },
      items: [] }).success).toBe(false);
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
        { id: 11, productVariantId: 10, purchaseOrderId: 1, purchaseOrderLineId: 21, qtyShipped: 5 },
      ]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 5, totalProductCostCents: 500, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([finalizedSnapshot]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(result).toEqual({ finalized: 1, unchanged: true, adjustments: 0, costReviewIssues: [] });
    expect(storage.deleteLandedCostSnapshotsForShipment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
    expect(storage.createLandedCostAdjustment).not.toHaveBeenCalled();
  });

  it("records an adjustment and refreshes snapshots when closed shipment costs change", async () => {
    const { db, tx } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 11, productVariantId: 10, purchaseOrderId: 1, purchaseOrderLineId: 21, qtyShipped: 5, totalVolumeCbm: "1" },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        { id: 31, costType: "freight", actualCents: 50 },
      ]),
      getAllocationsForLine: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, allocatedCents: 50 },
      ]),
      getInboundFreightCostById: vi.fn().mockResolvedValue({ id: 31, costType: "freight" }),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product", orderQty: 5, totalProductCostCents: 500, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([finalizedSnapshot]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    const result = await service.finalizeAllocations(1, "user-1");

    expect(storage.createLandedCostAdjustment).toHaveBeenCalledWith({
      inboundShipmentLineId: 11,
      purchaseOrderLineId: 21,
      adjustmentAmountCents: 50,
      reason: expect.stringContaining("Post-close landed charge reallocation."),
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
    expect(result).toEqual({ finalized: 1, unchanged: false, adjustments: 1, costReviewIssues: [] });
  });

  it.each([0, 50])("classifies a legacy product projection separately from a %i-cent freight change", async (freightChange) => {
    const { db, tx } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, productVariantId: 10, purchaseOrderId: 1,
        purchaseOrderLineId: 21, qtyShipped: 1000, totalVolumeCbm: "1" }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product",
        orderQty: 1000, totalProductCostCents: 490, unitCostCents: 0, unitCostMills: 49 }),
      getInboundFreightCosts: vi.fn().mockResolvedValue([{ id: 31, costType: "freight", actualCents: 100 + freightChange }]),
      getAllocationsForLine: vi.fn().mockResolvedValue([{ shipmentCostId: 31, allocatedCents: 100 + freightChange }]),
      getInboundFreightCostById: vi.fn().mockResolvedValue({ id: 31, costType: "freight" }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([{ ...finalizedSnapshot, qty: 1000,
        productValueEvidence: null, poUnitCostCents: 0, totalLandedCostCents: 100, landedUnitCostCents: 0,
        freightAllocatedCents: 100 }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    expect((await service.finalizeAllocations(1, "reviewer")).adjustments).toBe(1);
    const audit = storage.createLandedCostAdjustment.mock.calls[0][0];
    expect(audit.adjustmentAmountCents).toBe(490 + freightChange);
    expect(audit.reason).toContain("Legacy product projection recalculation (prior exact PO source unavailable)");
    expect(audit.reason).toContain("Product projection: 0 -> 490 cents (+490)");
    expect(audit.reason).toContain(`Freight: 100 -> ${100 + freightChange} cents (+${freightChange})`);
    expect(audit.reason.includes("landed charge reallocation")).toBe(freightChange !== 0);
    expect(storage.createLandedCostAdjustment.mock.calls[0][1]).toBe(tx);
    const saved = storage.bulkCreateLandedCostSnapshots.mock.calls[0][0];
    expect(saved[0].totalLandedCostCents).toBe(590 + freightChange);
    storage.getLandedCostSnapshots.mockResolvedValue(saved);
    expect(await service.finalizeAllocations(1, "reviewer")).toMatchObject({ unchanged: true, adjustments: 0 });
    expect(storage.createLandedCostAdjustment).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed prior frozen evidence even when every compatibility amount is unchanged", async () => {
    const { db } = buildTransactionalDb();
    const storage = buildStorage({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "closed" }),
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 11, productVariantId: 10, purchaseOrderId: 1,
        purchaseOrderLineId: 21, qtyShipped: 5 }]),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 21, purchaseOrderId: 1, lineType: "product",
        orderQty: 5, totalProductCostCents: 500, unitCostCents: 100 }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([{ ...finalizedSnapshot,
        productValueEvidence: { ...productValueEvidence(500), rawRatio: { numerator: "501", denominator: "1" } } }]),
    });
    const service = createShipmentTrackingService(db as any, storage);
    await expect(service.finalizeAllocations(1, "reviewer")).rejects.toMatchObject({ statusCode: 409,
      details: { code: "LANDED_SNAPSHOT_VALUE_EVIDENCE_INVALID" } });
    expect(storage.deleteLandedCostSnapshotsForShipment).not.toHaveBeenCalled();
    expect(storage.createLandedCostAdjustment).not.toHaveBeenCalled();
    expect(storage.bulkCreateLandedCostSnapshots).not.toHaveBeenCalled();
    expect(recordShipmentCostRevisions).not.toHaveBeenCalled();
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

  it("delegates exact shipment identity to the component owner with a transaction-bound COGS writer", async () => {
    const { db, tx } = buildTransactionalDb();
    const result = { updated: 1, total: 1, skipped: [], costApplications: [] };
    vi.mocked(applyShipmentCostRevisions).mockResolvedValueOnce(result);
    const storage = buildStorage();
    const clock = () => new Date("2026-09-07T12:00:00Z");
    const service = createShipmentTrackingService(db as any, storage, undefined, clock);
    expect(await service.pushLandedCostsToLots(1)).toEqual(result);
    expect(applyShipmentCostRevisions).toHaveBeenCalledWith(tx, 1, expect.any(Object), "system:shipment-costs", clock());
    expect((vi.mocked(applyShipmentCostRevisions).mock.calls[0][2] as any).db).toBe(tx);
    expect(storage.getProvisionalLotsByShipment).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each(["source_cost_missing", "receipt_lineage_missing"])("returns the owner's %s review result unchanged", async (reason) => {
    const { db } = buildTransactionalDb();
    const result = { updated: 0, total: 0, skipped: [{ applicationId: 11, reason, message: "Review source evidence" }], costApplications: [] };
    vi.mocked(applyShipmentCostRevisions).mockResolvedValueOnce(result);
    const service = createShipmentTrackingService(db as any, buildStorage());
    expect(await service.pushLandedCostsToLots(1)).toEqual(result);
  });

  it("keeps incomplete component graphs under owner review without calling the legacy lot updater", async () => {
    const { db } = buildTransactionalDb();
    const cogs = buildTransactionalCogs();
    const result = { updated: 0, total: 0, skipped: [{ applicationId: 11, reason: "incomplete_graph", message: "Review lineage" }], costApplications: [] };
    vi.mocked(applyShipmentCostRevisions).mockResolvedValueOnce(result);
    const service = createShipmentTrackingService(db as any, buildStorage(), cogs as any);
    expect(await service.pushLandedCostsToLots(1)).toEqual(result);
    expect(cogs.updateLotLandedCostMills).not.toHaveBeenCalled();
  });

  it("propagates an owner failure through the enclosing cost transaction", async () => {
    const { db, tx } = buildTransactionalDb();
    const failure = new Error("Synthetic component write failure");
    vi.mocked(applyShipmentCostRevisions).mockRejectedValueOnce(failure);
    const service = createShipmentTrackingService(db as any, buildStorage());
    await expect(service.pushLandedCostsToLots(1)).rejects.toBe(failure);
    expect(applyShipmentCostRevisions).toHaveBeenCalledWith(tx, 1, expect.any(Object), "system:shipment-costs", expect.any(Date));
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
    expect(applyShipmentCostRevisions).toHaveBeenCalledWith(expect.any(Object), 1, expect.any(Object), "user-1", expect.any(Date));
    expect(cogs.updateLotLandedCostMills).not.toHaveBeenCalled();
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
        { id: 31, inboundShipmentId: 1, costType: "freight", actualCents: 100, allocationMethod: "by_weight", currency: "USD", exchangeRate: "1" },
      ]),
    });
    const service = createShipmentTrackingService(db as any, storage);

    await expect(db.transaction((executor) => service.executeCostCommandInTransaction(executor, { operation: "create", resourceId: 1, body: { costType: "freight", actualCents: 100 } }, "test-user", new Date("2026-09-06T12:00:00.000Z")))).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "INVALID_SHIPMENT_LINE_QUANTITY" }),
    });

    expect(storage.createInboundFreightCost).toHaveBeenCalledWith(
      expect.objectContaining({ inboundShipmentId: 1, costType: "freight", actualCents: 100 }),
      tx, new Date("2026-09-06T12:00:00.000Z"),
    );
    expect(storage.updateInboundShipment).toHaveBeenCalledWith(1, expect.any(Object), tx, undefined);
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
