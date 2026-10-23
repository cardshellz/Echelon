import { describe, expect, it } from "vitest";
import { projectDocumentRelationshipCosts } from "../../domain/document-relationship-costs";
import { evaluateSupplierCreditSource } from "../../domain/supplier-credit-source";

describe("relationship cost shares use the financial credit owner", () => {
  it("applies an approved one-cent credit exactly once and leaves the saved charge intact", () => {
    const invoice = { id: 72, vendor_invoice_id: 71, purchase_order_line_id: null, freight_cost_id: 401,
      currency: "USD", qty_invoiced: 1, line_total_cents: 10001, cost_component_evidence: null };
    const line = { invoiceLineId: 72, amountCents: 1, disposition: { kind: "price_reduction" as const, component: "landed" as const } };
    const evidence = { charges: [{ id: 401, inbound_shipment_id: 42, currency: "USD", actual_cents: "10001" }],
      allocations: [{ shipment_cost_id: 401, inbound_shipment_line_id: 201, allocated_cents: "6001" }, { shipment_cost_id: 401, inbound_shipment_line_id: 202, allocated_cents: "4000" }],
      invoices: [invoice], credits: [{ id: 1, supplier_credit_id: 9, invoice_line_id: 72, amount_cents: 1, disposition: line.disposition,
        status: "approved", source_evidence: evaluateSupplierCreditSource({ line, invoice }).sourceEvidence }] };
    const before = structuredClone(evidence);
    const result = projectDocumentRelationshipCosts(evidence);
    expect(result.charges[0].cents).toBe(10000);
    expect(result.allocations.map(row => row.cents)).toEqual([6000, 4000]);
    expect(result.costIssues).toEqual([]); expect(evidence).toEqual(before);
  });
  it("keeps missing amounts distinct from zero and signed saved adjustments", () => {
    const result = projectDocumentRelationshipCosts({ charges: [
      { id: 1, inbound_shipment_id: 42, currency: "USD", actual_cents: 0, estimated_cents: 100 },
      { id: 2, inbound_shipment_id: 42, currency: "USD", actual_cents: -5 },
      { id: 3, inbound_shipment_id: 42, currency: null },
    ], allocations: [], invoices: [], credits: [] });
    expect(result.charges.map(row => row.cents)).toEqual([0, -5, null]);
  });
});
