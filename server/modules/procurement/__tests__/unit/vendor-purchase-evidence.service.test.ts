import { describe, expect, it, vi } from "vitest";

import {
  auditEvents,
  poEvents,
  poStatusHistory,
  purchaseOrderLines,
  purchaseOrders,
  vendorInvoicePoLinks,
  vendorProducts,
} from "@shared/schema";
import { createPurchasingService } from "../../purchasing.service";

describe("completed supplier purchase evidence", () => {
  it("records last purchase cost/date atomically without replacing the reusable quote", async () => {
    const inserted: Array<{ table: unknown; value: any }> = [];
    const updates: Array<{ table: unknown; patch: any }> = [];
    const currentVendorProduct = {
      id: 91,
      vendorId: 7,
      productId: 101,
      productVariantId: 202,
      unitCostCents: 250,
      unitCostMills: 25_000,
      pricingBasis: "per_piece",
      quotedUnitCostMills: 25_000,
      quotedAt: new Date("2026-07-01T00:00:00.000Z"),
      lastPurchasedAt: null,
      lastCostCents: null,
      isActive: 1,
      isPreferred: 1,
    };
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    const purchaseOrder = {
      id: 1,
      vendorId: 7,
      status: "received",
      physicalStatus: "received",
      financialStatus: "unbilled",
      poNumber: "PO-001",
      updatedAt: observedAt,
    };
    const purchaseOrderLine = {
      id: 44,
      purchaseOrderId: 1,
      status: "open",
      orderQty: 12,
      receivedQty: 12,
      vendorProductId: 91,
      unitCostCents: 263,
      unitCostMills: 26_321,
    };

    const select = vi.fn(() => {
      let table: unknown;
      const rowsForTable = () => {
        if (table === purchaseOrders) return [purchaseOrder];
        if (table === vendorInvoicePoLinks) return [];
        if (table === purchaseOrderLines) return [purchaseOrderLine];
        if (table === vendorProducts) return [currentVendorProduct];
        return [];
      };
      const builder: any = {
        from: vi.fn((nextTable: unknown) => {
          table = nextTable;
          return builder;
        }),
        innerJoin: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        for: vi.fn(async () => rowsForTable()),
      };
      builder.then = (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rowsForTable()).then(resolve, reject);
      return builder;
    });

    const db: any = {
      select,
      update: vi.fn((table: unknown) => ({
        set: vi.fn((patch: any) => {
          updates.push({ table, patch });
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                if (table === purchaseOrders) return [{ id: 1, status: "closed", ...patch }];
                if (table === vendorProducts) {
                  return [{ ...currentVendorProduct, ...patch }];
                }
                return [];
              }),
            })),
          };
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (value: any) => {
          inserted.push({ table, value });
          return [];
        }),
      })),
    };
    db.transaction = vi.fn((work: (tx: any) => Promise<unknown>) => work(db));

    const storage: any = {
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        ...purchaseOrder,
      }),
    };
    const service = createPurchasingService(db, storage);

    await service.close(1, "user-1", "received and reconciled");

    const evidenceUpdate = updates.find((call) => call.table === vendorProducts);
    expect(evidenceUpdate?.patch).toMatchObject({
      lastCostCents: 263,
      lastCostMills: 26_321,
      lastPurchasedAt: expect.any(Date),
    });
    expect(evidenceUpdate?.patch).not.toHaveProperty("unitCostCents");
    expect(evidenceUpdate?.patch).not.toHaveProperty("unitCostMills");
    expect(evidenceUpdate?.patch).not.toHaveProperty("pricingBasis");

    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: poStatusHistory }),
      expect.objectContaining({ table: poEvents }),
      expect.objectContaining({
        table: auditEvents,
        value: expect.arrayContaining([
          expect.objectContaining({
            action: "vendor_catalog.purchase_evidence_updated",
            context: expect.objectContaining({
              purchaseOrderId: 1,
              vendorProductId: 91,
            }),
          }),
        ]),
      }),
    ]));
  });
});
