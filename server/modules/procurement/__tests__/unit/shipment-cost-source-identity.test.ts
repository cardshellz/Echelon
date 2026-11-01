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

function physicalAllocationProposal(method = "by_line_count", productCents = "90000"): ShipmentCostProposal {
  const value = proposal();
  const charge = { id: 7, actual_cents: "5000" };
  const allocationBasis = [{ costId: 7, method, source: "cost_row" }];
  const allocations = [{ shipment_cost_id: 7, inbound_shipment_line_id: 4, allocated_cents: 5000 }];
  const snapshot = { id: 4, purchase_order_id: 1, purchase_order_line_id: 2, qty_shipped: 1000,
    allocation_po_order_qty: 1000, allocation_po_product_total_cents: productCents, allocation_po_currency: "USD" };
  value.sourceEvidence = { ...(value.sourceEvidence as object), charges: [charge], allocationBasis,
    allocations, shipmentLineSnapshot: snapshot };
  value.input.sources[0].version = costFingerprint({ charge, allocationBasis, allocations, snapshot });
  return value;
}

function reviseCapturedCharge(value: ShipmentCostProposal, change: (evidence: {
  shipmentLineSnapshot: Record<string, unknown>; charges: Record<string, unknown>[];
  allocationBasis: Array<Record<string, unknown>>; allocations: Array<Record<string, unknown>>;
}) => void): void {
  const evidence = value.sourceEvidence as Parameters<typeof change>[0];
  change(evidence);
  value.input.sources[0].version = costFingerprint({ charge: evidence.charges[0], allocationBasis: evidence.allocationBasis,
    allocations: evidence.allocations.filter(row => row.shipment_cost_id === 7 && row.inbound_shipment_line_id === 4),
    snapshot: evidence.shipmentLineSnapshot });
}

describe("shipment cost source identity compatibility", () => {
  it.each(["by_line_count", "by_volume", "by_weight", "by_chargeable_weight"])(
    "does not reprice %s charges when only an unused PO product quote changes", method => {
      const previous = physicalAllocationProposal(method), current = physicalAllocationProposal(method, "120000");
      expect(retainEquivalentShipmentCostSource(current, saved(previous))).toEqual(previous);
    },
  );

  it.each(["by_value", "unknown"])("keeps PO product changes significant for %s allocation", method => {
    const current = physicalAllocationProposal(method, "120000");
    expect(retainEquivalentShipmentCostSource(current, saved(physicalAllocationProposal(method)))).toBe(current);
  });

  it.each(["allocation_po_order_qty", "allocation_po_currency"])("keeps an unused %s out of a physical allocation's cost identity", field => {
    const current = physicalAllocationProposal();
    reviseCapturedCharge(current, evidence => { evidence.shipmentLineSnapshot[field] = field.endsWith("currency") ? "CAD" : 2000; });
    expect(retainEquivalentShipmentCostSource(current, saved(physicalAllocationProposal()))).toEqual(physicalAllocationProposal());
  });

  it.each(["physical", "unknown_snapshot", "basis", "charge", "missing_method", "duplicate_basis", "unknown_charge"])(
    "keeps changed or unproved %s evidence significant", kind => {
      const method = kind === "physical" ? "by_volume" : "by_line_count";
      const current = physicalAllocationProposal(method, "120000");
      reviseCapturedCharge(current, evidence => {
        if (kind === "physical") evidence.shipmentLineSnapshot.total_volume_cbm = "2";
        if (kind === "unknown_snapshot") evidence.shipmentLineSnapshot.new_evidence = null;
        if (kind === "basis") evidence.allocationBasis[0].source = "shipment_default";
        if (kind === "charge") evidence.charges[0].actual_cents = "5001";
        if (kind === "missing_method") evidence.allocationBasis = [];
        if (kind === "duplicate_basis") evidence.allocationBasis.push({ ...evidence.allocationBasis[0] });
        if (kind === "unknown_charge") evidence.allocationBasis[0].costId = 70;
      });
      expect(retainEquivalentShipmentCostSource(current, saved(physicalAllocationProposal(method)))).toBe(current);
    },
  );

  it("requires the exact original captured charge reference before ignoring unused quote inputs", () => {
    const current = physicalAllocationProposal("by_line_count", "120000"); current.input.sources[0].version = "b".repeat(64);
    expect(retainEquivalentShipmentCostSource(current, saved(physicalAllocationProposal()))).toBe(current);
  });

  it("does not reuse a captured charge whose PO relationship disagrees with its contract", () => {
    const previous = physicalAllocationProposal(), current = physicalAllocationProposal("by_line_count", "120000");
    previous.input.scope.purchaseOrderId = 99; current.input.scope.purchaseOrderId = 99;
    expect(retainEquivalentShipmentCostSource(current, saved(previous))).toBe(current);
  });

  it("does not infer a missing original charge reference from a matching invoice", () => {
    const previous = physicalAllocationProposal(), current = physicalAllocationProposal("by_line_count", "120000");
    previous.input.sources = previous.input.sources.filter(row => row.kind !== "shipment_cost");
    current.input.sources = current.input.sources.filter(row => row.kind !== "shipment_cost");
    expect(retainEquivalentShipmentCostSource(current, saved(previous))).toBe(current);
  });

  it("retains an explicitly recorded zero charge without requiring a positive-value allocation basis", () => {
    const zero = (price: string) => {
      const value = physicalAllocationProposal("by_value", price);
      reviseCapturedCharge(value, evidence => {
        evidence.charges[0].actual_cents = "0"; evidence.allocationBasis = [];
        evidence.allocations[0].allocated_cents = 0;
      });
      (value.sourceEvidence as { invoices: unknown[] }).invoices = [];
      value.input.sources = value.input.sources.filter(row => row.kind === "shipment_cost");
      value.input.totalMills = 0;
      return value;
    };
    const previous = zero("90000");
    expect(retainEquivalentShipmentCostSource(zero("120000"), saved(previous))).toEqual(previous);
  });
  for (const before of ["approved", "partially_paid", "paid"]) {
    it.each(["approved", "partially_paid", "paid"])(`retains the original posting from ${before} through %s`, after => {
      const previous = proposal(), current = proposal(true);
      changeInvoice(previous, { status: before }); changeInvoice(current, { status: after });
      const original = saved(previous), snapshot = structuredClone({ current, original });
      const retained = retainEquivalentShipmentCostSource(current, original);
      expect(retained).toEqual(previous);
      expect(costFingerprint(retained)).toBe(original.fingerprint);
      expect({ current, original }).toEqual(snapshot);
    });
  }
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
  it.each([false, true])("does not discard unknown prototype-named shipment evidence (physical proof: %s)", physical => {
    const previous = physical ? physicalAllocationProposal() : proposal();
    const current = physical ? physicalAllocationProposal("by_line_count", "120000") : proposal(true);
    Object.defineProperty(current.sourceEvidence, "__proto__", { enumerable: true, value: { unrecognized: true } });
    expect(retainEquivalentShipmentCostSource(current, saved(previous))).toBe(current);
  });
});
