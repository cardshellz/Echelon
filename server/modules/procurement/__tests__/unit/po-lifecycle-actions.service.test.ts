import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDetectQtyVariance = vi.fn().mockResolvedValue(undefined);
const mockDetectPastDue = vi.fn().mockResolvedValue(undefined);
const mockDetectMatchMismatch = vi.fn().mockResolvedValue(undefined);

vi.mock("../../po-exceptions.service", () => ({
  detectQtyVariance: (...args: any[]) => mockDetectQtyVariance(...args),
  detectPastDue: (...args: any[]) => mockDetectPastDue(...args),
  detectMatchMismatch: (...args: any[]) => mockDetectMatchMismatch(...args),
}));

import { createPurchasingService } from "../../purchasing.service";

function buildMockDb() {
  const insertedRows: any[] = [];
  return {
    insertedRows,
    insert: vi.fn(() => ({
      values: vi.fn((row: any) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    })),
    update: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn({})),
  } as any;
}

function buildMockStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderByPoNumber: vi.fn(),
    createPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn().mockResolvedValue({ id: 1 }),
    updatePurchaseOrderStatusWithHistory: vi.fn(),
    deletePurchaseOrder: vi.fn(),
    generatePoNumber: vi.fn(),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLineById: vi.fn(),
    createPurchaseOrderLine: vi.fn(),
    bulkCreatePurchaseOrderLines: vi.fn(),
    updatePurchaseOrderLine: vi.fn(),
    deletePurchaseOrderLine: vi.fn(),
    getOpenPoLinesForVariant: vi.fn(),
    createPoStatusHistory: vi.fn(),
    getPoStatusHistory: vi.fn(),
    createPoRevision: vi.fn(),
    getPoRevisions: vi.fn(),
    createPoReceipt: vi.fn(),
    getPoReceipts: vi.fn(),
    reconcilePoReceiptLine: vi.fn(),
    getAllPoApprovalTiers: vi.fn().mockResolvedValue([]),
    getPoApprovalTierById: vi.fn(),
    getMatchingApprovalTier: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn(),
    getVendorProductById: vi.fn(),
    getPreferredVendorProduct: vi.fn(),
    getVendorById: vi.fn(),
    getProductVariantById: vi.fn(),
    getProductById: vi.fn(),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getReceivingLineById: vi.fn(),
    getReceivingOrderById: vi.fn(),
    getSetting: vi.fn(),
    ...overrides,
  } as any;
}

const activeProductLine = {
  id: 10,
  status: "open",
  orderQty: 2,
  unitCostCents: 500,
  lineTotalCents: 1000,
  discountPercent: 0,
  taxRatePercent: 0,
};

describe("PO lifecycle actions", () => {
  beforeEach(() => {
    mockDetectQtyVariance.mockClear();
    mockDetectPastDue.mockClear();
    mockDetectMatchMismatch.mockClear();
  });

  it("submit pending approval writes status history and a submitted event", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 1,
        status: "draft",
        totalCents: 1000,
        discountCents: 0,
        taxCents: 0,
        shippingCostCents: 0,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([activeProductLine]),
      getMatchingApprovalTier: vi.fn().mockResolvedValue({ id: 7, tierName: "Manager" }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 1, status: "pending_approval" }),
    });
    const svc = createPurchasingService(db, storage);

    const result = await svc.submit(1, "user-1");

    expect(result.status).toBe("pending_approval");
    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "pending_approval", approvalTierId: 7 }),
      expect.objectContaining({
        fromStatus: "draft",
        toStatus: "pending_approval",
        changedBy: "user-1",
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 1,
        eventType: "submitted",
        actorType: "user",
        actorId: "user-1",
        payloadJson: expect.objectContaining({
          from_status: "draft",
          to_status: "pending_approval",
          tier_id: 7,
        }),
      }),
    );
  });

  it("approve writes an approved event", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 2, status: "pending_approval" }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 2, status: "approved" }),
    });
    const svc = createPurchasingService(db, storage);

    await svc.approve(2, "user-2", "approved by ops");

    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 2,
        eventType: "approved",
        actorId: "user-2",
        payloadJson: expect.objectContaining({
          from_status: "pending_approval",
          to_status: "approved",
          notes: "approved by ops",
        }),
      }),
    );
  });

  it("physical lifecycle transition writes a mapped event", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 3,
        status: "acknowledged",
        physicalStatus: "acknowledged",
      }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 3, physicalStatus: "shipped" }),
    });
    const svc = createPurchasingService(db, storage);

    await svc.transitionPhysical(3, "shipped", "user-3", "vendor shipped");

    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 3,
        eventType: "marked_shipped",
        actorId: "user-3",
        payloadJson: expect.objectContaining({
          from_status: "acknowledged",
          to_status: "acknowledged",
          physical_status: "shipped",
        }),
      }),
    );
  });

  it("dispatches physical movement through the lifecycle command boundary", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 33,
        status: "acknowledged",
        physicalStatus: "acknowledged",
      }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 33, physicalStatus: "shipped" }),
    });
    const svc = createPurchasingService(db, storage);

    await svc.executeLifecycleCommand(33, "mark_shipped", { notes: "vendor shipped" }, "user-33");

    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledWith(
      33,
      expect.objectContaining({ physicalStatus: "shipped" }),
      expect.objectContaining({
        fromStatus: "acknowledged",
        toStatus: "acknowledged",
        changedBy: "user-33",
        notes: "vendor shipped",
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 33,
        eventType: "marked_shipped",
        actorId: "user-33",
      }),
    );
  });

  it("dispatches acknowledge data through the lifecycle command boundary", async () => {
    const confirmedDeliveryDate = new Date("2026-05-21T00:00:00.000Z");
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 34,
        status: "sent",
        physicalStatus: "sent",
      }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 34, physicalStatus: "acknowledged" }),
    });
    const svc = createPurchasingService(db, storage);

    await svc.executeLifecycleCommand(
      34,
      "acknowledge",
      { vendorRefNumber: "VREF-34", confirmedDeliveryDate },
      "user-34",
    );

    expect(storage.updatePurchaseOrderStatusWithHistory).toHaveBeenCalledWith(
      34,
      expect.objectContaining({
        physicalStatus: "acknowledged",
        status: "acknowledged",
        vendorRefNumber: "VREF-34",
        confirmedDeliveryDate,
      }),
      expect.objectContaining({
        notes: "Vendor acknowledged",
      }),
    );
  });

  it("rejects unknown lifecycle commands", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage();
    const svc = createPurchasingService(db, storage);

    await expect(
      svc.executeLifecycleCommand(99, "not_real" as any, {}, "user-99"),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Unknown PO lifecycle command 'not_real'",
    });
  });

  it("close-short writes a close-short event after line close patches", async () => {
    const db = buildMockDb();
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 4,
        status: "partially_received",
        physicalStatus: "receiving",
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        { id: 40, status: "open", orderQty: 10 },
      ]),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 4, status: "closed" }),
    });
    const svc = createPurchasingService(db, storage);

    await svc.closeShort(4, "vendor short-shipped", "user-4");

    expect(storage.updatePurchaseOrderLine).toHaveBeenCalledWith(
      40,
      expect.objectContaining({ status: "closed", closeShortReason: "vendor short-shipped" }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 4,
        eventType: "closed_short",
        actorId: "user-4",
        payloadJson: expect.objectContaining({
          reason: "vendor short-shipped",
          to_status: "closed",
        }),
      }),
    );
  });
});
