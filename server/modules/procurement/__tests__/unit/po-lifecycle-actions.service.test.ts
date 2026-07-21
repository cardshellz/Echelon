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

function buildMockDb(txSelectResults: any[][] = []) {
  const insertedRows: any[] = [];
  const updateCalls: Array<{ table: unknown; patch: any }> = [];
  let txSelectIndex = 0;
  const select = vi.fn(() => {
    const rows = txSelectResults[txSelectIndex++] ?? [];
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      for: vi.fn(async () => rows),
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });
  const db: any = {
    insertedRows,
    updateCalls,
    insert: vi.fn(() => ({
      values: vi.fn((row: any) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    })),
    select,
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: any) => {
        updateCalls.push({ table, patch });
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 1, ...patch }]),
          })),
        };
      }),
    })),
  };
  db.transaction = vi.fn(async (fn: any) => fn(db));
  return db;
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
  lineType: "product",
  pricingBasis: "per_piece",
  pricingSource: "manual",
  orderQty: 2,
  unitCostCents: 500,
  unitCostMills: 50_000,
  quotedUnitCostMills: 50_000,
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
    const po = {
      id: 1,
      status: "draft",
      physicalStatus: "draft",
      totalCents: 1000,
      discountCents: 0,
      taxCents: 0,
      shippingCostCents: 0,
    };
    const db = buildMockDb([[po], [activeProductLine], [{ id: 7, tierName: "Manager" }]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([activeProductLine]),
      getMatchingApprovalTier: vi.fn().mockResolvedValue({ id: 7, tierName: "Manager" }),
      updatePurchaseOrderStatusWithHistory: vi.fn().mockResolvedValue({ id: 1, status: "pending_approval" }),
    });
    const svc = createPurchasingService(db, storage);

    const result = await svc.submit(1, "user-1");

    expect(result.status).toBe("pending_approval");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(db.updateCalls).toContainEqual(
      expect.objectContaining({
        patch: expect.objectContaining({ status: "pending_approval", approvalTierId: 7 }),
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 1,
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
    const po = {
      id: 2,
      status: "pending_approval",
      physicalStatus: "draft",
      approvalTierId: null,
      discountCents: 0,
      taxCents: 0,
      shippingCostCents: 0,
    };
    const db = buildMockDb([[po], [activeProductLine], []]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
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
    const po = {
      id: 3,
      status: "acknowledged",
      physicalStatus: "acknowledged",
    };
    const db = buildMockDb([[po]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
    });
    const svc = createPurchasingService(db, storage);

    await svc.transitionPhysical(3, "shipped", "user-3", "vendor shipped");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(db.updateCalls).toContainEqual(
      expect.objectContaining({
        patch: expect.objectContaining({ physicalStatus: "shipped" }),
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 3,
        fromStatus: "acknowledged",
        toStatus: "acknowledged",
        changedBy: "user-3",
        notes: "vendor shipped",
      }),
    );
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
    const po = {
      id: 33,
      status: "acknowledged",
      physicalStatus: "acknowledged",
    };
    const db = buildMockDb([[po]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
    });
    const svc = createPurchasingService(db, storage);

    await svc.executeLifecycleCommand(33, "mark_shipped", { notes: "vendor shipped" }, "user-33");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(db.updateCalls).toContainEqual(
      expect.objectContaining({
        patch: expect.objectContaining({ physicalStatus: "shipped" }),
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 33,
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
    const po = {
      id: 34,
      status: "sent",
      physicalStatus: "sent",
    };
    const db = buildMockDb([[po]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
    });
    const svc = createPurchasingService(db, storage);

    await svc.executeLifecycleCommand(
      34,
      "acknowledge",
      { vendorRefNumber: "VREF-34", confirmedDeliveryDate },
      "user-34",
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(db.updateCalls).toContainEqual(
      expect.objectContaining({
        patch: expect.objectContaining({
          physicalStatus: "acknowledged",
          status: "acknowledged",
          vendorRefNumber: "VREF-34",
          confirmedDeliveryDate,
        }),
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 34,
        notes: "Vendor acknowledged",
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 34,
        eventType: "vendor_acknowledged",
        actorId: "user-34",
      }),
    );
  });

  it("rejects vendor confirmed delivery before the PO submission date", async () => {
    const po = {
      id: 35,
      status: "sent",
      physicalStatus: "sent",
      sentToVendorAt: new Date("2026-05-10T18:00:00.000Z"),
      orderDate: new Date("2026-05-10T18:00:00.000Z"),
    };
    const db = buildMockDb([[po]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
    });
    const svc = createPurchasingService(db, storage);

    await expect(svc.acknowledge(
      35,
      { confirmedDeliveryDate: new Date("2026-05-09T00:00:00.000Z") },
      "user-35",
    )).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ code: "CONFIRMED_DELIVERY_BEFORE_PO" }),
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.updateCalls).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("updates a nonterminal delivery schedule with history and event audit", async () => {
    const po = {
      id: 36,
      status: "acknowledged",
      physicalStatus: "acknowledged",
      sentToVendorAt: new Date("2026-05-10T18:00:00.000Z"),
      orderDate: new Date("2026-05-10T18:00:00.000Z"),
      expectedDeliveryDate: null,
      confirmedDeliveryDate: new Date("2026-05-01T00:00:00.000Z"),
    };
    const db = buildMockDb([[po]]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
    });
    const svc = createPurchasingService(db, storage);
    const expectedDeliveryDate = new Date("2026-06-15T00:00:00.000Z");

    await svc.updateDeliverySchedule(36, {
      expectedDeliveryDate,
      confirmedDeliveryDate: null,
      notes: "Correct vendor schedule",
    }, "user-36");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.updateCalls).toContainEqual(expect.objectContaining({
      patch: expect.objectContaining({
        expectedDeliveryDate,
        confirmedDeliveryDate: null,
        updatedBy: "user-36",
      }),
    }));
    expect(db.insertedRows).toContainEqual(expect.objectContaining({
      purchaseOrderId: 36,
      fromStatus: "acknowledged",
      toStatus: "acknowledged",
      changedBy: "user-36",
      notes: "Correct vendor schedule",
    }));
    expect(db.insertedRows).toContainEqual(expect.objectContaining({
      poId: 36,
      eventType: "delivery_schedule_updated",
      actorId: "user-36",
      payloadJson: expect.objectContaining({
        before: expect.objectContaining({ confirmed_delivery_date: "2026-05-01T00:00:00.000Z" }),
        after: expect.objectContaining({
          expected_delivery_date: "2026-06-15T00:00:00.000Z",
          confirmed_delivery_date: null,
        }),
      }),
    }));
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

  it("cancel writes line cancellations, status history, and event in one transaction", async () => {
    const po = {
      id: 5,
      status: "approved",
      physicalStatus: "draft",
    };
    const lines = [
      { id: 50, status: "open", orderQty: 12 },
      { id: 51, status: "received", orderQty: 2 },
    ];
    const db = buildMockDb([[po], lines]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
      getPurchaseOrderLines: vi.fn().mockResolvedValue(lines),
    });
    const svc = createPurchasingService(db, storage);

    await svc.cancel(5, "vendor cancelled", "user-5");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderLine).not.toHaveBeenCalled();
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(db.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patch: expect.objectContaining({ status: "cancelled", cancelledQty: 12 }),
        }),
        expect.objectContaining({
          patch: expect.objectContaining({
            status: "cancelled",
            physicalStatus: "cancelled",
            cancelReason: "vendor cancelled",
          }),
        }),
      ]),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 5,
        fromStatus: "approved",
        toStatus: "cancelled",
      }),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        poId: 5,
        eventType: "cancelled",
        actorId: "user-5",
        payloadJson: expect.objectContaining({
          reason: "vendor cancelled",
          physical_status: "cancelled",
        }),
      }),
    );
  });

  it("close-short writes line patches, status history, and event in one transaction", async () => {
    const po = {
      id: 4,
      status: "partially_received",
      physicalStatus: "receiving",
    };
    const lines = [{ id: 40, status: "open", orderQty: 10 }];
    const db = buildMockDb([[po], lines]);
    const storage = buildMockStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(po),
      getPurchaseOrderLines: vi.fn().mockResolvedValue(lines),
    });
    const reconcileApprovedInvoiceCost = vi.fn().mockResolvedValue(undefined);
    const svc = createPurchasingService(db, storage, { reconcileApprovedInvoiceCost });

    await svc.closeShort(4, "vendor short-shipped", "user-4");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storage.updatePurchaseOrderLine).not.toHaveBeenCalled();
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(reconcileApprovedInvoiceCost).toHaveBeenCalledWith(40, db, "user-4");
    expect(db.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patch: expect.objectContaining({ status: "closed", closeShortReason: "vendor short-shipped" }),
        }),
        expect.objectContaining({
          patch: expect.objectContaining({ status: "closed", physicalStatus: "short_closed" }),
        }),
      ]),
    );
    expect(db.insertedRows).toContainEqual(
      expect.objectContaining({
        purchaseOrderId: 4,
        toStatus: "closed",
        notes: "Closed short: vendor short-shipped",
      }),
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
