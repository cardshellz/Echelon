import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costInteger, CostEvidenceError, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import type { SupplierCreditCostRow, SupplierCreditSourceEvidence } from "./domain/supplier-credit-source";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";

export type SupplierCreditSourceRow = SupplierCreditCostRow & {
  purchase_order_line_id: unknown; freight_cost_id: unknown;
};

export async function readSupplierCreditCostRows(tx: CostEvidenceTransaction, scope: {
  purchaseOrderLineIds?: readonly number[]; freightCostIds?: readonly number[]; creditId?: number;
}): Promise<SupplierCreditSourceRow[]> {
  const poIds = (scope.purchaseOrderLineIds ?? []).map(id => costInteger(id, "purchaseOrderLineId", 1));
  const freightIds = (scope.freightCostIds ?? []).map(id => costInteger(id, "freightCostId", 1));
  if (poIds.length + freightIds.length === 0 && scope.creditId === undefined) return [];
  const rows = (await tx.execute(sql`
    SELECT line.id,line.supplier_credit_id,line.invoice_line_id,line.amount_cents,line.disposition,line.source_evidence,credit.status,
      invoice_line.purchase_order_line_id,invoice_line.freight_cost_id
    FROM procurement.supplier_credit_lines line
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.id=line.invoice_line_id
    WHERE (credit.status='approved' OR (credit.status='voided' AND credit.approved_at IS NOT NULL))
      AND (invoice_line.purchase_order_line_id=ANY(${sql.param(poIds)}::int[])
        OR invoice_line.freight_cost_id=ANY(${sql.param(freightIds)}::int[])
        OR credit.id=${scope.creditId ?? null})
    ORDER BY line.id LIMIT 10001
  `)).rows;
  if (rows.length > 10000) throw new CostEvidenceError("CREDIT_SOURCE_LIMIT", "Supplier credit source review exceeds 10000 lines.");
  return rows as SupplierCreditSourceRow[];
}

export async function readSupplierCreditInvoiceLines(tx: CostEvidenceTransaction, invoiceId: number, lock: boolean) {
  const rows = (await tx.execute(sql`
    SELECT line.*,invoice.vendor_id,invoice.currency,invoice.status AS invoice_status,
      po.vendor_id AS po_vendor_id,po_line.product_id AS po_product_id,po_line.line_type AS po_line_type
    FROM procurement.vendor_invoice_lines line
    JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    LEFT JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
    LEFT JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    WHERE invoice.id=${costInteger(invoiceId, "invoiceId", 1)} ORDER BY line.id
    ${lock ? sql`FOR UPDATE OF invoice,line` : sql``}
  `)).rows;
  return rows;
}

/** Only known pending-recognition custody has a provable PO/vendor relationship.
 * Unknown goods are not silently assigned to the credit's invoice. */
export async function readSupplierCreditReturns(tx: CostEvidenceTransaction, invoice: Record<string, unknown>, lock: boolean) {
  if (invoice.purchase_order_line_id == null) return [];
  return (await tx.execute(sql`
    SELECT disposition.id,disposition.observation_id,disposition.observation_qty,disposition.evidence_reference,
      observation.receiving_line_id,observation.purchase_order_line_id,observation.product_id,
      observation.product_variant_id,observation.units_per_variant_snapshot,observation.unit_label,observation.description,
      po.vendor_id,po_line.product_id AS po_product_id
    FROM procurement.receiving_quarantine_dispositions disposition
    JOIN procurement.receiving_quarantine_observations observation ON observation.id=disposition.observation_id
    JOIN procurement.purchase_order_lines po_line ON po_line.id=observation.purchase_order_line_id
    JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    WHERE disposition.kind='return' AND disposition.acceptance_id IS NULL
      AND observation.receiving_line_id IS NOT NULL
      AND observation.purchase_order_line_id=${costInteger(invoice.purchase_order_line_id, "purchaseOrderLineId", 1)}
      AND po.vendor_id=${costInteger(invoice.vendor_id, "vendorId", 1)}
      AND observation.product_id=po_line.product_id
    ORDER BY disposition.id ${lock ? sql`FOR SHARE OF disposition,observation,po_line,po` : sql``}
  `)).rows;
}

export async function readCreditedReturnQuantities(tx: CostEvidenceTransaction, dispositionIds: readonly number[], excludeCreditId?: number) {
  if (dispositionIds.length === 0) return new Map<number, bigint>();
  const rows = (await tx.execute(sql`
    SELECT (line.disposition->>'returnDispositionId')::integer AS disposition_id,
      sum((line.disposition->>'quantity')::bigint)::text AS quantity
    FROM procurement.supplier_credit_lines line JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    WHERE credit.status='approved' AND credit.id IS DISTINCT FROM ${excludeCreditId ?? null}
      AND line.disposition->>'kind'='quarantine_return'
      AND (line.disposition->>'returnDispositionId')::integer=ANY(${sql.param(dispositionIds)}::int[])
    GROUP BY (line.disposition->>'returnDispositionId')::integer
  `)).rows;
  return new Map(rows.map(row => [costInteger(row.disposition_id, "returnDispositionId", 1), BigInt(String(row.quantity))]));
}

export async function writeSupplierCreditSourceResult(tx: CostEvidenceTransaction, lineId: number, input: {
  sourceEvidence?: SupplierCreditSourceEvidence; costState: "pending" | "posted" | "review_required"; costIssues: readonly CostIssue[];
}) {
  await tx.execute(sql`UPDATE procurement.supplier_credit_lines
    SET cost_state=${input.costState},cost_issues=${canonicalJson(input.costIssues)}::jsonb
      ${input.sourceEvidence ? sql`,source_evidence=${canonicalJson(input.sourceEvidence)}::jsonb` : sql``}
    WHERE id=${costInteger(lineId, "creditLineId", 1)}`);
}
