import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for partial unique index 409 error handling.
//
// Verifies that each create function catches Postgres unique violation
// (error code 23505) and throws a domain error with status 409 instead of
// letting the 500 leak through.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shipment Tracking ────────────────────────────────────────────────────────

describe("createShipment — 409 on duplicate shipment number", () => {
  let createShipmentTrackingService: any;
  let ShipmentTrackingError: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../shipment-tracking.service");
    createShipmentTrackingService = mod.createShipmentTrackingService;
    ShipmentTrackingError = mod.ShipmentTrackingError;
  });

  it("throws ShipmentTrackingError with 409 on unique violation", async () => {
    const mockDb = {};
    const mockStorage = {
      generateShipmentNumber: vi.fn().mockResolvedValue("SHP-20260503-001"),
      createInboundShipment: vi.fn().mockRejectedValue({ code: "23505", constraint: "inbound_shipments_shipment_number_active_uidx" }),
      getInboundShipments: vi.fn(),
      getInboundShipmentsCount: vi.fn(),
      getInboundShipmentById: vi.fn(),
      getInboundShipmentByNumber: vi.fn(),
      updateInboundShipment: vi.fn(),
      deleteInboundShipment: vi.fn(),
      getInboundShipmentLines: vi.fn(),
      getInboundShipmentLineById: vi.fn(),
      getInboundShipmentLinesByPo: vi.fn(),
      createInboundShipmentLine: vi.fn(),
      bulkCreateInboundShipmentLines: vi.fn(),
      updateInboundShipmentLine: vi.fn(),
      deleteInboundShipmentLine: vi.fn(),
      getInboundFreightCosts: vi.fn(),
      getInboundFreightCostById: vi.fn(),
      createInboundFreightCost: vi.fn(),
      updateInboundFreightCost: vi.fn(),
      deleteInboundFreightCost: vi.fn(),
      getInboundFreightCostAllocations: vi.fn(),
      getAllocationsForLine: vi.fn(),
      createInboundFreightCostAllocation: vi.fn(),
      bulkCreateInboundFreightCostAllocations: vi.fn(),
      deleteAllocationsForShipment: vi.fn(),
      getLandedCostSnapshots: vi.fn(),
      getLandedCostSnapshotByPoLine: vi.fn(),
      createLandedCostSnapshot: vi.fn(),
      bulkCreateLandedCostSnapshots: vi.fn(),
      deleteLandedCostSnapshotsForShipment: vi.fn(),
      createLandedCostAdjustment: vi.fn(),
      createInboundShipmentStatusHistory: vi.fn(),
      getInboundShipmentStatusHistory: vi.fn(),
      getInboundShipmentsByPo: vi.fn(),
      getProvisionalLotsByShipment: vi.fn(),
      getPurchaseOrderById: vi.fn(),
      getPurchaseOrderLines: vi.fn(),
      getPurchaseOrderLineById: vi.fn(),
      getVendorProducts: vi.fn(),
      getProductVariantById: vi.fn(),
      getProductById: vi.fn(),
      updateInventoryLot: vi.fn(),
    };

    const service = createShipmentTrackingService(mockDb, mockStorage);

    await expect(service.createShipment({})).rejects.toMatchObject({
      name: "ShipmentTrackingError",
      statusCode: 409,
    });
  });

  it("re-throws non-23505 errors unchanged", async () => {
    const mockDb = {};
    const mockStorage = {
      generateShipmentNumber: vi.fn().mockResolvedValue("SHP-20260503-001"),
      createInboundShipment: vi.fn().mockRejectedValue(new Error("connection refused")),
      getInboundShipments: vi.fn(),
      getInboundShipmentsCount: vi.fn(),
      getInboundShipmentById: vi.fn(),
      getInboundShipmentByNumber: vi.fn(),
      updateInboundShipment: vi.fn(),
      deleteInboundShipment: vi.fn(),
      getInboundShipmentLines: vi.fn(),
      getInboundShipmentLineById: vi.fn(),
      getInboundShipmentLinesByPo: vi.fn(),
      createInboundShipmentLine: vi.fn(),
      bulkCreateInboundShipmentLines: vi.fn(),
      updateInboundShipmentLine: vi.fn(),
      deleteInboundShipmentLine: vi.fn(),
      getInboundFreightCosts: vi.fn(),
      getInboundFreightCostById: vi.fn(),
      createInboundFreightCost: vi.fn(),
      updateInboundFreightCost: vi.fn(),
      deleteInboundFreightCost: vi.fn(),
      getInboundFreightCostAllocations: vi.fn(),
      getAllocationsForLine: vi.fn(),
      createInboundFreightCostAllocation: vi.fn(),
      bulkCreateInboundFreightCostAllocations: vi.fn(),
      deleteAllocationsForShipment: vi.fn(),
      getLandedCostSnapshots: vi.fn(),
      getLandedCostSnapshotByPoLine: vi.fn(),
      createLandedCostSnapshot: vi.fn(),
      bulkCreateLandedCostSnapshots: vi.fn(),
      deleteLandedCostSnapshotsForShipment: vi.fn(),
      createLandedCostAdjustment: vi.fn(),
      createInboundShipmentStatusHistory: vi.fn(),
      getInboundShipmentStatusHistory: vi.fn(),
      getInboundShipmentsByPo: vi.fn(),
      getProvisionalLotsByShipment: vi.fn(),
      getPurchaseOrderById: vi.fn(),
      getPurchaseOrderLines: vi.fn(),
      getPurchaseOrderLineById: vi.fn(),
      getVendorProducts: vi.fn(),
      getProductVariantById: vi.fn(),
      getProductById: vi.fn(),
      updateInventoryLot: vi.fn(),
    };

    const service = createShipmentTrackingService(mockDb, mockStorage);

    await expect(service.createShipment({})).rejects.toThrow("connection refused");
  });
});

// ── AP Ledger (recordPayment) ────────────────────────────────────────────────

describe("recordPayment — 409 on duplicate payment number", () => {
  it("throws ApLedgerError with 409 on unique violation", async () => {
    vi.resetModules();

    // Mock db to throw 23505 on insert
    const insertChain = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue({ code: "23505", constraint: "ap_payments_payment_number_active_uidx" }),
    };

    vi.mock("../../../../db", () => ({
      db: {
        insert: vi.fn().mockReturnValue(insertChain),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ paymentNumber: "PAY-20260503-001" }]),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      },
    }));

    vi.mock("@shared/schema", () => ({
      apPayments: { id: "id", paymentNumber: "paymentNumber" },
      apPaymentAllocations: { id: "id" },
      vendorInvoices: { id: "id" },
      vendorInvoiceLines: { id: "id" },
      purchaseOrders: { id: "id" },
      purchaseOrderLines: { id: "id" },
      vendors: { id: "id" },
      inboundFreightCosts: { id: "id" },
      inboundShipments: { id: "id" },
      vendorInvoicePoLinks: { id: "id" },
    }));

    vi.mock("@shared/schema/procurement.schema", () => ({}));

    const { recordPayment, ApLedgerError } = await import("../../ap-ledger.service");

    await expect(
      recordPayment({
        vendorId: 1,
        paymentDate: new Date(),
        paymentMethod: "ach",
        totalAmountCents: 10000,
        allocations: [],
      }),
    ).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 409,
    });
  });
});
