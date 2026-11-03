import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { apInvoiceTransitionReceiptSchema, type ApInvoiceTransitionReceipt } from "@shared/procurement/ap-invoice-transition";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { ApLedgerError } from "./ap-ledger.service";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

export async function readInvoiceTransitionHistory(tx: AmendmentTransaction, invoiceId: number) {
  const invoice = (await tx.execute(sql`SELECT id FROM procurement.vendor_invoices WHERE id=${invoiceId}`)).rows[0];
  if (!invoice) throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  const rows = (await tx.execute(sql`SELECT preview,actor_id,actor_name,approved_at
    FROM procurement.ap_invoice_transition_reviews WHERE invoice_id=${invoiceId} ORDER BY id DESC LIMIT 50`)).rows;
  return rows.map(row => {
    const receipt = apInvoiceTransitionReceiptSchema.safeParse({ preview: row.preview, actorId: row.actor_id,
      actorName: row.actor_name, approvedAt: new Date(String(row.approved_at)).toISOString() });
    if (!receipt.success) throw new Error("Retained invoice transition receipt is invalid");
    return receipt.data;
  });
}

export async function readInvoiceTransitionDocuments(tx: AmendmentTransaction, invoiceId: number) {
  const invoice = (await tx.execute(sql`SELECT * FROM procurement.vendor_invoices WHERE id=${invoiceId} FOR UPDATE`)).rows[0];
  if (!invoice) throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  const lines = (await tx.execute(sql`SELECT * FROM procurement.vendor_invoice_lines
    WHERE vendor_invoice_id=${invoiceId} ORDER BY id LIMIT 501 FOR UPDATE`)).rows;
  const links = (await tx.execute(sql`SELECT * FROM procurement.vendor_invoice_po_links
    WHERE vendor_invoice_id=${invoiceId} ORDER BY id LIMIT 501 FOR UPDATE`)).rows;
  if (lines.length > 500 || links.length > 500) throw new ApLedgerError("This invoice exceeds the complete review limit. No partial review was used.", 409,
    { code: "AP_INVOICE_TRANSITION_REVIEW_LIMIT" });
  return { invoice, lines, links };
}

export async function retainInvoiceTransitionReview(tx: AmendmentTransaction, receipt: ApInvoiceTransitionReceipt,
  commandKey: string, authority: unknown, purchaseOrderIds: number[]) {
  const { preview, actorId, actorName, approvedAt } = receipt;
  const retained = (await tx.execute(sql`INSERT INTO procurement.ap_invoice_transition_reviews
    (invoice_id,actor_id,actor_name,action,reason,command_key,preview,authority,approved_at)
    VALUES(${preview.invoiceId},${actorId},${actorName},${preview.action},${preview.reason},${commandKey},
      ${canonicalJson(preview)}::jsonb,${canonicalJson(authority)}::jsonb,${new Date(approvedAt)}) RETURNING id`)).rows[0];
  const reviewId = costInteger(retained?.id, "invoiceTransitionReviewId", 1);
  const payload = { reviewId, ...receipt };
  for (const poId of [...new Set(purchaseOrderIds)].sort((a, b) => a - b)) {
    await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
      VALUES(${poId},'invoice_transition_reviewed','user',${actorId},${canonicalJson(payload)}::jsonb,${new Date(approvedAt)})`);
  }
  await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${new Date(approvedAt)},'AUDIT',${actorId},'procurement.invoice.transition_reviewed',${`vendor_invoice:${preview.invoiceId}`},
      ${canonicalJson(payload)}::jsonb,${canonicalJson({ commandKey, authority })}::jsonb)`);
}
