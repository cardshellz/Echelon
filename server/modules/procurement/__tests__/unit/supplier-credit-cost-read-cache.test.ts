import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseLineCostStatus } from "@shared/procurement/purchase-cost-status";
import { createSupplierCreditCostReadCache } from "../../supplier-credit-cost-read-cache";

const readers = vi.hoisted(() => ({ purchase: vi.fn(), shipment: vi.fn() }));
vi.mock("../../purchase-cost-status.repository", () => ({ readPurchaseCostStatus: readers.purchase }));
vi.mock("../../po-shipment-cost-summary.repository", () => ({ readPoShipmentCosts: readers.shipment }));

function line(id: number): PurchaseLineCostStatus {
  return { purchaseOrderId: 10, purchaseOrderLineId: id, sku: `SKU-${id}`, invoices: [], receipts: [], lots: [],
    components: ["product", "packaging"].map(component => ({ component: component as "product" | "packaging",
      status: "pending", sourceEvidence: "unknown", sourceCurrent: false, sourceRevisionId: null, applicationId: null, issues: [] })) };
}

describe("supplier credit cost reads share only one request's immutable database snapshot", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads shared purchase lines once and batches only newly requested lines", async () => {
    const tx = { execute: vi.fn() };
    readers.purchase.mockImplementation(async (_tx, ids: number[]) => ({ lines: ids.map(line) }));
    const cache = createSupplierCreditCostReadCache(tx);
    expect(await cache.readPurchaseLines([1, 2, 1])).toEqual([line(1), line(2)]);
    expect(await cache.readPurchaseLines([2, 3])).toEqual([line(2), line(3)]);
    expect(readers.purchase.mock.calls).toEqual([[tx, [1, 2]], [tx, [3]]]);
  });

  it("shares in-flight reads and preserves failures rather than returning empty evidence", async () => {
    const tx = { execute: vi.fn() };
    const failure = new Error("Source read unavailable");
    readers.purchase.mockRejectedValue(failure);
    const cache = createSupplierCreditCostReadCache(tx);
    const results = await Promise.allSettled([cache.readPurchaseLines([1]), cache.readPurchaseLines([1])]);
    expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(readers.purchase).toHaveBeenCalledTimes(1);
  });

  it("reuses each landed scope and PO projection without starting another transaction", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce({ rows: [{ inbound_shipment_id: 31 }] })
      .mockResolvedValueOnce({ rows: [{ purchase_order_id: 10 }, { purchase_order_id: 11 }] }) };
    readers.shipment.mockImplementation(async db => db.transaction(async (supplied: unknown) => {
      expect(supplied).toBe(tx);
      return null;
    }));
    const cache = createSupplierCreditCostReadCache(tx);
    expect(await cache.readShipmentScope(20)).toEqual({ shipmentId: 31, purchaseOrderIds: [10, 11] });
    expect(await cache.readShipmentScope(20)).toEqual({ shipmentId: 31, purchaseOrderIds: [10, 11] });
    await Promise.all([cache.readPoShipments(10), cache.readPoShipments(10), cache.readPoShipments(11)]);
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(readers.shipment).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse with another transaction and never shares evidence across fresh caches", async () => {
    const first = { execute: vi.fn() };
    const second = { execute: vi.fn() };
    readers.purchase.mockImplementation(async (_tx, ids: number[]) => ({ lines: ids.map(line) }));
    const cache = createSupplierCreditCostReadCache(first);
    expect(() => cache.assertTransaction(first)).not.toThrow();
    expect(() => cache.assertTransaction(second)).toThrow("original read transaction");
    await cache.readPurchaseLines([1]);
    await createSupplierCreditCostReadCache(first).readPurchaseLines([1]);
    await createSupplierCreditCostReadCache(second).readPurchaseLines([1]);
    expect(readers.purchase).toHaveBeenCalledTimes(3);
  });
});
