import { describe, expect, it } from "vitest";
import { evaluatePurchaseOrderInvoiceMatches } from "../../purchase-order-invoice-match";

const poLine = {
  id: 10,
  orderQty: 100,
  receivedQty: 100,
  unitCostCents: 7,
  unitCostMills: 650,
};

function invoiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    vendorInvoiceId: 30,
    purchaseOrderLineId: 10,
    qtyInvoiced: 100,
    unitCostCents: 7,
    unitCostMills: 650,
    ...overrides,
  } as any;
}

describe("evaluatePurchaseOrderInvoiceMatches", () => {
  it("matches current ordered, received, and invoiced quantity at mill precision", () => {
    expect(evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [poLine],
      invoiceLines: [invoiceLine()],
    })).toEqual([expect.objectContaining({
      id: 20,
      qtyReceived: 100,
      matchStatus: "matched",
    })]);
  });

  it("aggregates split invoice lines before comparing quantity", () => {
    const result = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [poLine],
      invoiceLines: [
        invoiceLine({ id: 20, vendorInvoiceId: 30, qtyInvoiced: 40 }),
        invoiceLine({ id: 21, vendorInvoiceId: 31, qtyInvoiced: 60 }),
      ],
    });

    expect(result.map((line) => line.matchStatus)).toEqual(["matched", "matched"]);
  });

  it("reports over-billing against current receipts before a generic quantity discrepancy", () => {
    const result = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [{ ...poLine, receivedQty: 75 }],
      invoiceLines: [invoiceLine()],
    });

    expect(result[0]).toMatchObject({ qtyReceived: 75, matchStatus: "over_billed" });
  });

  it("reports a quantity discrepancy when received and invoiced agree but the PO remains open", () => {
    const result = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [{ ...poLine, receivedQty: 75 }],
      invoiceLines: [invoiceLine({ qtyInvoiced: 75 })],
    });

    expect(result[0]).toMatchObject({ qtyReceived: 75, matchStatus: "qty_discrepancy" });
  });

  it("gives a line-level price discrepancy precedence over aggregate quantity state", () => {
    const result = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [poLine],
      invoiceLines: [invoiceLine({ unitCostMills: 651 })],
    });

    expect(result[0].matchStatus).toBe("price_discrepancy");
  });

  it("keeps unassigned lines pending and marks deleted PO references missing", () => {
    const result = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [],
      invoiceLines: [
        invoiceLine({ id: 20, purchaseOrderLineId: null }),
        invoiceLine({ id: 21, purchaseOrderLineId: 999 }),
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({ id: 20, matchStatus: "pending" }),
      expect.objectContaining({ id: 21, matchStatus: "po_line_missing" }),
    ]);
  });

  it("fails closed on unsafe database quantities", () => {
    expect(() => evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: [poLine],
      invoiceLines: [invoiceLine({ qtyInvoiced: Number.MAX_SAFE_INTEGER + 1 })],
    })).toThrow("qtyInvoiced must be a non-negative safe integer");
  });
});
