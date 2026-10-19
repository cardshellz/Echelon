import { describe, expect, it } from "vitest";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";
import { retainEquivalentShipmentCostSource, type ShipmentCostProposal } from "../../shipment-cost-source-identity";

function proposal(withNullLinks = false): ShipmentCostProposal {
  const invoice = { id: 8, vendor_invoice_id: 9, freight_cost_id: 7, line_total_cents: 5000,
    qty_invoiced: 1, status: "paid", ...(withNullLinks ? { purchase_order_line_id: null, product_variant_id: null } : {}) };
  return {
    input: { contractVersion: 1, component: "landed",
      scope: { kind: "shipment_line", purchaseOrderId: 1, purchaseOrderLineId: 2, inboundShipmentId: 3, inboundShipmentLineId: 4 },
      sources: [{ kind: "shipment_cost", documentId: 3, lineId: 7, version: "a".repeat(64) },
        { kind: "vendor_invoice_line", documentId: 9, lineId: 8, version: costFingerprint(invoice) }],
      currency: "USD", totalMills: 500000, basePieces: 1000, evidence: "confirmed", packagingTreatment: "not_applicable", issue: null, manualOverride: null },
    sourceEvidence: { invoices: [invoice], charges: [{ id: 7, actual_cents: 5000 }], allocations: [{ allocated_cents: 5000 }] },
  };
}
function saved(value: ShipmentCostProposal) {
  const fingerprint = costFingerprint(value);
  return { contract: { ...value.input, revision: 7, fingerprint }, fingerprint, source_evidence: value.sourceEvidence };
}
function changeInvoice(value: ShipmentCostProposal, patch: Record<string, unknown>) {
  const evidence = value.sourceEvidence as { invoices: Record<string, unknown>[] };
  evidence.invoices[0] = { ...evidence.invoices[0], ...patch };
  value.input.sources[1].version = costFingerprint(evidence.invoices[0]);
}

describe("shipment cost source identity compatibility", () => {
  it.each([false, true])("retains the original approval identity across absent/null product links (saved nulls: %s)", nulls => {
    const previous = proposal(nulls), current = proposal(!nulls), original = saved(previous);
    const before = structuredClone({ previous, current, original });
    const retained = retainEquivalentShipmentCostSource(current, original);
    expect(retained).toEqual(previous);
    expect(costFingerprint(retained)).toBe(original.fingerprint);
    expect({ previous, current, original }).toEqual(before);
  });

  it.each([
    { purchase_order_line_id: 2 }, { product_variant_id: 20 }, { line_total_cents: 5001 },
    { qty_invoiced: 2 }, { status: "voided" }, { vendor_id: 6 }, { currency: "CAD" },
    { replaces_invoice_id: 10 }, { freight_cost_id: 11 }, { new_evidence: null },
  ])("does not reuse an approval when invoice evidence changes: %j", change => {
    const current = proposal(true); changeInvoice(current, change);
    expect(retainEquivalentShipmentCostSource(current, saved(proposal()))).toBe(current);
  });

  it.each([
    (value: ShipmentCostProposal) => { value.input.totalMills = 500001; },
    (value: ShipmentCostProposal) => { value.input.basePieces = 1001; },
    (value: ShipmentCostProposal) => { value.input.scope.purchaseOrderLineId = 5; },
    (value: ShipmentCostProposal) => { value.input.evidence = "review_required"; value.input.issue = { code: "LANDED_INVOICE_SOURCE_MISMATCH", message: "Supplier source changed" }; },
    (value: ShipmentCostProposal) => { value.input.sources[0].version = "b".repeat(64); },
    (value: ShipmentCostProposal) => { (value.sourceEvidence as { allocations: unknown[] }).allocations = [{ allocated_cents: 5001 }]; },
  ])("keeps changed amounts, scope, allocation and authority current", change => {
    const current = proposal(true); change(current);
    expect(retainEquivalentShipmentCostSource(current, saved(proposal()))).toBe(current);
  });

  it("requires the invoice reference to hash its exact captured row", () => {
    const current = proposal(true); current.input.sources[1].version = "b".repeat(64);
    expect(retainEquivalentShipmentCostSource(current, saved(proposal()))).toBe(current);
  });
  it.each(["fingerprint", "contract", "evidence"])("rejects damaged saved %s", field => {
    const current = proposal(true), original = saved(proposal());
    if (field === "fingerprint") original.fingerprint = "b".repeat(64);
    else if (field === "contract") original.contract.totalMills = 1;
    else original.source_evidence = { invoices: [] };
    expect(retainEquivalentShipmentCostSource(current, original)).toBe(current);
  });
  it("does not accept missing or duplicate invoice evidence", () => {
    for (const invoices of [[], [{ id: 8 }], [{ id: 8, vendor_invoice_id: 9 }, { id: 8, vendor_invoice_id: 9 }]]) {
      const current = proposal(true); current.sourceEvidence = { invoices };
      expect(retainEquivalentShipmentCostSource(current, saved(proposal()))).toBe(current);
    }
  });
  it("keeps a new proposal when no saved source exists", () => {
    const current = proposal();
    expect(retainEquivalentShipmentCostSource(current, undefined)).toBe(current);
  });
});
