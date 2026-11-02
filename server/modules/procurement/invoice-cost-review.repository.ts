import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InvoiceCostComponentEvidence } from "@shared/procurement/invoice-cost-evidence";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

export async function readInvoiceCostReviewLine(tx: AmendmentTransaction, lineId: number) {
  return (await tx.execute(sql`
    SELECT line.*,invoice.status AS invoice_status,invoice.currency
    FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.id=${lineId} FOR UPDATE OF invoice,line
  `)).rows[0];
}

export async function persistInvoiceCostComponents(tx: AmendmentTransaction, lineId: number, evidence: InvoiceCostComponentEvidence, at: Date) {
  const saved = await tx.execute(sql`UPDATE procurement.vendor_invoice_lines
    SET cost_component_evidence=${canonicalJson(evidence)}::jsonb,updated_at=${at} WHERE id=${lineId} RETURNING id`);
  if (saved.rows.length !== 1) throw new Error("Invoice cost review lost its locked line");
}

export async function recordInvoiceCostReview(tx: AmendmentTransaction, input: {
  lineId: number; purchaseOrderLineId: number | null; actorId: string; at: Date;
  before: unknown; after: InvoiceCostComponentEvidence; context: Record<string, unknown>; retainApproval: boolean;
}) {
  await tx.execute(sql`
    INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES (${input.at},'AUDIT',${input.actorId},'procurement.invoice.cost_components',${`invoice-line:${input.lineId}`},
      ${canonicalJson({ before: input.before, after: input.after })}::jsonb,${canonicalJson(input.context)}::jsonb)
  `);
  if (input.retainApproval && input.purchaseOrderLineId !== null) {
    // Migration 227 protects PO events. The general audit row is an operational
    // copy; its removal must not erase a linked purchase's reviewed approval.
    const events = await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
      SELECT purchase_order_id,'invoice_cost_components_approved','user',${input.actorId},
        ${canonicalJson({ ...input.context, approvedAt: input.at.toISOString() })}::jsonb,${input.at}
      FROM procurement.purchase_order_lines WHERE id=${input.purchaseOrderLineId} RETURNING id`);
    if (events.rows.length !== 1) throw new Error("Supplier cost approval lost its purchase order relationship");
  }
}
