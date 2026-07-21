import { describe, expect, it, vi } from "vitest";
import {
  poApprovalTiers,
  poEvents,
  poStatusHistory,
  purchaseOrderLines,
  purchaseOrders,
  vendorProducts,
  vendors,
  warehouseSettings,
} from "@shared/schema";
import { createPurchasingService } from "../../purchasing.service";

function baseStorage(overrides: Record<string, unknown> = {}) {
  return {
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderByPoNumber: vi.fn(),
    createPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn(),
    updatePurchaseOrderStatusWithHistory: vi.fn(),
    deletePurchaseOrder: vi.fn(),
    getRecommendationPoHandoffForPo: vi.fn(),
    generatePoNumber: vi.fn(),
    getPurchaseOrderLines: vi.fn(),
    getPurchaseOrderLineById: vi.fn(),
    createPurchaseOrderLine: vi.fn(),
    bulkCreatePurchaseOrderLines: vi.fn(),
    updatePurchaseOrderLine: vi.fn(),
    deletePurchaseOrderLine: vi.fn(),
    getRecommendationPoHandoffForLine: vi.fn(),
    getOpenPoLinesForVariant: vi.fn(),
    createPoStatusHistory: vi.fn(),
    getPoStatusHistory: vi.fn(),
    createPoRevision: vi.fn(),
    getPoRevisions: vi.fn(),
    createPoReceipt: vi.fn(),
    getPoReceipts: vi.fn(),
    reconcilePoReceiptLine: vi.fn(),
    getAllPoApprovalTiers: vi.fn(),
    getPoApprovalTierById: vi.fn(),
    getMatchingApprovalTier: vi.fn(),
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

function exactLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    purchaseOrderId: 1,
    status: "open",
    pricingBasis: "per_piece",
    orderQty: 100,
    lineTotalCents: 150_000,
    updatedAt: new Date("2026-07-13T12:00:00.000Z"),
    ...overrides,
  };
}

function lifecycleDb(input: {
  lockedPo: any;
  lines: any[];
  settings?: any[];
  tiers?: any[];
  vendorProducts?: any[];
  quoteClock?: { evaluatedAt: Date; currentDate: string };
  failHeaderCas?: boolean;
}) {
  const insertedRows: Array<{ table: unknown; row: any }> = [];
  const updatePatches: Array<{ table: unknown; patch: any }> = [];
  const lockCalls: Array<{ table: unknown; mode: string }> = [];

  const rowsFor = (table: unknown): any[] => {
    if (table === purchaseOrders) return [input.lockedPo];
    if (table === purchaseOrderLines) return input.lines;
    if (table === warehouseSettings) return input.settings ?? [];
    if (table === poApprovalTiers) return input.tiers ?? [];
    if (table === vendorProducts) return input.vendorProducts ?? [];
    return [];
  };

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      const chain: any = {
        from: vi.fn((value: unknown) => {
          table = value;
          return chain;
        }),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        for: vi.fn(async (mode: string) => {
          lockCalls.push({ table, mode });
          return rowsFor(table);
        }),
        then: (resolve: any, reject: any) => Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return chain;
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: any) => {
        updatePatches.push({ table, patch });
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (table === purchaseOrders && input.failHeaderCas) return [];
              return [{ ...input.lockedPo, ...patch }];
            }),
          })),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((row: any) => {
        insertedRows.push({ table, row });
        return Promise.resolve([]);
      }),
    })),
    execute: vi.fn(async () => ({
      rows: [{
        quote_evaluated_at:
          input.quoteClock?.evaluatedAt ?? new Date("2026-07-13T12:00:00.000Z"),
        quote_current_date: input.quoteClock?.currentDate ?? "2026-07-13",
      }],
    })),
  };
  const db: any = {
    ...tx,
    transaction: vi.fn(async (fn: any) => fn(tx)),
    insertedRows,
    updatePatches,
    lockCalls,
  };
  return db;
}

function po(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    subtotalCents: 100,
    totalCents: 100,
    discountCents: 0,
    taxCents: 0,
    shippingCostCents: 0,
    updatedAt: new Date("2026-07-13T12:01:00.000Z"),
    ...overrides,
  };
}

describe("purchase-order lifecycle concurrency", () => {
  it("uses locked line economics and cannot send a draft that crossed an approval threshold", async () => {
    const lockedPo = po();
    const tier = { id: 7, tierName: "Director", thresholdCents: 100_000, active: 1 };
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine()],
      settings: [{ requireApproval: true }],
      tiers: [tier],
    });
    const storage = baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    });
    const service = createPurchasingService(db, storage);

    const result = await service.sendPurchaseOrder(1, "buyer-1");

    expect(result.status).toBe("pending_approval");
    expect(result.pendingApproval).toBe(true);
    expect(result.pdf).toBeNull();
    const headerPatch = db.updatePatches.find((call: any) => call.table === purchaseOrders)?.patch;
    expect(headerPatch).toMatchObject({
      status: "pending_approval",
      approvalTierId: 7,
      subtotalCents: 150_000,
      totalCents: 150_000,
    });
    expect(db.insertedRows).toContainEqual(expect.objectContaining({
      table: poEvents,
      row: expect.objectContaining({
        eventType: "submitted",
        payloadJson: expect.objectContaining({ total_cents: 150_000, tier_id: 7 }),
      }),
    }));
    expect(db.insertedRows.some((entry: any) => entry.row?.eventType === "sent_to_vendor")).toBe(false);
  });

  it("invalidates an approval when a locked line changed after approval", async () => {
    const lockedPo = po({
      status: "approved",
      approvalTierId: 7,
      approvedAt: new Date("2026-07-13T12:05:00.000Z"),
      updatedAt: new Date("2026-07-13T12:05:00.000Z"),
    });
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine({ updatedAt: new Date("2026-07-13T12:06:00.000Z") })],
      settings: [{ requireApproval: true }],
      tiers: [{ id: 7, tierName: "Director", thresholdCents: 100_000, active: 1 }],
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    const result = await service.sendPurchaseOrder(1, "buyer-2");

    expect(result.status).toBe("pending_approval");
    const headerPatch = db.updatePatches.find((call: any) => call.table === purchaseOrders)?.patch;
    expect(headerPatch).toMatchObject({
      status: "pending_approval",
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
    });
    const submitted = db.insertedRows.find((entry: any) => entry.row?.eventType === "submitted");
    expect(submitted?.row.payloadJson).toMatchObject({ approval_invalidated: true });
  });

  it("returns 409 if the header version changes while the action waits for its lock", async () => {
    const observed = po({ updatedAt: new Date("2026-07-13T12:01:00.000Z") });
    const locked = po({ updatedAt: new Date("2026-07-13T12:02:00.000Z") });
    const db = lifecycleDb({ lockedPo: locked, lines: [exactLine()] });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(observed),
    }));

    await expect(service.sendPurchaseOrder(1, "buyer-3")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("writes no history or event when the status-qualified header CAS loses", async () => {
    const lockedPo = po();
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine()],
      settings: [{ requireApproval: false }],
      failHeaderCas: true,
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    await expect(service.sendPurchaseOrder(1, "buyer-4")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.insertedRows.filter((entry: any) =>
      entry.table === poStatusHistory || entry.table === poEvents,
    )).toHaveLength(0);
  });

  it("uses database time and blocks an expired manual quote before submission", async () => {
    const lockedPo = po();
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine({
        pricingSource: "manual",
        quotedAt: new Date("2028-06-01T00:00:00.000Z"),
        quoteValidUntil: "2028-12-31",
      })],
      quoteClock: {
        evaluatedAt: new Date("2029-01-02T12:00:00.000Z"),
        currentDate: "2029-01-02",
      },
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    await expect(service.submit(1, "buyer-expired")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "PO_LINE_QUOTE_EXPIRED",
        lineId: 10,
        currentDate: "2029-01-02",
      }),
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("uses the database-session quoted-at date near a timezone boundary", async () => {
    const lockedPo = po();
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine({
        pricingSource: "manual",
        quotedAt: new Date("2026-07-13T00:30:00.000Z"),
        // PostgreSQL session is still on July 12 (for example America/New_York).
        quotedAtDate: "2026-07-12",
        quoteValidUntil: null,
      })],
      quoteClock: {
        evaluatedAt: new Date("2026-07-13T00:31:00.000Z"),
        currentDate: "2026-07-12",
      },
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    const result = await service.submit(1, "buyer-timezone");

    expect(result.status).toBe("approved");
    expect(db.updatePatches.find((entry: any) => entry.table === purchaseOrders)?.patch)
      .toMatchObject({ status: "approved" });
  });

  it("blocks an unreviewed legacy product line but not a non-product adjustment", async () => {
    const lockedPo = po();
    const db = lifecycleDb({
      lockedPo,
      lines: [
        exactLine({
          lineNumber: 1,
          lineType: "product",
          pricingBasis: "legacy_unknown",
          pricingSource: "legacy",
        }),
        exactLine({
          id: 11,
          lineNumber: 2,
          lineType: "fee",
          pricingBasis: "not_applicable",
          pricingSource: "legacy",
          orderQty: 1,
          lineTotalCents: 500,
        }),
      ],
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    await expect(service.submit(1, "buyer-review")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "PO_LINE_QUOTE_REVIEW_REQUIRED",
        lineId: 10,
        lineNumber: 1,
        pricingBasis: "legacy_unknown",
      }),
    });
    expect(db.execute).not.toHaveBeenCalled();
    // Legacy cent-field repairs are attempted under the same transaction and
    // therefore roll back with the lifecycle rejection. No header transition
    // or durable audit is allowed.
    expect(db.updatePatches.filter((entry: any) => entry.table === purchaseOrders)).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("locks and revalidates active catalog provenance before sending", async () => {
    const lockedPo = po({ vendorId: 9 });
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine({
        productId: 5,
        pricingSource: "vendor_catalog",
        vendorProductId: 22,
        quotedAt: new Date("2026-07-01T00:00:00.000Z"),
        quoteValidUntil: "2026-07-31",
      })],
      vendorProducts: [{
        id: 22,
        vendorId: 9,
        productId: 5,
        isActive: 1,
      }],
      settings: [{ requireApproval: false }],
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    const result = await service.sendPurchaseOrder(1, "buyer-current");

    expect(result.status).toBe("sent");
    expect(db.lockCalls).toContainEqual({ table: vendorProducts, mode: "share" });
    expect(db.insertedRows).toContainEqual(expect.objectContaining({
      table: poEvents,
      row: expect.objectContaining({ eventType: "sent_to_vendor" }),
    }));
  });

  it("blocks sending when trusted catalog provenance is no longer active", async () => {
    const lockedPo = po({ vendorId: 9 });
    const db = lifecycleDb({
      lockedPo,
      lines: [exactLine({
        productId: 5,
        pricingSource: "recommendation",
        vendorProductId: 22,
        quotedAt: new Date("2026-07-01T00:00:00.000Z"),
        quoteValidUntil: "2026-07-31",
      })],
      vendorProducts: [{
        id: 22,
        vendorId: 9,
        productId: 5,
        isActive: 0,
      }],
      settings: [{ requireApproval: false }],
    });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    }));

    await expect(service.sendPurchaseOrder(1, "buyer-inactive")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "PO_LINE_VENDOR_CATALOG_PROVENANCE_INACTIVE",
        lineId: 10,
        vendorProductId: 22,
      }),
    });
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("returns a pending PO to draft with locked totals, cleared approval, and atomic audit", async () => {
    const lockedPo = po({
      status: "pending_approval",
      approvalTierId: 7,
      approvedBy: "manager-1",
      approvedAt: new Date("2026-07-13T12:05:00.000Z"),
      approvalNotes: "Previously approved",
      discountCents: 1_000,
      taxCents: 500,
      shippingCostCents: 250,
    });
    const db = lifecycleDb({ lockedPo, lines: [exactLine()] });
    const storage = baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(lockedPo),
    });
    const service = createPurchasingService(db, storage);

    const result = await service.returnToDraft(1, "buyer-5", "Revise vendor quantities");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.lockCalls).toEqual(expect.arrayContaining([
      { table: purchaseOrders, mode: "update" },
      { table: purchaseOrderLines, mode: "update" },
    ]));
    const headerPatch = db.updatePatches.find((call: any) => call.table === purchaseOrders)?.patch;
    expect(headerPatch).toMatchObject({
      status: "draft",
      physicalStatus: "draft",
      subtotalCents: 150_000,
      totalCents: 149_750,
      lineCount: 1,
      approvalTierId: null,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: "buyer-5",
    });
    expect(result).toMatchObject({ status: "draft", totalCents: 149_750 });
    expect(db.insertedRows).toContainEqual({
      table: poStatusHistory,
      row: expect.objectContaining({
        purchaseOrderId: 1,
        fromStatus: "pending_approval",
        toStatus: "draft",
        changedBy: "buyer-5",
        notes: "Revise vendor quantities",
      }),
    });
    expect(db.insertedRows).toContainEqual({
      table: poEvents,
      row: expect.objectContaining({
        poId: 1,
        eventType: "returned_to_draft",
        actorId: "buyer-5",
        payloadJson: expect.objectContaining({
          from_status: "pending_approval",
          to_status: "draft",
          total_cents: 149_750,
        }),
      }),
    });
    expect(storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
    expect(storage.updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("returns 409 without writes when return-to-draft loses its observed version", async () => {
    const observed = po({
      status: "pending_approval",
      updatedAt: new Date("2026-07-13T12:01:00.000Z"),
    });
    const locked = po({
      status: "pending_approval",
      updatedAt: new Date("2026-07-13T12:02:00.000Z"),
    });
    const db = lifecycleDb({ lockedPo: locked, lines: [exactLine()] });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(observed),
    }));

    await expect(
      service.returnToDraft(1, "buyer-6", "Stale action"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.lockCalls).toContainEqual({ table: purchaseOrders, mode: "update" });
    expect(db.lockCalls.some((call: any) => call.table === purchaseOrderLines)).toBe(false);
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("rejects a stale physical transition before status history or event writes", async () => {
    const observed = po({
      status: "acknowledged",
      physicalStatus: "acknowledged",
      updatedAt: new Date("2026-07-13T12:01:00.000Z"),
    });
    const locked = po({
      status: "acknowledged",
      physicalStatus: "acknowledged",
      updatedAt: new Date("2026-07-13T12:02:00.000Z"),
    });
    const db = lifecycleDb({ lockedPo: locked, lines: [] });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(observed),
    }));

    await expect(service.transitionPhysical(1, "shipped", "buyer-7")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.lockCalls).toContainEqual({ table: purchaseOrders, mode: "update" });
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("rejects stale cancel before locking or cancelling PO lines", async () => {
    const observed = po({
      status: "approved",
      physicalStatus: "draft",
      updatedAt: new Date("2026-07-13T12:01:00.000Z"),
    });
    const locked = po({
      status: "sent",
      physicalStatus: "sent",
      updatedAt: new Date("2026-07-13T12:02:00.000Z"),
    });
    const db = lifecycleDb({ lockedPo: locked, lines: [exactLine()] });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(observed),
    }));

    await expect(service.cancel(1, "stale cancellation", "buyer-8")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.lockCalls.some((call: any) => call.table === purchaseOrderLines)).toBe(false);
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });

  it("rejects stale close-short before changing open line quantities", async () => {
    const observed = po({
      status: "partially_received",
      physicalStatus: "receiving",
      updatedAt: new Date("2026-07-13T12:01:00.000Z"),
    });
    const locked = po({
      status: "partially_received",
      physicalStatus: "receiving",
      updatedAt: new Date("2026-07-13T12:02:00.000Z"),
    });
    const db = lifecycleDb({ lockedPo: locked, lines: [exactLine()] });
    const service = createPurchasingService(db, baseStorage({
      getPurchaseOrderById: vi.fn().mockResolvedValue(observed),
    }));

    await expect(service.closeShort(1, "vendor short", "buyer-9")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "PO_LIFECYCLE_CONFLICT" }),
    });
    expect(db.lockCalls.some((call: any) => call.table === purchaseOrderLines)).toBe(false);
    expect(db.updatePatches).toHaveLength(0);
    expect(db.insertedRows).toHaveLength(0);
  });
});

function inlineRetryDb(vendor: any) {
  const conflict = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "purchase_orders_po_number_active_uidx",
  });
  let transactionAttempt = 0;
  const attemptedPoNumbers: string[] = [];

  const db: any = {
    transaction: vi.fn(async (fn: any) => {
      transactionAttempt++;
      const tx: any = {
        select: vi.fn(() => {
          let table: unknown;
          const chain: any = {
            from: vi.fn((value: unknown) => {
              table = value;
              return chain;
            }),
            where: vi.fn(() => chain),
            orderBy: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            for: vi.fn(async () => table === vendors ? [vendor] : []),
          };
          return chain;
        }),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((values: any) => {
            if (table === purchaseOrders) {
              attemptedPoNumbers.push(values.poNumber);
              return {
                returning: vi.fn(async () => {
                  if (transactionAttempt === 1) throw conflict;
                  return [{ id: 101, ...values }];
                }),
              };
            }
            if (table === purchaseOrderLines) {
              return {
                returning: vi.fn(async () => [{ id: 201, lineNumber: 1 }]),
              };
            }
            return Promise.resolve([]);
          }),
        })),
        update: vi.fn(),
      };
      return fn(tx);
    }),
  };
  return { db, attemptedPoNumbers };
}

describe("purchase-order number race recovery", () => {
  it("retries legacy create after the unique index resolves a collision", async () => {
    const conflict = Object.assign(new Error("duplicate PO number"), {
      code: "23505",
      constraint: "purchase_orders_po_number_active_uidx",
    });
    const storage = baseStorage({
      getVendorById: vi.fn().mockResolvedValue({ id: 9, currency: "USD" }),
      generatePoNumber: vi.fn()
        .mockResolvedValueOnce("PO-20260713-001")
        .mockResolvedValueOnce("PO-20260713-002"),
      createPurchaseOrder: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockImplementationOnce(async (values: any) => ({ id: 22, ...values })),
    });
    const service = createPurchasingService({} as any, storage);

    const created = await service.createPO({ vendorId: 9, createdBy: "buyer-5" });

    expect(created.poNumber).toBe("PO-20260713-002");
    expect(storage.generatePoNumber).toHaveBeenCalledTimes(2);
    expect(storage.createPurchaseOrder).toHaveBeenCalledTimes(2);
  });

  it("retries the entire inline header/lines/audit transaction with a fresh number", async () => {
    const vendor = { id: 9, active: 1, currency: "USD" };
    const { db, attemptedPoNumbers } = inlineRetryDb(vendor);
    const storage = baseStorage({
      getVendorById: vi.fn().mockResolvedValue(vendor),
      generatePoNumber: vi.fn()
        .mockResolvedValueOnce("PO-20260713-010")
        .mockResolvedValueOnce("PO-20260713-011"),
    });
    const service = createPurchasingService(db, storage);

    const created = await service.createPurchaseOrderWithLines({
      vendorId: 9,
      lines: [{
        lineType: "fee",
        description: "Tooling",
        orderQty: 1,
        unitCostCents: 2_500,
      }],
    });

    expect(created.poNumber).toBe("PO-20260713-011");
    expect(attemptedPoNumbers).toEqual(["PO-20260713-010", "PO-20260713-011"]);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
});
