import { buildShipmentAllocationBasis, resolveShipmentAllocationMethod, shipmentAllocationBasisMatches } from "./domain/shipment-allocation-basis";
import { recordCostRevision } from "./cost-source-revision.repository";
import { sql } from "drizzle-orm";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { costFingerprint, costInteger, lockInventoryCostGraph, type CostEvidenceTransaction, type RecordedCostRevision } from "../inventory/infrastructure/cost-evidence.repository";
import { applyCostRevision, type CostComponentWriter } from "../inventory/application/apply-cost-revision";

export async function recordShipmentCostRevisions(tx: CostEvidenceTransaction, shipmentId: number, actorId: string, now: Date, options: { allocationJustFinalized?: boolean; inboundShipmentLineId?: number } = {}): Promise<{ revisions: RecordedCostRevision[]; issues: CostIssue[] }> {
  costInteger(shipmentId, "shipmentId", 1);
  await lockInventoryCostGraph(tx);
  const lines = await tx.execute(sql`
    SELECT line.id,line.purchase_order_id,line.purchase_order_line_id,line.qty_shipped,snapshot.qty,
      line.total_volume_cbm,line.total_weight_kg,line.chargeable_weight_kg,po_line.unit_cost_cents AS allocation_po_unit_cost_cents,
      shipment.allocation_method_default,
      snapshot.id AS snapshot_id,snapshot.freight_allocated_cents,snapshot.duty_allocated_cents,snapshot.insurance_allocated_cents,snapshot.other_allocated_cents
    FROM procurement.inbound_shipment_lines line
    JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
    LEFT JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
    LEFT JOIN procurement.landed_cost_snapshots snapshot ON snapshot.inbound_shipment_line_id=line.id
    WHERE line.inbound_shipment_id=${shipmentId} ORDER BY line.id
  `);
  const charges = await tx.execute(sql`
    SELECT id,cost_type,actual_cents,estimated_cents,currency,cost_status,allocation_method
    FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=${shipmentId} ORDER BY id
  `);
  const allocationRows = await tx.execute(sql`
    SELECT allocation.* FROM procurement.inbound_freight_allocations allocation
    JOIN procurement.inbound_freight_costs charge ON charge.id=allocation.shipment_cost_id
    WHERE charge.inbound_shipment_id=${shipmentId} ORDER BY allocation.id
  `);
  const previous = await tx.execute(sql`
    SELECT DISTINCT ON (revision.inbound_shipment_line_id) revision.inbound_shipment_line_id,revision.source_evidence
    FROM procurement.cost_source_revisions revision
    JOIN procurement.inbound_shipment_lines line ON line.id=revision.inbound_shipment_line_id
    WHERE line.inbound_shipment_id=${shipmentId} AND revision.component='landed'
      AND revision.contract->>'issue' IS NULL AND revision.source_evidence IS NOT NULL
    ORDER BY revision.inbound_shipment_line_id,revision.id DESC
  `);
  const validLineIds = new Set(lines.rows.map((line) => costInteger(line.id, "shipmentLineId", 1)));
  const allocationsComplete = charges.rows.every((charge) => {
    const amount = charge.actual_cents ?? charge.estimated_cents;
    if (amount === null || amount === undefined) return false;
    const allocations = allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id));
    return allocations.every((allocation) => validLineIds.has(Number(allocation.inbound_shipment_line_id)))
      && allocations.reduce((sum, allocation) => sum + BigInt(costInteger(allocation.allocated_cents, "allocationCents", -Number.MAX_SAFE_INTEGER)), BigInt(0))
        === BigInt(costInteger(amount, "chargeCents", -Number.MAX_SAFE_INTEGER));
  });
  const currentBasis: Array<{ costId: number; method: string; source: string; values: Array<{ lineId: number; basis: number }>; basisTotal: number; usedFallback: boolean }> = [];
  let basisStale = false;
  for (const charge of charges.rows) {
    if (costInteger(charge.actual_cents ?? charge.estimated_cents ?? 0, "chargeCents", -Number.MAX_SAFE_INTEGER) === 0) continue;
    try {
      const method = resolveShipmentAllocationMethod(charge.cost_type, charge.allocation_method, lines.rows[0]?.allocation_method_default ?? null);
      const basis = buildShipmentAllocationBasis(lines.rows.map((line) => ({ lineId: costInteger(line.id, "lineId", 1),
        qtyShipped: costInteger(line.qty_shipped, "qtyShipped", 1), totalVolumeCbm: line.total_volume_cbm,
        totalWeightKg: line.total_weight_kg, chargeableWeightKg: line.chargeable_weight_kg, poUnitCostCents: line.allocation_po_unit_cost_cents })), method.method);
      const allocated = allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id));
      const seen = new Set(allocated.map((allocation) => Number(allocation.inbound_shipment_line_id)));
      basisStale ||= basis.missingDimensionLineIds.length > 0 || allocated.length !== basis.values.length || seen.size !== allocated.length
        || basis.values.some((value) => {
          const saved = allocated.find((allocation) => Number(allocation.inbound_shipment_line_id) === value.lineId);
          return !saved || !shipmentAllocationBasisMatches(saved.allocation_basis_value, value.basis)
            || !shipmentAllocationBasisMatches(saved.allocation_basis_total, basis.basisTotal);
        });
      currentBasis.push({ costId: Number(charge.id), ...method, values: basis.values, basisTotal: basis.basisTotal, usedFallback: basis.usedFallback });
    } catch {
      // Invalid or unrepresentable stored basis inputs require an allocation
      // review. They must not promote the old snapshot to current authority.
      basisStale = true;
    }
  }
  const revisions: RecordedCostRevision[] = [];
  const issues: CostIssue[] = [];
  for (const line of lines.rows) {
    if (options.inboundShipmentLineId !== undefined && Number(line.id) !== options.inboundShipmentLineId) continue;
    if (line.purchase_order_id == null || line.purchase_order_line_id == null) {
      // Historical shipment lines can lack a purchase source. Finalizing their
      // physical shipment is valid, but inventing a PO link for inventory cost is not.
      issues.push({ code: "LANDED_PURCHASE_SOURCE_MISSING", message: `Shipment line ${line.id} has no complete purchase source; review its inventory cost allocation.` });
      continue;
    }
    const sources = charges.rows.map((charge) => ({ kind: "shipment_cost" as const, documentId: shipmentId,
      lineId: costInteger(charge.id, "charge.id", 1), version: costFingerprint({ charge, allocationBasis: currentBasis,
        allocations: allocationRows.rows.filter((allocation) => Number(allocation.shipment_cost_id) === Number(charge.id) && Number(allocation.inbound_shipment_line_id) === Number(line.id)), snapshot: line }) }));
    const amount = line.qty == null ? null : costInteger((["freight_allocated_cents","duty_allocated_cents","insurance_allocated_cents","other_allocated_cents"]
      .reduce((sum, field) => sum + BigInt(costInteger(line[field], field, -Number.MAX_SAFE_INTEGER)), BigInt(0)) * BigInt(100)).toString(), "allocatedMills", -Number.MAX_SAFE_INTEGER);
    const actual = charges.rows.length > 0 && charges.rows.every((charge) => charge.actual_cents !== null && charge.currency === "USD" && ["confirmed","finalized"].includes(charge.cost_status));
    const lineAllocatedMills = allocationRows.rows.filter((allocation) => Number(allocation.inbound_shipment_line_id) === Number(line.id))
      .reduce((sum, allocation) => sum + BigInt(costInteger(allocation.allocated_cents, "allocationCents", -Number.MAX_SAFE_INTEGER)) * BigInt(100), BigInt(0));
    const prior = previous.rows.find((revision) => Number(revision.inbound_shipment_line_id) === Number(line.id))?.source_evidence;
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
    const issue = amount === null ? { code: "LANDED_ALLOCATION_MISSING", message: `Shipment line ${line.id} has no saved allocation.` }
      : amount < 0 ? { code: "SIGNED_LANDED_CREDIT_REVIEW", message: "Preserved signed freight credits need an explicit supported inventory disposition." }
      : sources.length === 0 ? { code: "LANDED_SOURCE_MISSING", message: "A zero allocation without charge evidence does not establish a confirmed zero freight cost." }
      : allocationStale ? { code: "LANDED_ALLOCATION_STALE", message: "The saved allocation no longer reconciles to the current charge, allocation basis, method or shipment quantity. Finalize allocation again before applying it." } : null;
    revisions.push(await recordCostRevision(tx, {
      contractVersion: 1, component: "landed",
      scope: { kind: "shipment_line", purchaseOrderId: costInteger(line.purchase_order_id, "purchaseOrderId", 1), purchaseOrderLineId: costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1), inboundShipmentId: shipmentId, inboundShipmentLineId: costInteger(line.id, "shipmentLineId", 1) },
      sources: sources.length > 0 ? sources : [{ kind: "purchase_order_line", documentId: Number(line.purchase_order_id), lineId: Number(line.purchase_order_line_id), version: costFingerprint(line) }],
      currency: charges.rows.length > 0 && charges.rows.every((charge) => charge.currency === "USD") ? "USD" : null,
      totalMills: amount === null ? null : costInteger(amount, "totalMills", -Number.MAX_SAFE_INTEGER), basePieces: line.qty == null ? null : costInteger(line.qty, "snapshot.qty", 1),
      evidence: issue ? "review_required" : actual ? "confirmed" : "estimated", packagingTreatment: "not_applicable", issue, manualOverride: null,
    }, actorId, now, { shipmentLineSnapshot: line, allocationBasis: currentBasis, charges: charges.rows, allocations: allocationRows.rows.filter((allocation) => Number(allocation.inbound_shipment_line_id) === Number(line.id)) }));
  }
  return { revisions, issues };
}

export async function applyShipmentCostRevisions(tx: CostEvidenceTransaction, shipmentId: number, writer: CostComponentWriter, actorId: string, now: Date) {
  const { revisions, issues } = await recordShipmentCostRevisions(tx, shipmentId, actorId, now);
  const applications = [];
  for (const revision of revisions) applications.push(await applyCostRevision(tx, revision, writer, actorId, now));
  return {
    updated: applications.filter((application) => application.status === "applied" && !application.replayed).reduce((sum, application) => sum + application.lotsUpdated, 0),
    total: applications.reduce((sum, application) => sum + application.lotsUpdated, 0),
    status: issues.length > 0 || applications.some((application) => application.status === "review_required") ? "review_required" as const : "applied" as const,
    skipped: [...issues.map((issue) => ({ applicationId: null, reason: issue.code, message: issue.message })),
      ...applications.flatMap((application) => application.issues.map((issue) => ({ applicationId: application.applicationId, reason: issue.code, message: issue.message })))],
    costApplications: applications,
  };
}
