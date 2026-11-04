import { describe, expect, it } from "vitest";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { supplierHeaderEntriesSchema, type SupplierHeaderSource } from "@shared/procurement/supplier-header-costs";
import { allocateSupplierHeader, proposedSupplierHeaderEntries, selectSupplierHeaderShares, supplierHeaderSourceFingerprint } from "../../domain/supplier-header-costs";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { evaluateSupplierCreditSource } from "../../domain/supplier-credit-source";

const source = (amountMills = 100): SupplierHeaderSource => ({
  target: { kind: "invoice", id: 1 }, reference: "INV-1", currency: "USD", expectedMills: amountMills, facts: [], types: [],
  lines: [1, 2, 3].map(id => ({ id, purchaseOrderLineId: id, kind: "product", freightCostId: null, inboundShipmentId: null,
    name: `Line ${id}`, basisMills: 10000, packagingTreatment: "separate" })),
});
describe("combined supplier amounts and header allocations", () => {
  it("selects a known combined amount without asserting a separate packaging price", () => {
    const result = resolvePurchaseCostSource({ purchaseOrderLine: { id: 1, purchase_order_id: 1, line_type: "product", currency: "USD", order_qty: 100,
      received_qty: 100, status: "received", total_product_cost_cents: 8000, packaging_cost_cents: 1000, discount_cents: 0, tax_cents: 0 },
      approvedInvoices: [{ id: 1, vendor_invoice_id: 1, currency: "USD", qty_invoiced: 100, line_total_cents: 10000,
        cost_component_evidence: { contractVersion: 1, source: "operator_review", packagingTreatment: "combined", productMills: 1000000, packagingMills: 0, adjustmentMills: 0 } }] });
    expect(result.map(row => [row.component, row.totalMills, row.packagingTreatment, row.evidence])).toEqual([
      ["product", 1000000, "combined", "confirmed"], ["packaging", 0, "combined", "confirmed"],
    ]);
  });
  it("rejects a separate packaging assertion or credit until a combined bill has an evidenced split", () => {
    const evidence = { contractVersion: 1, source: "operator_review", packagingTreatment: "combined", productMills: 1000000, packagingMills: 0, adjustmentMills: 0 };
    expect(invoiceCostComponentEvidenceSchema.safeParse({ ...evidence, packagingMills: 1 }).success).toBe(false);
    const result = evaluateSupplierCreditSource({ line: { invoiceLineId: 1, amountCents: 1, disposition: { kind: "price_reduction", component: "packaging" } },
      invoice: { id: 1, vendor_invoice_id: 1, purchase_order_line_id: 1, qty_invoiced: 100, line_total_cents: 10000, currency: "USD", cost_component_evidence: evidence } });
    expect(result.costIssues.some(row => row.code === "CREDIT_COMPONENT_EXCEEDED")).toBe(true);
  });
  it.each([100, -100, 0, 10000, -10000])("conserves every cent on signed header %s, with stable ties", amount => {
    const document = source(amount), entries = proposedSupplierHeaderEntries(document), before = structuredClone(document);
    const result = allocateSupplierHeader(document, entries);
    expect(result.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0))).toBe(BigInt(amount));
    expect(allocateSupplierHeader({ ...document, lines: [...document.lines].reverse() }, entries)).toEqual(result);
    if (amount === 100) expect(result).toEqual([expect.objectContaining({ lineId: 1, amountMills: 100 })]);
    expect(document).toEqual(before);
  });
  it("supports explicit manual overrides and rejects missing, foreign and sign-inverting shares", () => {
    const document = source(10000), entry = { ...proposedSupplierHeaderEntries(document)[0], method: "manual" as const,
      shares: [{ lineId: 1, amountMills: 3000 }, { lineId: 2, amountMills: 7000 }] };
    expect(allocateSupplierHeader(document, [entry])).toHaveLength(2);
    for (const shares of [[{ lineId: 999, amountMills: 10000 }], [{ lineId: 1, amountMills: 9900 }],
      [{ lineId: 1, amountMills: -100 }, { lineId: 2, amountMills: 10100 }]])
      expect(() => allocateSupplierHeader(document, [{ ...entry, shares }])).toThrow(/eligible|conserve|sign/);
  });
  it("keeps an approved by-value rule valid on later approved quantity/line changes", () => {
    const document = source(30000), evidence = { contractVersion: 1, sourceFingerprint: supplierHeaderSourceFingerprint(document), entries: proposedSupplierHeaderEntries(document) };
    const next = { ...document, lines: document.lines.map(row => ({ ...row, basisMills: row.id === 1 ? 20000 : 5000 })) };
    expect(selectSupplierHeaderShares(next, evidence).map(row => row.amountMills)).toEqual([20000, 5000, 5000]);
    expect(() => selectSupplierHeaderShares({ ...next, expectedMills: 30100 }, evidence)).toThrow(/changed/);
  });
  it("binds every PO adjustment to its original fixed amount and parent scope", () => {
    const document: SupplierHeaderSource = { ...source(-10000), target: { kind: "purchase_order", id: 1 },
      facts: [{ key: "line_4", label: "Discount", category: "discount", amountMills: -10000, lineIds: [2] }] };
    expect(allocateSupplierHeader(document, proposedSupplierHeaderEntries(document))).toEqual([expect.objectContaining({ lineId: 2, amountMills: -10000 })]);
    expect(() => allocateSupplierHeader(document, [{ ...proposedSupplierHeaderEntries(document)[0], key: "invented" }])).toThrow(/original source/);
  });
  it("respects configured tax treatment and requires a separate packaging source", () => {
    const document = { ...source(10000), types: [{ id: 1, code: "VAT", name: "VAT", revision: 1, treatment: "recoverable" as const }] };
    const entry = { ...proposedSupplierHeaderEntries(document)[0], category: "tax" as const, destination: "tax" as const, taxTypeId: 1 };
    expect(allocateSupplierHeader(document, [entry]).every(row => row.taxTreatment === "recoverable")).toBe(true);
    expect(() => allocateSupplierHeader(document, [{ ...entry, taxTypeId: 2 }])).toThrow(/configured tax/);
    expect(() => allocateSupplierHeader({ ...document, lines: document.lines.map(row => ({ ...row, packagingTreatment: "combined" as const })) },
      [{ ...entry, category: "other", destination: "packaging", taxTypeId: null }])).toThrow(/evidenced split/);
  });
  it.each([0.1, Number.MAX_SAFE_INTEGER + 1, "100", Infinity])("rejects invalid header money %s at the boundary", amountMills => {
    expect(supplierHeaderEntriesSchema.safeParse([{ ...proposedSupplierHeaderEntries(source())[0], amountMills }]).success).toBe(false);
  });
});
