import { describe, expect, it, vi } from "vitest";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { shipmentCostCreateSchema } from "@shared/procurement/shipment-cost-command";
import {
  allocateShipmentCents,
  buildShipmentAllocationBasis,
  buildShipmentAllocationEvidence,
} from "../../domain/shipment-allocation-basis";
import {
  allocatePoLandedCostsAcrossLines,
  buildPoLandedCostRevisionInputs,
  type PoLandedProductLineInput,
} from "../../domain/po-landed-cost-allocation";
import { createShipmentTrackingService } from "../../application/shipment-tracking.service";
import { createPoLandedCostService, PoLandedCostError } from "../../application/po-landed-cost.service";
import type { PoLandedCostRecord } from "@shared/procurement/po-landed-cost";

vi.mock("../../../../infrastructure/transactional-audit", () => ({
  insertAuditEventDrizzle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../inventory/cost-application-public.api", async () => {
  const actual = await vi.importActual<any>("../../../inventory/cost-application-public.api");
  return {
    ...actual,
    lockInventoryCostGraph: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../application/shipment-cost-application.service", () => ({
  recordShipmentCostRevisions: vi.fn().mockResolvedValue({ revisions: [], issues: [] }),
  applyShipmentCostRevisions: vi.fn().mockResolvedValue({
    status: "applied",
    updated: 1,
    total: 1,
    skipped: [],
    costApplications: [],
  }),
}));

describe("COGS-2: by_quantity shipment allocation", () => {
  it("accepts by_quantity in shipmentCostCreateSchema", () => {
    const parsed = shipmentCostCreateSchema.parse({
      costType: "freight",
      actualCents: 12500,
      estimatedCents: 12500,
      currency: "USD",
      exchangeRate: "1",
      allocationMethod: "by_quantity",
    });
    expect(parsed.allocationMethod).toBe("by_quantity");
  });

  it("allocates exact piece shares without requiring carton dimensions or weights", () => {
    const basis = buildShipmentAllocationBasis(
      [
        { lineId: 101, qtyShipped: 700, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
        { lineId: 102, qtyShipped: 200, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
        { lineId: 103, qtyShipped: 100, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
      ],
      "by_quantity",
    );

    expect(basis.missingDimensionLineIds).toEqual([]);
    expect(basis.usedFallback).toBe(false);
    expect(basis.totalRatio).toEqual({ numerator: "1000", denominator: "1" });

    const shares = allocateShipmentCents(10000, basis);
    expect(shares.map((s) => ({ lineId: s.lineId, allocatedCents: s.allocatedCents }))).toEqual([
      { lineId: 101, allocatedCents: 7000 },
      { lineId: 102, allocatedCents: 2000 },
      { lineId: 103, allocatedCents: 1000 },
    ]);

    const evidence = buildShipmentAllocationEvidence(basis, 101);
    expect(evidence.method).toBe("by_quantity");
    expect(evidence.source).toEqual({ kind: "quantity", qtyShipped: 700 });
  });

  it("conserves exact cents via largest remainder on coprime piece counts", () => {
    const basis = buildShipmentAllocationBasis(
      [
        { lineId: 11, qtyShipped: 2, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
        { lineId: 12, qtyShipped: 1, totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
      ],
      "by_quantity",
    );
    const shares = allocateShipmentCents(1000, basis);
    expect(shares.map((s) => s.allocatedCents)).toEqual([667, 333]);
    expect(shares.reduce((sum, s) => sum + s.allocatedCents, 0)).toBe(1000);
  });
});

describe("COGS-2: reopenable closed shipments and post-close adjustment audit", () => {
  const fixedNow = new Date("2026-11-28T15:00:00.000Z");

  function makeTxDb() {
    const tx = {
      execute: vi.fn().mockImplementation(async (query: any) => {
        const text = JSON.stringify(query);
        if (text.includes("FROM procurement.inbound_shipments")) {
          return { rows: [{ id: 1 }] };
        }
        return { rows: [] };
      }),
      insert: vi.fn(),
      select: vi.fn(),
    };
    return {
      tx,
      db: {
        transaction: vi.fn(async (fn: (t: any) => Promise<any>) => fn(tx)),
        execute: tx.execute,
      },
    };
  }

  it("reopens a closed shipment back to costing and records status history", async () => {
    const { db, tx } = makeTxDb();
    const storage: any = {
      getInboundShipmentById: vi.fn().mockResolvedValue({
        id: 1,
        shipmentNumber: "SHP-001",
        status: "closed",
        closedAt: new Date("2026-11-01T12:00:00.000Z"),
        closedBy: "buyer-1",
      }),
      updateInboundShipment: vi.fn().mockImplementation(async (_id: number, updates: any) => ({
        id: 1,
        shipmentNumber: "SHP-001",
        closedAt: new Date("2026-11-01T12:00:00.000Z"),
        ...updates,
      })),
      createInboundShipmentStatusHistory: vi.fn().mockResolvedValue({}),
    };

    const service = createShipmentTrackingService(db as any, storage, {} as any, () => fixedNow);
    const updated = await service.reopenCosting(1, "buyer-1", "Late customs duty invoice");

    expect(updated.status).toBe("costing");
    expect(storage.createInboundShipmentStatusHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundShipmentId: 1,
        fromStatus: "closed",
        toStatus: "costing",
        changedBy: "buyer-1",
        notes: "Late customs duty invoice",
      }),
      tx,
    );
  });

  it("records landed_cost_adjustments when re-closing a previously closed shipment after adding a late bill", async () => {
    const { db, tx } = makeTxDb();
    let currentStatus = "costing";
    const priorClosedAt = new Date("2026-11-01T12:00:00.000Z");

    const priorEvidence = buildShipmentAllocationEvidence(
      buildShipmentAllocationBasis(
        [
          {
            lineId: 11,
            qtyShipped: 100,
            totalVolumeCbm: null,
            totalWeightKg: null,
            chargeableWeightKg: null,
            poLineId: 21,
            poOrderQty: 100,
            poTotalProductCostCents: 10000,
            poCurrency: "USD",
          },
        ],
        "by_value",
      ),
      11,
    );

    const storage: any = {
      getInboundShipmentById: vi.fn().mockImplementation(async () => ({
        id: 1,
        shipmentNumber: "SHP-001",
        status: currentStatus,
        allocationMethodDefault: "by_quantity",
        closedAt: priorClosedAt,
        closedBy: "buyer-1",
      })),
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 11,
          inboundShipmentId: 1,
          purchaseOrderId: 10,
          purchaseOrderLineId: 21,
          productVariantId: 201,
          sku: "SLEEVE-100",
          qtyShipped: 100,
          allocatedCostCents: 2500,
          landedUnitCostCents: 125,
        },
      ]),
      getInboundFreightCosts: vi.fn().mockResolvedValue([
        {
          id: 31,
          inboundShipmentId: 1,
          costType: "freight",
          actualCents: 1000,
          currency: "USD",
          exchangeRate: "1",
          allocationMethod: "by_quantity",
        },
        {
          id: 32,
          inboundShipmentId: 1,
          costType: "duty",
          actualCents: 1500,
          currency: "USD",
          exchangeRate: "1",
          allocationMethod: "by_value",
        },
      ]),
      getInboundFreightCostAllocations: vi.fn().mockImplementation(async (costId: number) => [
        {
          shipmentCostId: costId,
          inboundShipmentLineId: 11,
          allocatedCents: costId === 31 ? 1000 : 1500,
        },
      ]),
      deleteAllocationsForShipment: vi.fn().mockResolvedValue(undefined),
      bulkCreateInboundFreightCostAllocations: vi.fn().mockResolvedValue(undefined),
      updateInboundShipmentLine: vi.fn().mockResolvedValue(undefined),
      updateInboundShipment: vi.fn().mockImplementation(async (_id: number, updates: any) => {
        if (updates.status) currentStatus = updates.status;
        return { id: 1, status: currentStatus, closedAt: updates.closedAt ?? priorClosedAt };
      }),
      getAllocationsForLine: vi.fn().mockResolvedValue([
        { shipmentCostId: 31, allocatedCents: 1000 },
        { shipmentCostId: 32, allocatedCents: 1500 },
      ]),
      getInboundFreightCostById: vi.fn().mockImplementation(async (costId: number) =>
        costId === 31 ? { id: 31, costType: "freight" } : { id: 32, costType: "duty" },
      ),
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({
        id: 21,
        purchaseOrderId: 10,
        lineType: "product",
        orderQty: 100,
        totalProductCostCents: 10000,
        unitCostCents: 100,
      }),
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 10, currency: "USD" }),
      getLandedCostSnapshots: vi.fn().mockResolvedValue([
        {
          id: 900,
          inboundShipmentLineId: 11,
          purchaseOrderLineId: 21,
          productVariantId: 201,
          poUnitCostCents: 100,
          productValueEvidence: priorEvidence,
          freightAllocatedCents: 1000,
          dutyAllocatedCents: 0,
          insuranceAllocatedCents: 0,
          otherAllocatedCents: 0,
          recoverableTaxAllocatedCents: 0,
          excludedSupplierAllocatedCents: 0,
          totalLandedCostCents: 11000,
          landedUnitCostCents: 110,
          qty: 100,
        },
      ]),
      deleteLandedCostSnapshotsForShipment: vi.fn().mockResolvedValue(undefined),
      createLandedCostAdjustment: vi.fn().mockResolvedValue({}),
      bulkCreateLandedCostSnapshots: vi.fn().mockResolvedValue(undefined),
      createInboundShipmentStatusHistory: vi.fn().mockResolvedValue({}),
    };

    const service = createShipmentTrackingService(db as any, storage, {} as any, () => fixedNow);
    const result = await service.close(1, "buyer-1", "Re-close after late duty bill");

    expect(result.status).toBe("closed");
    expect(storage.createLandedCostAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundShipmentLineId: 11,
        purchaseOrderLineId: 21,
        adjustmentAmountCents: 1500,
        createdBy: "buyer-1",
      }),
      tx,
    );
  });
});

describe("COGS-2: PO-direct landed cost allocation and source revisions", () => {
  const sampleLines: PoLandedProductLineInput[] = [
    {
      id: 21,
      purchaseOrderId: 10,
      sku: "PENNY-SLEEVE",
      productName: "Penny Sleeves",
      orderQty: 10000,
      receivedQty: 8000,
      status: "received",
      totalProductCostCents: 3800, // $0.0038 / pc (38 mills)
      currency: "USD",
    },
    {
      id: 22,
      purchaseOrderId: 10,
      sku: "TOPLOADER-35PT",
      productName: "35pt Toploader",
      orderQty: 2000,
      receivedQty: 2000,
      status: "received",
      totalProductCostCents: 11400, // $0.0570 / pc (570 mills)
      currency: "USD",
    },
  ];

  const sampleCharges: PoLandedCostRecord[] = [
    {
      id: 1,
      purchaseOrderId: 10,
      costType: "freight",
      description: "UPS Ground Freight",
      amountCents: 10000, // $100.00 split by_quantity (8000 vs 2000 -> $80 vs $20)
      currency: "USD",
      allocationMethod: "by_quantity",
      vendorId: 5,
      vendorName: "UPS",
      vendorInvoiceId: null,
      invoiceNumber: "UPS-101",
      costDate: "2026-11-28T00:00:00.000Z",
      notes: null,
      createdBy: "buyer-1",
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    },
    {
      id: 2,
      purchaseOrderId: 10,
      costType: "tariff",
      description: "Section 301 Tariff",
      amountCents: 4000, // $40.00 split by_value (3800 vs 11400 = 1:3 -> $10 vs $30)
      currency: "USD",
      allocationMethod: "by_value",
      vendorId: null,
      vendorName: null,
      vendorInvoiceId: null,
      invoiceNumber: "CBP-7501",
      costDate: null,
      notes: null,
      createdBy: "buyer-1",
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    },
  ];

  it("allocates PO-direct freight and tariff using receivedQty coverage on short-received closed lines", () => {
    const result = allocatePoLandedCostsAcrossLines(10, sampleLines, sampleCharges);

    expect(result.totalCents).toBe(14000);
    expect(result.freightCents).toBe(10000);
    expect(result.dutyCents).toBe(4000);
    expect(result.otherCents).toBe(0);

    // Line 21: 8000/10000 received pieces -> product value = 3800 * (8000/10000) = 3040 cents
    // Line 22: 2000/2000 received pieces -> product value = 11400 cents (total received value = 14440 cents)
    // Freight ($100 by_quantity): 8000 vs 2000 -> 8000c vs 2000c
    // Tariff ($40 by_value): 4000 * 3040 / 14440 = 842c vs 4000 * 11400 / 14440 = 3158c
    // Line 21 total: 8842c = 884,200 mills / 8000 pcs = 110.525 -> 111 mills/pc
    // Line 22 total: 5158c = 515,800 mills / 2000 pcs = 257.9 -> 258 mills/pc
    expect(result.lineAllocations).toEqual([
      {
        purchaseOrderLineId: 21,
        sku: "PENNY-SLEEVE",
        productName: "Penny Sleeves",
        basePieces: 8000,
        freightCents: 8000,
        dutyCents: 842,
        otherCents: 0,
        totalAllocatedCents: 8842,
        allocatedUnitMills: 111,
      },
      {
        purchaseOrderLineId: 22,
        sku: "TOPLOADER-35PT",
        productName: "35pt Toploader",
        basePieces: 2000,
        freightCents: 2000,
        dutyCents: 3158,
        otherCents: 0,
        totalAllocatedCents: 5158,
        allocatedUnitMills: 258,
      },
    ]);
  });

  it("builds valid purchase_order_line-scoped landed cost source revisions (including zeroed removal revisions)", () => {
    const activeProposals = buildPoLandedCostRevisionInputs(10, sampleLines, sampleCharges);
    expect(activeProposals).toHaveLength(2);

    for (const proposal of activeProposals) {
      const validated = costSourceRevisionSchema.parse({
        ...proposal.input,
        revision: 1,
        fingerprint: "a".repeat(64),
      });
      expect(validated.component).toBe("landed");
      expect(validated.scope.kind).toBe("purchase_order_line");
      expect(validated.evidence).toBe("confirmed");
    }
    expect(activeProposals[0].input.totalMills).toBe(884_200);
    expect(activeProposals[0].input.basePieces).toBe(8000);

    // Removing all PO landed charges produces a valid 0-mills revision to reset lots cleanly
    const clearedProposals = buildPoLandedCostRevisionInputs(10, sampleLines, []);
    for (const proposal of clearedProposals) {
      const validated = costSourceRevisionSchema.parse({
        ...proposal.input,
        revision: 2,
        fingerprint: "b".repeat(64),
      });
      expect(validated.totalMills).toBe(0);
      expect(validated.evidence).toBe("confirmed");
    }
  });

  it("blocks PO-direct landed cost creation when the PO already has an active Inbound Shipment", async () => {
    const tx = {
      execute: vi.fn().mockImplementation(async (query: any) => {
        const text = JSON.stringify(query);
        if (text.includes("FROM procurement.purchase_orders")) {
          return { rows: [{ id: 10, currency: "USD", status: "received" }] };
        }
        if (text.includes("FROM procurement.inbound_shipment_lines")) {
          return { rows: [{ id: 42, shipment_number: "SHP-2026-0042" }] };
        }
        return { rows: [] };
      }),
    };
    const db = {
      execute: tx.execute,
      transaction: async (fn: any) => fn(tx),
    };

    const svc = createPoLandedCostService(db as any, () => new Date("2026-11-28T15:00:00.000Z"));
    await expect(
      svc.addPoLandedCost(
        10,
        {
          costType: "freight",
          amountCents: 5000,
          currency: "USD",
          allocationMethod: "by_value",
        },
        "buyer-1",
      ),
    ).rejects.toMatchObject({
      name: "PoLandedCostError",
      statusCode: 409,
      code: "PO_HAS_ACTIVE_SHIPMENT",
      details: { shipmentId: 42, shipmentNumber: "SHP-2026-0042" },
    } satisfies Partial<PoLandedCostError>);
  });
});
