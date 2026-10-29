import { buildShipmentAllocationBasis, resolveShipmentAllocationMethod, shipmentAllocationBasisMatches,
  allocateShipmentCents, shipmentAllocationEvidenceMatches, type ShipmentAllocationBasis } from "./domain/shipment-allocation-basis";
import type { CostIssue, CostSourceReference } from "@shared/procurement/cost-source-contracts";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { resolveShipmentChargeEvidence } from "./domain/shipment-charge-evidence";
import { retainEquivalentShipmentCostSource, type ShipmentCostProposal } from "./shipment-cost-source-identity";
import type { SupplierCreditSourceRow } from "./supplier-credit-source.repository";
import { resolveShipmentSupplierCredits } from "./domain/shipment-supplier-credits";
import type { ShipmentPhysicalSource } from "@shared/procurement/shipment-physical-values";

type ReadRows = Awaited<ReturnType<CostEvidenceTransaction["execute"]>>["rows"];
export type ShipmentRevisionOptions = { allocationJustFinalized?: boolean; inboundShipmentLineId?: number };
export interface ShipmentCostRevisionReadEvidence {
  lines: ReadRows;
  charges: ReadRows;
  invoiceRows: ReadRows;
  allocationRows: ReadRows;
  previous: ReadRows;
  supplierCredits: SupplierCreditSourceRow[];
  /** Present on live repository reads; separate from immutable source rows. */
  physicalSourcesByLineId?: ReadonlyMap<number, ShipmentPhysicalSource>;
}

/** Pure preparation shared by posting and batched freshness reads. Row objects,
 * ordering and scalar representations remain the immutable fingerprint inputs. */
export function buildShipmentCostRevisionProposals(shipmentId: number, evidence: ShipmentCostRevisionReadEvidence,
  options: ShipmentRevisionOptions = {}): { proposals: ShipmentCostProposal[]; issues: CostIssue[] } {
  const lines = { rows: evidence.lines }, charges = { rows: evidence.charges }, invoiceRows = { rows: evidence.invoiceRows };
  const allocationRows = { rows: evidence.allocationRows }, previous = { rows: evidence.previous };
  const supplierCredits = evidence.supplierCredits;
  const invoiceEvidence = invoiceRows.rows.map((line) => ({
    id: line.id, invoiceId: line.vendor_invoice_id, freightCostId: line.freight_cost_id,
    purchaseOrderLineId: line.purchase_order_line_id, productVariantId: line.product_variant_id,
    vendorId: line.vendor_id, shipmentId: line.inbound_shipment_id, currency: line.currency, status: line.status,
    invoiceNumber: line.invoice_number ?? null, replacesInvoiceId: line.replaces_invoice_id ?? null,
    invoiceTotalCents: line.invoiced_amount_cents, documentLinesTotalCents: line.document_lines_total_cents,
    quantity: line.qty_invoiced, unitCostMills: line.unit_cost_mills, unitCostCents: line.unit_cost_cents,
    lineTotalCents: line.line_total_cents,
  }));
  const chargeEvidence = (charge: Record<string, unknown>) => ({
    id: charge.id, shipmentId, vendorId: charge.vendor_id ?? null, invoiceId: charge.vendor_invoice_id ?? null,
    costType: charge.cost_type, allocationMethod: charge.allocation_method, currency: charge.currency,
    actualCents: charge.actual_cents, estimatedCents: charge.estimated_cents, status: charge.cost_status,
  });
  const creditAdjustment = resolveShipmentSupplierCredits({ charges: charges.rows, allocations: allocationRows.rows,
    invoices: invoiceRows.rows, credits: supplierCredits });
  const validLineIds = new Set(lines.rows.map((line) => costInteger(line.id, "shipmentLineId", 1)));
  const allocationsComplete = charges.rows.every((charge) => {
    const amount = charge.actual_cents ?? charge.estimated_cents;
    if (amount === null || amount === undefined) return false;
    const allocations = allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id));
    return allocations.every((allocation) => validLineIds.has(Number(allocation.inbound_shipment_line_id)))
      && allocations.reduce((sum, allocation) => sum + BigInt(costInteger(allocation.allocated_cents, "allocationCents", -Number.MAX_SAFE_INTEGER)), BigInt(0))
        === BigInt(costInteger(amount, "chargeCents", -Number.MAX_SAFE_INTEGER));
  });
  const currentBasis: Array<{ costId: number; source: string } & ShipmentAllocationBasis> = [];
  let basisStale = false;
  for (const charge of charges.rows) {
    if (costInteger(charge.actual_cents ?? charge.estimated_cents ?? 0, "chargeCents", -Number.MAX_SAFE_INTEGER) === 0) continue;
    try {
      const method = resolveShipmentAllocationMethod(charge.cost_type, charge.allocation_method, lines.rows[0]?.allocation_method_default ?? null);
      if (method.method === "by_value" && lines.rows.some((line) => line.allocation_po_line_type !== "product"
        || Number(line.allocation_po_id) !== Number(line.purchase_order_id))) {
        throw new Error("Shipment product value requires the original product PO source");
      }
      const basis = buildShipmentAllocationBasis(lines.rows.map((line) => ({ lineId: costInteger(line.id, "lineId", 1),
        physicalSource: evidence.physicalSourcesByLineId?.get(costInteger(line.id, "lineId", 1)),
        qtyShipped: costInteger(line.qty_shipped, "qtyShipped", 1), totalVolumeCbm: line.total_volume_cbm,
        totalWeightKg: line.total_weight_kg, chargeableWeightKg: line.chargeable_weight_kg,
        poLineId: line.allocation_po_line_id, poOrderQty: line.allocation_po_order_qty,
        poTotalProductCostCents: line.allocation_po_product_total_cents, poCurrency: line.allocation_po_currency })), method.method);
      const allocated = allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id));
      const expectedCents = new Map(allocateShipmentCents(costInteger(charge.actual_cents ?? charge.estimated_cents, "chargeCents"), basis)
        .map((allocation) => [allocation.lineId, allocation.allocatedCents]));
      const seen = new Set(allocated.map((allocation) => Number(allocation.inbound_shipment_line_id)));
      basisStale ||= basis.missingDimensionLineIds.length > 0 || allocated.length !== basis.values.length || seen.size !== allocated.length
        || basis.values.some((value) => {
          const saved = allocated.find((allocation) => Number(allocation.inbound_shipment_line_id) === value.lineId);
          if (method.method === "by_value" || saved?.basis_evidence != null) {
            return !saved || !shipmentAllocationEvidenceMatches(saved.basis_evidence, basis, value.lineId)
              || costInteger(saved.allocated_cents, "allocationCents") !== expectedCents.get(value.lineId);
          }
          return !saved || !shipmentAllocationBasisMatches(saved.allocation_basis_value, value.basis)
            || !shipmentAllocationBasisMatches(saved.allocation_basis_total, basis.basisTotal);
        });
      currentBasis.push({ costId: Number(charge.id), source: method.source, ...basis });
    } catch {
      // Invalid or unrepresentable stored basis inputs require an allocation
      // review. They must not promote the old snapshot to current authority.
      basisStale = true;
    }
  }
  const proposals: ShipmentCostProposal[] = [];
  const issues: CostIssue[] = [];
  for (const line of lines.rows) {
    if (options.inboundShipmentLineId !== undefined && Number(line.id) !== options.inboundShipmentLineId) continue;
    if (line.purchase_order_id == null || line.purchase_order_line_id == null) {
      // Historical shipment lines can lack a purchase source. Finalizing their
      // physical shipment is valid, but inventing a PO link for inventory cost is not.
      issues.push({ code: "LANDED_PURCHASE_SOURCE_MISSING", message: `Shipment line ${line.id} has no complete purchase source; review its inventory cost allocation.` });
      continue;
    }
    const saved = previous.rows.find((revision) => Number(revision.inbound_shipment_line_id) === Number(line.id));
    const prior = saved?.confirmed_source_evidence;
    const chargeAuthorities = charges.rows.map((charge) => {
      const saved = prior?.chargeAuthorities?.find((authority: { chargeId: number }) => authority.chargeId === Number(charge.id));
      const previousCharge = prior?.charges?.find((entry: { id: number }) => Number(entry.id) === Number(charge.id));
      return { chargeId: Number(charge.id), ...resolveShipmentChargeEvidence({ charge: chargeEvidence(charge), invoices: invoiceEvidence,
        priorConfirmedCharge: saved?.confirmedCharge ?? (previousCharge ? chargeEvidence(previousCharge) : null) }) };
    });
    const sources: CostSourceReference[] = charges.rows.map((charge) => ({ kind: "shipment_cost", documentId: shipmentId,
      lineId: costInteger(charge.id, "charge.id", 1), version: costFingerprint({ charge, allocationBasis: currentBasis,
        allocations: allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id) && Number(allocation.inbound_shipment_line_id) === Number(line.id)), snapshot: line }) }));
    const approvedInvoiceLineIds = new Set(chargeAuthorities.flatMap((authority) => authority.approvedInvoiceLineIds));
    for (const invoiceLine of invoiceRows.rows) {
      if (approvedInvoiceLineIds.has(Number(invoiceLine.id))) sources.push({ kind: "vendor_invoice_line",
        documentId: costInteger(invoiceLine.vendor_invoice_id, "invoiceId", 1), lineId: costInteger(invoiceLine.id, "invoiceLineId", 1),
        version: costFingerprint(invoiceLine) });
    }
    sources.push(...creditAdjustment.sources);
    const amount = line.qty == null ? null : costInteger((["freight_allocated_cents","duty_allocated_cents","insurance_allocated_cents","other_allocated_cents"]
      .reduce((sum, field) => sum + BigInt(costInteger(line[field], field, -Number.MAX_SAFE_INTEGER)), BigInt(0)) * BigInt(100)).toString(), "allocatedMills", -Number.MAX_SAFE_INTEGER);
    const actual = chargeAuthorities.length > 0 && chargeAuthorities.every((authority) => authority.evidence === "confirmed");
    const lineAllocatedMills = allocationRows.rows.filter((allocation) => Number(allocation.inbound_shipment_line_id) === Number(line.id))
      .reduce((sum, allocation) => sum + BigInt(costInteger(allocation.allocated_cents, "allocationCents", -Number.MAX_SAFE_INTEGER)) * BigInt(100), BigInt(0));
    const sameSnapshot = prior?.shipmentLineSnapshot?.snapshot_id != null && Number(prior.shipmentLineSnapshot.snapshot_id) === Number(line.snapshot_id);
    const allocationPolicyChanged = sameSnapshot && Array.isArray(prior.charges) && charges.rows.some((charge) => {
      const oldCharge = prior.charges.find((old: any) => Number(old.id) === Number(charge.id));
      return oldCharge && (oldCharge.allocation_method !== charge.allocation_method || oldCharge.cost_type !== charge.cost_type);
    });
    const effectiveMethodChanged = sameSnapshot && (!Array.isArray(prior?.allocationBasis) || currentBasis.some((basis) => {
      const old = prior.allocationBasis.find((entry: any) => Number(entry.costId) === basis.costId);
      return !old || old.method !== basis.method || old.source !== basis.source;
    }));
    const allocationStale = basisStale || !allocationsComplete || (amount !== null && lineAllocatedMills !== BigInt(amount))
      || (line.qty != null && Number(line.qty) !== Number(line.qty_shipped)) || ((allocationPolicyChanged || effectiveMethodChanged) && !options.allocationJustFinalized);
    const netAmount = amount === null ? null : costInteger((BigInt(amount) - BigInt(creditAdjustment.creditedCentsByLine.get(Number(line.id)) ?? 0) * BigInt(100)).toString(), "netAllocatedMills", -Number.MAX_SAFE_INTEGER);
    const issue = amount === null ? { code: "LANDED_ALLOCATION_MISSING", message: `Shipment line ${line.id} has no saved allocation.` }
      : amount < 0 ? { code: "SIGNED_LANDED_CREDIT_REVIEW", message: "Preserved signed freight credits need an explicit supported inventory disposition." }
      : sources.length === 0 ? { code: "LANDED_SOURCE_MISSING", message: "A zero allocation without charge evidence does not establish a confirmed zero freight cost." }
      : allocationStale ? { code: "LANDED_ALLOCATION_STALE", message: "The saved allocation no longer reconciles to the current charge, allocation basis, method or shipment quantity. Finalize allocation again before applying it." }
      : creditAdjustment.issues[0] ?? (netAmount !== null && netAmount < 0 ? { code: "CREDIT_LANDED_ALLOCATION_REVIEW", message: "Supplier credits exceed the original allocated shipment cost." } : null)
        ?? chargeAuthorities.find((authority) => authority.issue !== null)?.issue ?? null;
    proposals.push(retainEquivalentShipmentCostSource({ input: {
      contractVersion: 1, component: "landed",
      scope: { kind: "shipment_line", purchaseOrderId: costInteger(line.purchase_order_id, "purchaseOrderId", 1), purchaseOrderLineId: costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1), inboundShipmentId: shipmentId, inboundShipmentLineId: costInteger(line.id, "shipmentLineId", 1) },
      sources: sources.length > 0 ? sources : [{ kind: "purchase_order_line", documentId: Number(line.purchase_order_id), lineId: Number(line.purchase_order_line_id), version: costFingerprint(line) }],
      currency: charges.rows.length > 0 && charges.rows.every((charge) => charge.currency === "USD") ? "USD" : null,
      totalMills: netAmount, basePieces: line.qty == null ? null : costInteger(line.qty, "snapshot.qty", 1),
      evidence: issue ? "review_required" : actual ? "confirmed" : "estimated", packagingTreatment: "not_applicable", issue, manualOverride: null,
    }, sourceEvidence: { shipmentLineSnapshot: line, allocationBasis: currentBasis, charges: charges.rows, chargeAuthorities,
      invoices: invoiceRows.rows, allocations: allocationRows.rows.filter((allocation) => Number(allocation.inbound_shipment_line_id) === Number(line.id)),
      ...(supplierCredits.length ? { supplierCredits, creditedCents: creditAdjustment.creditedCentsByLine.get(Number(line.id)) ?? 0 } : {}) } }, saved));
  }
  return { proposals, issues };
}
