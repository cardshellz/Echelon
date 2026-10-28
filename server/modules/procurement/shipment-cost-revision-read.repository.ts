import { sql } from "drizzle-orm";
import { costInteger, CostEvidenceError, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import type { ShipmentCostRevisionReadEvidence } from "./shipment-cost-revision-proposals";
import { readShipmentSupplierCreditCostRows } from "./supplier-credit-source.repository";
import { shipmentCostReadPageSchema } from "./shipment-cost-read-scope";
export { shipmentCostReadBatches } from "./shipment-cost-read-scope";

type ReadRows = Awaited<ReturnType<CostEvidenceTransaction["execute"]>>["rows"];

/** The routing column never enters immutable economic evidence/fingerprints. */
function partition(rows: ReadRows, ids: readonly number[]): Map<number, ReadRows> {
  const result = new Map(ids.map(id => [id, [] as ReadRows]));
  for (const row of rows) {
    const { __shipment_id: routing, ...evidence } = row;
    const shipmentId = costInteger(routing, "shipmentCostRead.shipmentId", 1);
    const scoped = result.get(shipmentId);
    if (!scoped) throw new CostEvidenceError("SHIPMENT_COST_READ_EVIDENCE_INCOMPLETE",
      "Current shipment cost evidence contains an unexpected shipment.", { shipmentId });
    scoped.push(evidence);
  }
  return result;
}

/** A shared invoice is fetched once and routed to every linked shipment.
 * Each array keeps the original document order and native scalar values. */
function partitionInvoices(rows: ReadRows, ids: readonly number[]): Map<number, ReadRows> {
  const result = new Map(ids.map(id => [id, [] as ReadRows]));
  for (const row of rows) {
    const { __shipment_ids: routing, ...evidence } = row;
    if (!Array.isArray(routing) || routing.length === 0 || routing.length > ids.length) {
      throw new CostEvidenceError("SHIPMENT_COST_READ_EVIDENCE_INCOMPLETE", "Current invoice evidence has invalid shipment identities.");
    }
    const routed = new Set<number>();
    for (const value of routing) {
      const id = costInteger(value, "shipmentCostRead.shipmentId", 1);
      const scoped = result.get(id);
      if (!scoped || routed.has(id)) throw new CostEvidenceError("SHIPMENT_COST_READ_EVIDENCE_INCOMPLETE", "Current invoice evidence escaped its shipment scope.");
      routed.add(id);
      scoped.push(evidence);
    }
  }
  return result;
}

/** Complete evidence for one bounded header page in the caller's snapshot.
 * No source rows, scalar types or per-shipment ledger limits change. */
export async function readShipmentCostRevisionEvidence(tx: CostEvidenceTransaction, shipmentIds: readonly number[]): Promise<Map<number, ShipmentCostRevisionReadEvidence>> {
  const ids = [...new Set(shipmentCostReadPageSchema.parse(shipmentIds))];
  if (!ids.length) return new Map();
  const lines = partition((await tx.execute(sql`
    SELECT line.inbound_shipment_id AS __shipment_id,line.id,line.purchase_order_id,line.purchase_order_line_id,line.qty_shipped,snapshot.qty,
      line.total_volume_cbm,line.total_weight_kg,line.chargeable_weight_kg,
      po_line.id AS allocation_po_line_id,po_line.purchase_order_id AS allocation_po_id,po_line.line_type AS allocation_po_line_type,
      po_line.order_qty AS allocation_po_order_qty,po_line.total_product_cost_cents AS allocation_po_product_total_cents,
      po.currency AS allocation_po_currency,
      shipment.allocation_method_default,
      snapshot.id AS snapshot_id,snapshot.product_value_evidence AS snapshot_product_value_evidence,
      snapshot.freight_allocated_cents,snapshot.duty_allocated_cents,snapshot.insurance_allocated_cents,snapshot.other_allocated_cents
    FROM procurement.inbound_shipment_lines line
    JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
    LEFT JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
    LEFT JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    LEFT JOIN procurement.landed_cost_snapshots snapshot ON snapshot.inbound_shipment_line_id=line.id
    WHERE line.inbound_shipment_id=ANY(${sql.param(ids)}::int[]) ORDER BY line.id
  `)).rows, ids);
  const charges = partition((await tx.execute(sql`
    SELECT inbound_shipment_id AS __shipment_id,id,cost_type,actual_cents,estimated_cents,currency,cost_status,allocation_method,vendor_id,vendor_invoice_id
    FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=ANY(${sql.param(ids)}::int[]) ORDER BY id
  `)).rows, ids);
  const invoiceRows = partitionInvoices((await tx.execute(sql`
    WITH linked_invoices AS (
      SELECT inbound_shipment_id AS shipment_id,vendor_invoice_id AS id FROM procurement.inbound_freight_costs
      WHERE inbound_shipment_id=ANY(${sql.param(ids)}::int[]) AND vendor_invoice_id IS NOT NULL
      UNION
      SELECT charge.inbound_shipment_id AS shipment_id,invoice_line.vendor_invoice_id FROM procurement.vendor_invoice_lines invoice_line
      JOIN procurement.inbound_freight_costs charge ON charge.id=invoice_line.freight_cost_id
      WHERE charge.inbound_shipment_id=ANY(${sql.param(ids)}::int[])
    ), selected_invoices AS (
      SELECT id,array_agg(shipment_id ORDER BY shipment_id) AS shipment_ids FROM linked_invoices GROUP BY id
    )
    SELECT selected.shipment_ids AS __shipment_ids,invoice_line.id,invoice.id AS vendor_invoice_id,invoice_line.freight_cost_id,invoice_line.purchase_order_line_id,invoice_line.product_variant_id,
      invoice_line.qty_invoiced,invoice_line.unit_cost_mills,invoice_line.unit_cost_cents,invoice_line.line_total_cents,
      invoice.vendor_id,invoice.inbound_shipment_id,invoice.currency,invoice.status,invoice.invoiced_amount_cents,
      invoice.invoice_number,invoice.replaces_invoice_id,
      SUM(invoice_line.line_total_cents) OVER (PARTITION BY invoice.id)::text AS document_lines_total_cents
    FROM selected_invoices selected JOIN procurement.vendor_invoices invoice ON invoice.id=selected.id
    LEFT JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.vendor_invoice_id=invoice.id
    ORDER BY invoice.id,invoice_line.id
  `)).rows, ids);
  const allocationRows = partition((await tx.execute(sql`
    SELECT charge.inbound_shipment_id AS __shipment_id,allocation.* FROM procurement.inbound_freight_allocations allocation
    JOIN procurement.inbound_freight_costs charge ON charge.id=allocation.shipment_cost_id
    WHERE charge.inbound_shipment_id=ANY(${sql.param(ids)}::int[]) ORDER BY allocation.id
  `)).rows, ids);
  const supplierCredits = await readShipmentSupplierCreditCostRows(tx, ids.filter(id => charges.get(id)!.length > 0));
  const previous = partition((await tx.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (revision.inbound_shipment_line_id)
        line.inbound_shipment_id AS __shipment_id,revision.inbound_shipment_line_id,revision.contract,revision.fingerprint,revision.source_evidence
      FROM procurement.cost_source_revisions revision
      JOIN procurement.inbound_shipment_lines line ON line.id=revision.inbound_shipment_line_id
      WHERE line.inbound_shipment_id=ANY(${sql.param(ids)}::int[]) AND revision.component='landed'
      ORDER BY revision.inbound_shipment_line_id,revision.id DESC
    )
    SELECT latest.*,confirmed.source_evidence AS confirmed_source_evidence FROM latest
    LEFT JOIN LATERAL (
      SELECT revision.source_evidence FROM procurement.cost_source_revisions revision
      WHERE revision.inbound_shipment_line_id=latest.inbound_shipment_line_id AND revision.component='landed'
        AND revision.contract->>'issue' IS NULL AND revision.source_evidence IS NOT NULL
      ORDER BY revision.id DESC LIMIT 1
    ) confirmed ON true
  `)).rows, ids);
  return new Map(ids.map(id => [id, { lines: lines.get(id)!, charges: charges.get(id)!, invoiceRows: invoiceRows.get(id)!,
    allocationRows: allocationRows.get(id)!, previous: previous.get(id)!, supplierCredits: supplierCredits.get(id) ?? [] }]));
}
