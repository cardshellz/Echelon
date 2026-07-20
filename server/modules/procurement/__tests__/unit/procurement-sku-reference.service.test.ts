import { describe, expect, it, vi } from "vitest";
import {
  ProcurementSkuReferenceError,
  synchronizeProcurementSkuReferences,
} from "../../procurement-sku-reference.service";

function createExecutor(rowCounts: number[] = [2, 1, 3, 4]) {
  const updates: Array<Record<string, unknown>> = [];
  let updateIndex = 0;
  const auditValues = vi.fn(async () => []);
  const executor = {
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            const rowCount = rowCounts[updateIndex++] ?? 0;
            return Array.from({ length: rowCount }, (_, index) => ({ id: index + 1 }));
          },
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: auditValues })),
  };
  return { executor, updates, auditValues };
}

describe("synchronizeProcurementSkuReferences", () => {
  it("updates every procurement-owned SKU cache and audits the result in one transaction", async () => {
    const { executor, updates, auditValues } = createExecutor();
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) => await callback(executor));
    const changedAt = new Date("2026-07-20T12:00:00.000Z");

    const result = await synchronizeProcurementSkuReferences({
      productVariantId: 42,
      oldSku: "OLD-SKU",
      newSku: "NEW-SKU",
      actor: "user:7",
    }, {
      database: { transaction } as any,
      now: () => changedAt,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(executor.update).toHaveBeenCalledTimes(4);
    expect(updates).toEqual([
      { sku: "NEW-SKU", updatedAt: changedAt },
      { sku: "NEW-SKU", updatedAt: changedAt },
      { sku: "NEW-SKU", updatedAt: changedAt },
      { sku: "NEW-SKU", updatedAt: changedAt },
    ]);
    expect(result).toEqual({
      purchaseOrderLines: 2,
      inboundShipmentLines: 1,
      receivingLines: 3,
      vendorInvoiceLines: 4,
    });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: changedAt,
      actor: "user:7",
      action: "procurement.sku_reference.rename",
      target: "catalog.product_variant:42",
      changes: {
        before: { sku: "OLD-SKU" },
        after: { sku: "NEW-SKU" },
      },
      context: {
        productVariantId: 42,
        affectedRows: result,
      },
    }));
  });

  it("does not write an audit record when a procurement cache update fails", async () => {
    const { executor, auditValues } = createExecutor();
    executor.update.mockImplementationOnce((): any => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw new Error("database failure");
          },
        }),
      }),
    }));
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) => await callback(executor));

    await expect(synchronizeProcurementSkuReferences({
      productVariantId: 42,
      oldSku: "OLD-SKU",
      newSku: "NEW-SKU",
      actor: "user:7",
    }, { database: { transaction } as any })).rejects.toThrow("database failure");

    expect(transaction).toHaveBeenCalledOnce();
    expect(auditValues).not.toHaveBeenCalled();
  });

  it("rejects invalid identity before opening a transaction", async () => {
    const transaction = vi.fn();

    await expect(synchronizeProcurementSkuReferences({
      productVariantId: 0,
      oldSku: "OLD-SKU",
      newSku: "NEW-SKU",
      actor: "user:7",
    }, { database: { transaction } as any })).rejects.toBeInstanceOf(ProcurementSkuReferenceError);

    expect(transaction).not.toHaveBeenCalled();
  });
});
