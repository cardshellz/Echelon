import { sql } from "drizzle-orm";
import type { CostEvidenceTransaction } from "./cost-evidence.repository";
import { costFingerprint, costInteger, CostEvidenceError } from "./cost-evidence-values";
import { noInventoryEffectEvidenceSchema, type NoInventoryEffectEvidence } from "../domain/no-inventory-effect";

/** Read-only and batched for current status. Commands hold the inventory graph
 * lock before calling; views use their caller's repeatable-read snapshot. The
 * same evidence therefore decides posting and whether an old result is current. */
export async function readNoInventoryEffectEvidence(
  tx: CostEvidenceTransaction, purchaseOrderLineIds: readonly number[],
): Promise<Map<number, NoInventoryEffectEvidence>> {
  const ids = [...new Set(purchaseOrderLineIds.map(id => costInteger(id, "purchaseOrderLineId", 1)))].sort((a, b) => a - b);
  if (ids.length > 500) throw new CostEvidenceError("COST_REVIEW_LIMIT", "The full-return proof exceeds 500 purchase lines.");
  const result = new Map<number, NoInventoryEffectEvidence>();
  if (!ids.length) return result;
  const flags = (await tx.execute(sql`
    SELECT po_line.id,
      (po_line.received_qty<>0
        OR EXISTS(SELECT 1 FROM procurement.receiving_lines line WHERE line.purchase_order_line_id=po_line.id AND line.received_qty<>0)
        OR EXISTS(SELECT 1 FROM procurement.po_receipts receipt WHERE receipt.purchase_order_line_id=po_line.id AND receipt.qty_received<>0)) AS recognized_quantity,
      (EXISTS(SELECT 1 FROM inventory.lot_cost_origins origin WHERE origin.purchase_order_line_id=po_line.id)
        OR EXISTS(SELECT 1 FROM inventory.inventory_lots lot WHERE lot.po_line_id=po_line.id
          OR (lot.po_line_id IS NULL AND lot.purchase_order_id=po_line.purchase_order_id
            AND EXISTS(SELECT 1 FROM catalog.product_variants variant WHERE variant.id=lot.product_variant_id AND variant.product_id=po_line.product_id))
          OR (lot.po_line_id IS NULL AND EXISTS(SELECT 1 FROM procurement.receiving_lines line
            JOIN catalog.product_variants variant ON variant.id=lot.product_variant_id
            WHERE line.purchase_order_line_id=po_line.id AND line.receiving_order_id=lot.receiving_order_id AND variant.product_id=po_line.product_id)))
        OR EXISTS(SELECT 1 FROM inventory.inventory_transactions movement JOIN procurement.receiving_lines line
          ON line.id=movement.receiving_line_id OR (movement.receiving_line_id IS NULL AND movement.receiving_order_id=line.receiving_order_id
            AND EXISTS(SELECT 1 FROM catalog.product_variants variant WHERE variant.id=movement.product_variant_id AND variant.product_id=po_line.product_id))
          WHERE line.purchase_order_line_id=po_line.id AND movement.variant_qty_delta<>0)) AS inventory_history,
      (EXISTS(SELECT 1 FROM inventory.cost_reconciliation_postings posting WHERE posting.purchase_order_line_id=po_line.id AND posting.component IN ('product','packaging'))
        OR EXISTS(SELECT 1 FROM inventory.cost_application_lots changed
          JOIN inventory.cost_applications application ON application.id=changed.application_id
          JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id
          WHERE revision.purchase_order_line_id=po_line.id AND revision.component IN ('product','packaging'))) AS cost_history,
      (EXISTS(SELECT 1 FROM procurement.receiving_quarantine_observations observation WHERE observation.purchase_order_line_id=po_line.id
        AND (observation.received_qty<>0 OR observation.awaiting_receipt_qty<>0 OR observation.observed_qty<>observation.returned_qty))
        OR EXISTS(SELECT 1 FROM procurement.receiving_lines line JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
          WHERE line.purchase_order_line_id=po_line.id AND receipt.status NOT IN ('closed','cancelled') AND line.status<>'cancelled')
        OR EXISTS(SELECT 1 FROM procurement.receiving_quarantine_acceptances acceptance
          JOIN procurement.receiving_lines line ON line.id=acceptance.receiving_line_id
          WHERE line.purchase_order_line_id=po_line.id AND acceptance.status<>'cancelled')) AS outstanding_custody
    FROM procurement.purchase_order_lines po_line WHERE po_line.id=ANY(${sql.param(ids)}::int[]) ORDER BY po_line.id
  `)).rows;
  for (const row of flags) {
    const id = costInteger(row.id, "purchaseOrderLineId", 1);
    result.set(id, noInventoryEffectEvidenceSchema.parse({ purchaseOrderLineId: id,
      recognizedQuantity: row.recognized_quantity, inventoryHistory: row.inventory_history,
      costHistory: row.cost_history, outstandingCustody: row.outstanding_custody, invoices: [], returns: [] }));
  }
  const invoices = (await tx.execute(sql`
    SELECT line.id,line.vendor_invoice_id,line.qty_invoiced,line.line_total_cents,line.cost_component_evidence,invoice.currency,
      line.purchase_order_line_id AS source_line_id
    FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) AND invoice.status IN ('approved','partially_paid','paid')
    ORDER BY line.id LIMIT 10001
  `)).rows;
  const returns = (await tx.execute(sql`
    SELECT line.id,line.supplier_credit_id,line.invoice_line_id,line.amount_cents,line.disposition,line.source_evidence,credit.status,
      invoice_line.purchase_order_line_id,invoice_line.freight_cost_id,
      disposition.id AS live_disposition_id,disposition.observation_id AS live_observation_id,disposition.observation_qty AS live_disposition_qty,
      observation.receiving_line_id AS live_receiving_line_id,observation.purchase_order_line_id AS live_po_line_id,
      observation.units_per_variant_snapshot AS live_units,observation.observed_qty AS live_observed_qty,
      observation.returned_qty AS live_returned_qty,observation.received_qty AS live_received_qty,observation.awaiting_receipt_qty AS live_pending_qty,
      receipt.status AS live_receipt_status,
      (disposition.kind='return' AND disposition.acceptance_id IS NULL
        AND observation.product_id=po_line.product_id AND po.vendor_id=invoice.vendor_id
        AND observation.purchase_order_line_id=invoice_line.purchase_order_line_id
        AND observation.receiving_line_id=receiving_line.id AND receiving_line.purchase_order_line_id=po_line.id
        AND observation.product_variant_id=receiving_line.product_variant_id
        AND observation.units_per_variant_snapshot=receiving_line.units_per_variant_snapshot
        AND disposition.evidence_reference=line.disposition->>'evidenceReference') AS live_source_matches
    FROM procurement.supplier_credit_lines line
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.id=line.invoice_line_id
    JOIN procurement.vendor_invoices invoice ON invoice.id=invoice_line.vendor_invoice_id
    JOIN procurement.purchase_order_lines po_line ON po_line.id=invoice_line.purchase_order_line_id
    JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    JOIN procurement.receiving_quarantine_dispositions disposition ON disposition.id=(line.disposition->>'returnDispositionId')::integer
    JOIN procurement.receiving_quarantine_observations observation ON observation.id=disposition.observation_id
    JOIN procurement.receiving_lines receiving_line ON receiving_line.id=observation.receiving_line_id
    JOIN procurement.receiving_orders receipt ON receipt.id=receiving_line.receiving_order_id
    WHERE invoice_line.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) AND credit.status='approved'
      AND line.disposition->>'kind'='quarantine_return' ORDER BY line.id LIMIT 10001
  `)).rows;
  if (invoices.length > 10000 || returns.length > 10000) throw new CostEvidenceError("COST_REVIEW_LIMIT", "The full-return source proof exceeds 10000 records.");
  for (const { source_line_id, ...invoice } of invoices) {
    result.get(costInteger(source_line_id, "purchaseOrderLineId", 1))?.invoices.push({
      documentId: costInteger(invoice.vendor_invoice_id, "invoiceId", 1), lineId: costInteger(invoice.id, "invoiceLineId", 1), version: costFingerprint(invoice),
    });
  }
  for (const row of returns) {
    const credit = { id: row.id, supplier_credit_id: row.supplier_credit_id, invoice_line_id: row.invoice_line_id, amount_cents: row.amount_cents,
      disposition: row.disposition, source_evidence: row.source_evidence, status: row.status,
      purchase_order_line_id: row.purchase_order_line_id, freight_cost_id: row.freight_cost_id };
    result.get(costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1))?.returns.push({
      supplierCreditLineId: costInteger(row.id, "creditLineId", 1), supplierCreditId: costInteger(row.supplier_credit_id, "creditId", 1),
      creditVersion: costFingerprint(credit), returnDispositionId: costInteger(row.live_disposition_id, "returnDispositionId", 1),
      observationId: costInteger(row.live_observation_id, "observationId", 1), receivingLineId: costInteger(row.live_receiving_line_id, "receivingLineId", 1),
      purchaseOrderLineId: costInteger(row.live_po_line_id, "return.purchaseOrderLineId", 1),
      quantity: costInteger(row.disposition.quantity, "creditReturnQuantity", 1), unitsPerVariant: costInteger(row.live_units, "unitsPerVariant", 1),
      dispositionQuantity: costInteger(row.live_disposition_qty, "dispositionQuantity", 1),
      returnedQuantity: costInteger(row.live_returned_qty, "returnedQuantity"), observedQuantity: costInteger(row.live_observed_qty, "observedQuantity", 1),
      receivedQuantity: costInteger(row.live_received_qty, "receivedQuantity"), pendingQuantity: costInteger(row.live_pending_qty, "pendingQuantity"),
      sourceMatches: row.live_source_matches === true, receiptClosed: row.live_receipt_status === "closed",
    });
  }
  return new Map([...result].map(([id, evidence]) => [id, noInventoryEffectEvidenceSchema.parse(evidence)]));
}
