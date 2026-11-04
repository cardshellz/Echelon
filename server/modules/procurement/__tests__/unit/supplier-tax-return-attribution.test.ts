import { describe, expect, it } from "vitest";
import { evaluateSupplierCreditSource, resolveSupplierCreditReductions, supplierCreditDispositionMatches } from "../../domain/supplier-credit-source";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { supplierInvoiceAmounts } from "../../domain/supplier-invoice-amounts";
import { validateQuarantineInvoiceCreditIntervals } from "../../domain/quarantine-invoice-credit";
import { shipmentHeaderExclusions } from "../../domain/shipment-header-exclusions";
import { receiptSegmentCost } from "@shared/procurement/receipt-cost-segments";
import type { SourceLineInput } from "@shared/procurement/supplier-credit";
import type { ReceiptInvoiceSource } from "../../domain/receipt-invoice-costs";

const invoice = () => ({ id: 72, vendor_invoice_id: 71, purchase_order_line_id: 21, qty_invoiced: 100, line_total_cents: 11000, currency: "USD",
  cost_component_evidence: { contractVersion: 1, source: "operator_review", packagingTreatment: "combined", productMills: 1000000, packagingMills: 0, adjustmentMills: 100000 },
  tax_cost_evidence: [{ taxTypeId: 1, treatment: "inventory", amountMills: 100000, source: "invoice_line:72" }] });
const assignment = { receivingLineId: 101, receiptStartPiece: 0, invoiceStartPiece: 0, pieces: 90 };
const returnSource = { dispositionId: 1, observationId: 2, receivingLineId: 101, purchaseOrderLineId: 21, productId: 100,
  productVariantId: 201, unitsPerVariant: 1, observationQuantity: 10, evidenceReference: "Supplier collection" };
function credit(disposition: SourceLineInput["disposition"], amountCents: number, source = invoice(), id = 1) {
  const evaluated = evaluateSupplierCreditSource({ invoice: source, line: { invoiceLineId: 72, amountCents, disposition }, returnSource: disposition.kind === "quarantine_return" || disposition.kind === "tax_reduction" && disposition.quarantineAllocation ? returnSource : undefined });
  return { id, supplier_credit_id: id, invoice_line_id: 72, amount_cents: amountCents, disposition, source_evidence: evaluated.sourceEvidence, status: "approved" };
}
const refund = { kind: "tax_reduction", taxSourceKey: "invoice_line:72:1", taxTypeId: 1 } as const;
describe("supplier tax and returned invoice ownership", () => {
  it("selects combined goods and known tax separately without manufacturing packaging", () => {
    expect(supplierInvoiceAmounts(invoice())).toMatchObject({ productMills: 1000000, packagingMills: 0, packagingTreatment: "combined", inventoryTaxMills: 100000 });
    expect(evaluateSupplierCreditSource({ invoice: invoice(), line: { invoiceLineId: 72, amountCents: 100, disposition: { kind: "price_reduction", component: "product" } } }).costIssues).toEqual([]);
    expect(evaluateSupplierCreditSource({ invoice: invoice(), line: { invoiceLineId: 72, amountCents: 1, disposition: { kind: "price_reduction", component: "packaging" } } }).costIssues[0].code).toBe("CREDIT_COMPONENT_EXCEEDED");
  });
  it("caps refunds at the exact original tax and each assigned receipt", () => {
    expect(() => credit(refund, 1001)).toThrow(/exceeds/);
    expect(() => credit({ ...refund, receiptAllocation: assignment }, 901)).toThrow(/exceeds/);
    const credits = [credit(refund, 600), credit(refund, 600, invoice(), 2)];
    expect(resolveSupplierCreditReductions([invoice()], credits, 21).issues.map(issue => issue.code)).toContain("CREDIT_TAX_EXCEEDED");
  });
  it("follows an approved tax-type change without changing the original refund or inventing an expense", () => {
    const source = invoice(), saved = credit(refund, 100), frozen = structuredClone(saved);
    expect(resolveSupplierCreditReductions([source], [saved], 21).taxInventoryMills).toBe(BigInt(10000));
    source.tax_cost_evidence[0].treatment = "recoverable";
    expect(resolveSupplierCreditReductions([source], [saved], 21)).toMatchObject({ issues: [], taxInventoryMills: BigInt(0) });
    expect(saved).toEqual(frozen);
    saved.status = "voided";
    expect(resolveSupplierCreditReductions([invoice()], [saved], 21).taxInventoryMills).toBe(BigInt(0));
  });
  it("rejects a changed tax amount, source identity or disposition", () => {
    const saved = credit(refund, 100), source = invoice(); source.tax_cost_evidence[0].amountMills++;
    expect(resolveSupplierCreditReductions([source], [saved], 21).issues[0].code).toBe("CREDIT_TAX_SOURCE_CHANGED");
    expect(supplierCreditDispositionMatches({ ...saved, disposition: { ...refund, taxTypeId: 2 } }, saved.source_evidence)).toBe(false);
  });
  it("keeps accepted receipt prices when goods and their tax are returned before acceptance", () => {
    const goods = credit({ kind: "quarantine_return", returnDispositionId: 1, quantity: 10, evidenceReference: "Supplier collection", invoiceStartPiece: 90 }, 1000);
    const tax = credit({ ...refund, quarantineAllocation: { returnDispositionId: 1, quantity: 10, evidenceReference: "Supplier collection", invoiceStartPiece: 90 } }, 100, invoice(), 2);
    const source: ReceiptInvoiceSource = { purchaseOrderLine: { id: 21, purchase_order_id: 10, line_type: "product", currency: "USD", order_qty: 100,
      received_qty: 90, status: "receiving", total_product_cost_cents: 10000, packaging_cost_cents: 0, tax_cents: 0, discount_cents: 0 },
      approvedInvoices: [invoice()], supplierCredits: [goods, tax], receiptCosting: { receipts: [{ receivingLineId: 101, receiptId: 1, receiptNumber: "RCV-A", startBasePiece: 0, pieces: 90 }], allocations: [{ ...assignment, invoiceLineId: 72 }] } };
    const selected = resolvePurchaseCostSource(source).find(row => row.component === "product")!;
    expect(selected.issue).toBeNull();
    expect(receiptSegmentCost(selected.receiptCostSegments!, 0, 90, 101).totalMills).toBe(990000);
    expect(receiptSegmentCost(selected.receiptCostSegments!, 90, 10).provisionalPieces).toBe(10);
    expect(() => validateQuarantineInvoiceCreditIntervals(100, [assignment], [{ ...goods.source_evidence, returnInvoiceStartPiece: 80 }])).toThrow(/outside/);
  });
  it("allocates partial shipment exclusions with exact stable cents", () => {
    const rows = [{ id: 1, freight_cost_id: 3, status: "approved", header_cost_evidence: [
      { key: "vat", lineId: 1, destination: "tax", amountMills: 10000, taxTypeId: 1, taxTreatment: "recoverable" },
      { key: "other", lineId: 1, destination: "excluded", amountMills: -100, taxTypeId: null, taxTreatment: null }] }];
    const allocations = [{ shipment_cost_id: 3, inbound_shipment_line_id: 10, allocated_cents: 100 }, { shipment_cost_id: 3, inbound_shipment_line_id: 11, allocated_cents: 200 }];
    const result = shipmentHeaderExclusions(rows, allocations);
    expect([...result.taxByLine]).toEqual([[10, 33], [11, 67]]);
    expect([...result.otherByLine]).toEqual([[10, 0], [11, -1]]);
  });
});
