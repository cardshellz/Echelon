import { sql } from "drizzle-orm";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { readSupplierHeaderSources, supplierHeaderTargetKey } from "./supplier-header-cost-source.repository";
import { supplierHeaderLineEvidence } from "./domain/supplier-header-costs";

/** Header approval is attached to original invoice rows, never substituted for
 * their billed line amounts. Absent classifications preserve legacy evidence. */
export async function attachSupplierHeaderInvoiceEvidence(tx: CostEvidenceTransaction, rows: Record<string, unknown>[]) {
  const ids = [...new Set(rows.map(row => costInteger(row.vendor_invoice_id, "invoice", 1)))];
  if (!ids.length) return rows;
  const selectedIds = (await tx.execute(sql`SELECT id FROM procurement.vendor_invoices invoice
    WHERE id=ANY(${sql.param(ids)}::int[]) AND EXISTS (
      SELECT 1 FROM procurement.supplier_header_cost_reviews review WHERE review.vendor_invoice_id=invoice.id)
    ORDER BY id`)).rows.map(row => costInteger(row.id, "reviewed header invoice", 1));
  const sources = await readSupplierHeaderSources(tx, selectedIds.map(id => ({ kind: "invoice", id })));
  return rows.map(row => {
    const selection = sources.get(supplierHeaderTargetKey({ kind: "invoice", id: costInteger(row.vendor_invoice_id, "invoice", 1) }));
    if (!selection) return row;
    if (selection.issue) return { ...row, header_cost_issue: selection.issue };
    const shares = supplierHeaderLineEvidence(selection.shares, costInteger(row.id, "invoice line", 1));
    return { ...row, header_cost_evidence: shares, header_authority: {
      sourceFingerprint: selection.current!.evidence.sourceFingerprint, expectedMills: selection.source.expectedMills,
    } };
  });
}
