import { describe, expect, it } from "vitest";
import { buildInvoicePoQuantities, invoicePoQuantitiesSchema } from "../../invoice-po-quantities";

const source = { id: 160, purchaseOrderId: 113, orderQty: 25000, receivedQty: 25000 };

describe("invoice current PO quantity comparison", () => {
  it("returns the linked PO's current counts without mutating the source", () => {
    expect(buildInvoicePoQuantities(160, Object.freeze(source))).toEqual({
      status: "current", purchaseOrderId: 113, purchaseOrderLineId: 160, orderedQty: 25000, receivedQty: 25000,
    });
    expect(source).toEqual({ id: 160, purchaseOrderId: 113, orderQty: 25000, receivedQty: 25000 });
  });
  it("distinguishes an unlinked invoice from an unavailable or mismatched PO line", () => {
    expect(buildInvoicePoQuantities(null, null)).toEqual({ status: "unlinked" });
    expect(buildInvoicePoQuantities(160, null)).toEqual({ status: "unavailable" });
    expect(buildInvoicePoQuantities(161, source)).toEqual({ status: "unavailable" });
  });
  it("preserves zero quantities and treats an absent received count as zero", () => {
    expect(buildInvoicePoQuantities(160, { ...source, orderQty: 0, receivedQty: null })).toMatchObject({ orderedQty: 0, receivedQty: 0 });
  });
  it("preserves maximum safe piece counts exactly", () => {
    expect(buildInvoicePoQuantities(160, { ...source, orderQty: Number.MAX_SAFE_INTEGER, receivedQty: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ orderedQty: Number.MAX_SAFE_INTEGER, receivedQty: Number.MAX_SAFE_INTEGER });
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid current counts %s", (count) => {
    expect(() => buildInvoicePoQuantities(160, { ...source, orderQty: count })).toThrow();
    expect(() => buildInvoicePoQuantities(160, { ...source, receivedQty: count })).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid PO line identity %s", (id) => {
    expect(() => buildInvoicePoQuantities(id, source)).toThrow();
  });
  it("validates the outbound comparison contract and rejects coercion and extra fields", () => {
    const comparison = buildInvoicePoQuantities(160, source);
    expect(invoicePoQuantitiesSchema.safeParse({ ...comparison, orderedQty: "25000" }).success).toBe(false);
    expect(invoicePoQuantitiesSchema.safeParse({ ...comparison, purchaseOrderId: 0 }).success).toBe(false);
    expect(invoicePoQuantitiesSchema.safeParse({ ...comparison, qtyInvoiced: 25000 }).success).toBe(false);
  });
});
