import { describe, expect, it } from "vitest";
import { invoiceCostComponentEvidenceSchema, invoiceGoodsAmounts } from "@shared/procurement/invoice-cost-evidence";
import { receiptSegmentCost } from "@shared/procurement/receipt-cost-segments";
import { supplierCreditCreateInputSchema, supplierCreditLineSourceKey } from "@shared/procurement/supplier-credit";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { evaluateSupplierCreditSource, resolveSupplierCreditReductions } from "../../domain/supplier-credit-source";
import type { ReceiptInvoiceSource } from "../../domain/receipt-invoice-costs";

function source(): ReceiptInvoiceSource {
  return { purchaseOrderLine: { id: 21, purchase_order_id: 10, line_type: "product", currency: "USD", order_qty: 100,
    received_qty: 100, status: "received", total_product_cost_cents: 10000, packaging_cost_cents: 1000, discount_cents: 0, tax_cents: 0 },
    approvedInvoices: [{ id: 72, vendor_invoice_id: 71, qty_invoiced: 100, line_total_cents: 11700, currency: "USD",
      cost_component_evidence: { contractVersion: 1, source: "operator_review", packagingTreatment: "separate",
        productMills: 1200000, packagingMills: 100000, adjustmentMills: -130000,
        adjustments: [{ key: "discount", label: "Supplier discount", category: "discount", amountMills: -150000, destination: "product" },
          { key: "pack", label: "Packaging charge", category: "other", amountMills: 20000, destination: "packaging" }] } }],
    receiptCosting: { receipts: [{ receivingLineId: 101, receiptId: 1, receiptNumber: "RCV-A", startBasePiece: 0, pieces: 40 },
      { receivingLineId: 102, receiptId: 2, receiptNumber: "RCV-B", startBasePiece: 40, pieces: 60 }], allocations: [
      { receivingLineId: 101, invoiceLineId: 72, receiptStartPiece: 0, invoiceStartPiece: 0, pieces: 40 },
      { receivingLineId: 102, invoiceLineId: 72, receiptStartPiece: 0, invoiceStartPiece: 40, pieces: 60 }] } };
}
function credited(input = source(), amountCents = 1000) {
  const disposition = { kind: "price_reduction" as const, component: "product" as const,
    receiptAllocation: { receivingLineId: 101, receiptStartPiece: 0, invoiceStartPiece: 0, pieces: 40 } };
  const evaluated = evaluateSupplierCreditSource({ line: { invoiceLineId: 72, amountCents, disposition }, invoice: { ...input.approvedInvoices[0], purchase_order_line_id: 21 } });
  input.supplierCredits = [{ id: 1, supplier_credit_id: 1, invoice_line_id: 72, amount_cents: amountCents, status: "approved", disposition, source_evidence: evaluated.sourceEvidence }];
  return input;
}
const product = (input: ReceiptInvoiceSource) => resolvePurchaseCostSource(input).find(row => row.component === "product")!;
describe("receipt-specific billed adjustments and credits", () => {
  it("selects exact net goods without changing the original invoice or averaging receipts", () => {
    const input = credited(), snapshot = structuredClone(input), selected = product(input);
    expect(selected.evidence).toBe("confirmed");
    expect(receiptSegmentCost(selected.receiptCostSegments!, 0, 40, 101).totalMills).toBe(320000);
    expect(receiptSegmentCost(selected.receiptCostSegments!, 40, 60, 102).totalMills).toBe(630000);
    expect(selected.totalMills).toBe(950000);
    expect(input).toEqual(snapshot);
  });
  it("keeps uninvoiced pieces provisional, without assigning a credit to them", () => {
    const input = credited(); input.receiptCosting!.allocations.pop();
    const selected = product(input);
    expect(selected.evidence).toBe("estimated");
    expect(receiptSegmentCost(selected.receiptCostSegments!, 40, 60, 102)).toEqual({ totalMills: 600000, confirmedPieces: 0, provisionalPieces: 60 });
  });
  it("void compensates the receipt once and retains the original credit reference", () => {
    const input = credited(); input.supplierCredits![0].status = "voided";
    const selected = product(input);
    expect(selected.totalMills).toBe(1050000);
    expect(selected.sources.some(row => row.kind === "supplier_credit_line")).toBe(true);
  });
  it.each(["missing", "different_receipt", "offset", "changed_invoice"])("retains review rather than spreading a %s credit", kind => {
    const input = credited(), evidence = input.supplierCredits![0].source_evidence as any;
    if (kind === "missing") { delete evidence.receiptAllocation; delete (input.supplierCredits![0].disposition as any).receiptAllocation; }
    if (kind === "different_receipt") evidence.receiptAllocation.receivingLineId = 999;
    if (kind === "offset") input.receiptCosting!.allocations[0].invoiceStartPiece = 1;
    if (kind === "changed_invoice") input.approvedInvoices[0].line_total_cents = 11701;
    expect(product(input).evidence).toBe("review_required");
  });
  it("rejects cumulative credits beyond a receipt even below the whole invoice limit", () => {
    const input = credited(source(), 3000);
    input.supplierCredits!.push({ ...input.supplierCredits![0], id: 2, supplier_credit_id: 2 });
    expect(resolveSupplierCreditReductions(input.approvedInvoices, input.supplierCredits, 21).issues.some(row => row.code === "CREDIT_SOURCE_EXCEEDED")).toBe(true);
    expect(product(input).evidence).toBe("review_required");
  });
  it("classifies an out-of-bounds credited interval instead of treating it as a retryable posting failure", () => {
    const input = credited(), disposition = input.supplierCredits![0].disposition as any;
    const result = evaluateSupplierCreditSource({ line: { invoiceLineId: 72, amountCents: 1,
      disposition: { ...disposition, receiptAllocation: { ...disposition.receiptAllocation, invoiceStartPiece: 99 } } },
      invoice: { ...input.approvedInvoices[0], purchase_order_line_id: 21 } });
    expect(result.costState).toBe("review_required");
    expect(result.costIssues).toContainEqual(expect.objectContaining({ code: "CREDIT_RECEIPT_SOURCE_CHANGED" }));
  });
  it("keeps received returns on their separate outgoing cost owner", () => {
    const input = source();
    input.supplierCredits = [{ id: 1, supplier_credit_id: 1, invoice_line_id: 72, amount_cents: 1000, status: "approved", source_evidence: {},
      disposition: { kind: "accepted_stock_return", supplierReturnLineId: 1, quantity: 1, component: "product", evidenceReference: "collection" } }];
    expect(product(input).totalMills).toBe(1050000);
  });
  it("conserves every mill over small partial stock intervals after multiple credits", () => {
    const segments = [{ startBasePiece: 0, pieces: 3, receivingLineId: 1, invoiceLineId: 1, sourceStartPiece: 0,
      sourceBasePieces: 3, sourceTotalMills: 5, evidence: "confirmed" as const,
      credits: [{ supplierCreditLineId: 1, amountMills: 1, pieces: 3 }, { supplierCreditLineId: 2, amountMills: 1, pieces: 3 }] }];
    expect([0, 1, 2].map(start => receiptSegmentCost(segments, start, 1).totalMills)).toEqual([1, 1, 1]);
    expect(receiptSegmentCost(segments, 0, 3).totalMills).toBe(3);
    expect(() => receiptSegmentCost([{ ...segments[0], credits: [{ supplierCreditLineId: 1, amountMills: 6, pieces: 3 }] }], 0, 3)).toThrow(/exceed/);
  });
  it("preserves explicit excluded billed amounts rather than capitalizing them", () => {
    const input = source(), evidence = input.approvedInvoices[0].cost_component_evidence as any;
    evidence.adjustments[1].destination = "excluded";
    expect(invoiceGoodsAmounts(invoiceCostComponentEvidenceSchema.parse(evidence))).toEqual({ productMills: 1050000, packagingMills: 100000, adjustmentMills: -130000 });
  });
  it("does not treat unclassified adjustment totals or missing splits as actual inventory costs", () => {
    const input = source(); delete (input.approvedInvoices[0].cost_component_evidence as any).adjustments;
    expect(product(input).evidence).toBe("review_required");
    input.approvedInvoices[0].cost_component_evidence = null;
    expect(product(input).evidence).toBe("review_required");
  });
  it("rejects duplicate adjustment identities, positive discounts and unsafe amounts", () => {
    const evidence = source().approvedInvoices[0].cost_component_evidence as any;
    expect(invoiceCostComponentEvidenceSchema.safeParse({ ...evidence, adjustments: [evidence.adjustments[0], evidence.adjustments[0]] }).success).toBe(false);
    for (const amountMills of [1, 0.1, Number.MAX_SAFE_INTEGER + 1, "-1"]) expect(invoiceCostComponentEvidenceSchema.safeParse({ ...evidence,
      adjustments: [{ ...evidence.adjustments[0], amountMills }] }).success).toBe(false);
  });
  it("keeps separate source keys for the same component on different receipts", () => {
    const first = (credited().supplierCredits![0].disposition as any), second = { ...first, receiptAllocation: { ...first.receiptAllocation, receivingLineId: 102 } };
    expect(supplierCreditLineSourceKey({ invoiceLineId: 72, amountCents: 1, disposition: first })).not.toBe(supplierCreditLineSourceKey({ invoiceLineId: 72, amountCents: 1, disposition: second }));
    expect(supplierCreditCreateInputSchema.safeParse({ sourceInvoiceId: 71, expectedSourceVersion: "a".repeat(64), supplierReference: "CREDIT-A",
      creditCalendarDate: "2026-11-03", reason: "Supplier credit", lines: [{ invoiceLineId: 72, amountCents: 1, disposition: first }, { invoiceLineId: 72, amountCents: 1, disposition: second }] }).success).toBe(true);
  });
});
