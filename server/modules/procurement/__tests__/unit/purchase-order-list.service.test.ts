import { describe, expect, it, vi } from "vitest";
import type { PoFinancialEvidenceInput } from "../../domain/po-financial-evidence";
import { createPurchaseOrderListService } from "../../purchase-order-list.service";

function harness(count = 3) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1, financialStatus: "paid", paidTotalCents: 999 }));
  const sources = new Map(rows.map(row => [row.id, { purchaseOrderId: row.id, vendorId: 9, currency: "USD", invoices: [] } satisfies PoFinancialEvidenceInput]));
  const source = {
    rows: vi.fn(async (limit: number, offset: number) => rows.slice(offset, offset + limit)),
    count: vi.fn(async () => rows.length),
    evidence: vi.fn(async (ids: readonly number[]) => new Map(ids.flatMap(id => sources.has(id) ? [[id, sources.get(id)!] as const] : []))),
  };
  const snapshot = vi.fn(async (_filters: unknown, read: (value: typeof source) => Promise<unknown>) => read(source));
  return { rows, sources: sources as Map<number, PoFinancialEvidenceInput>, source, snapshot,
    read: createPurchaseOrderListService({ snapshot } as any) };
}

describe("purchase order list canonical financial selection", () => {
  it("enriches every returned row without treating paid compatibility caches as settlement", async () => {
    const test = harness();
    const page = await test.read({ limit: 1, offset: 1, status: ["draft", "sent"], vendorId: 9 });
    expect(page).toMatchObject({ total: 3, purchaseOrders: [{ id: 2, financialStatus: "paid", financialWorkflow: { state: "unbilled", purchaseOrderId: 2 } }] });
    expect(test.snapshot).toHaveBeenCalledWith({ status: ["draft", "sent"], vendorId: 9 }, expect.any(Function));
  });
  it("applies canonical filtering before offset/limit and counts past the first batch", async () => {
    const test = harness(205);
    const invalidSource = (id: number) => ({ purchaseOrderId: id, vendorId: 9, currency: "CAD", invoices: [] });
    for (const id of [2, 201, 205]) test.sources.set(id, invalidSource(id));
    const page = await test.read({ financialWorkflow: "review_required", offset: 1, limit: 1 });
    expect(page).toMatchObject({ total: 3, purchaseOrders: [{ id: 201, financialWorkflow: { state: "review_required" } }] });
    expect(test.source.rows).toHaveBeenCalledTimes(2);
    expect(test.source.count).not.toHaveBeenCalled();
  });
  it("preserves unknown partial shared settlement in the list contract", async () => {
    const test = harness();
    test.sources.set(1, {
      purchaseOrderId: 1, vendorId: 9, currency: "USD", invoices: [{
        id: 10, vendorId: 9, currency: "USD", status: "partially_paid", invoicedAmountCents: 1000, paidAmountCents: 400, balanceCents: 600,
        links: [1, 2].map(purchaseOrderId => ({ purchaseOrderId, purchaseOrderVendorId: 9, purchaseOrderCurrency: "USD" })),
        lines: [1, 2].map(purchaseOrderId => ({ id: purchaseOrderId + 20, purchaseOrderLineId: purchaseOrderId + 30, purchaseOrderId, freightCostId: null, lineTotalCents: 500 })),
        payments: [{ allocationId: 41, paymentId: 51, paymentVendorId: 9, paymentCurrency: "USD", paymentStatus: "completed", appliedAmountCents: 400 }],
      }],
    });
    const page = await test.read({ financialWorkflow: "review_required" });
    expect(page).toMatchObject({ total: 1, purchaseOrders: [{ id: 1, financialWorkflow: { state: "review_required", evidence: { invoicedAmountCents: 500, paidAmountCents: null, outstandingAmountCents: null } } }] });
    expect((await test.read({ financialWorkflow: "settled" })).total).toBe(0);
  });
  it("does not convert a missing evidence source into an unbilled row", async () => {
    const test = harness(); test.sources.delete(1);
    await expect(test.read({})).rejects.toThrow("financial evidence source is missing");
  });
  it.each([{ financialWorkflow: "paid" }, { financialWorkflow: ["settled"] }, { limit: 0 }, { offset: -1 }, { vendorId: 0 }, { unsupported: true }])("rejects malformed filters before reading %j", async input => {
    const test = harness(); await expect(test.read(input)).rejects.toThrow(); expect(test.snapshot).not.toHaveBeenCalled();
  });
});
