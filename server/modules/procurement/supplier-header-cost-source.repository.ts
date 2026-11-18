import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  supplierHeaderTargetSchema, supplierHeaderSourceSchema, supplierHeaderEntriesSchema, supplierHeaderShareSchema,
  type SupplierHeaderTarget, type SupplierHeaderSource, type SupplierHeaderShare, type SupplierHeaderEvidence,
} from "@shared/procurement/supplier-header-costs";
import { selectSupplierHeaderShares } from "./domain/supplier-header-costs";
import { readPurchaseTaxTypes } from "./purchase-tax-evidence.repository";
import { costInteger, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { buildPurchaseOrderHeaderSource, buildInvoiceHeaderSource } from "./domain/supplier-header-source";

const LIMIT = 10_000;
export const supplierHeaderTargetKey = (target: SupplierHeaderTarget) => `${target.kind}:${target.id}`;
type Raw = Record<string, unknown>;
export type HeaderReviewRecord = {
  id: number; target: SupplierHeaderTarget; evidence: SupplierHeaderEvidence;
  before: SupplierHeaderShare[]; after: SupplierHeaderShare[]; purchaseOrderIds: number[];
  actorId: string; actorName: string; approvedAt: string; reason: string; commandKey: string; sourceVersion: string; previewVersion: string;
};
export type HeaderSourceSelection = { source: SupplierHeaderSource; current: HeaderReviewRecord | null;
  shares: SupplierHeaderShare[]; issue: { code: string; message: string } | null };

function bounded(rows: Raw[]): Raw[] {
  if (rows.length > LIMIT) throw new CostEvidenceError("SUPPLIER_HEADER_LIMIT", "The complete supplier header review exceeds 10000 source lines.");
  return rows;
}
export function headerReviewRecord(row: Raw): HeaderReviewRecord {
  const purchaseOrderId = row.purchase_order_id == null ? null : costInteger(row.purchase_order_id, "header PO", 1);
  const vendorInvoiceId = row.vendor_invoice_id == null ? null : costInteger(row.vendor_invoice_id, "header invoice", 1);
  if ((purchaseOrderId === null) === (vendorInvoiceId === null)) throw new CostEvidenceError("SUPPLIER_HEADER_SOURCE_INVALID", "A header review must identify one original document.");
  const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
  return {
    id: costInteger(row.id, "header review", 1),
    target: purchaseOrderId === null ? { kind: "invoice", id: vendorInvoiceId! } : { kind: "purchase_order", id: purchaseOrderId },
    evidence: { contractVersion: 1, sourceFingerprint: fingerprint.parse(row.source_fingerprint), entries: supplierHeaderEntriesSchema.parse(row.entries_json) },
    before: z.array(supplierHeaderShareSchema).max(15000).parse(row.before_json),
    after: z.array(supplierHeaderShareSchema).max(15000).parse(row.after_json),
    purchaseOrderIds: z.array(z.number().int().positive()).max(500).parse(row.purchase_order_ids),
    actorId: z.string().min(1).parse(row.actor_id), actorName: z.string().parse(row.actor_name),
    approvedAt: z.coerce.date().parse(row.approved_at).toISOString(), reason: z.string().parse(row.reason),
    commandKey: z.string().min(1).parse(row.command_key), sourceVersion: fingerprint.parse(row.source_version), previewVersion: fingerprint.parse(row.preview_version),
  };
}

/** Bounded document batches, not a read per invoice/receipt/stock lot. Approval
 * code takes the shared graph lock before using this source snapshot. */
export async function readSupplierHeaderSources(tx: CostEvidenceTransaction, targets: readonly SupplierHeaderTarget[], includeTypes = false): Promise<Map<string, HeaderSourceSelection>> {
  const requested = [...new Map(targets.map(value => { const target = supplierHeaderTargetSchema.parse(value); return [supplierHeaderTargetKey(target), target] as const; })).values()];
  if (!requested.length) return new Map();
  if (requested.length > LIMIT) throw new CostEvidenceError("SUPPLIER_HEADER_LIMIT", "The complete header review exceeds 10000 documents.");
  const poIds = requested.filter(row => row.kind === "purchase_order").map(row => row.id);
  const invoiceIds = requested.filter(row => row.kind === "invoice").map(row => row.id);
  const reviewRows = bounded((await tx.execute(sql`SELECT DISTINCT ON (purchase_order_id,vendor_invoice_id) *
    FROM procurement.supplier_header_cost_reviews
    WHERE purchase_order_id=ANY(${sql.param(poIds)}::int[]) OR vendor_invoice_id=ANY(${sql.param(invoiceIds)}::int[])
    ORDER BY purchase_order_id,vendor_invoice_id,id DESC LIMIT ${LIMIT + 1}`)).rows);
  const reviews = new Map(reviewRows.map(row => { const review = headerReviewRecord(row); return [supplierHeaderTargetKey(review.target), review] as const; }));
  const types = includeTypes || reviewRows.some(row => supplierHeaderEntriesSchema.parse(row.entries_json).some(entry => entry.category === "tax"))
    ? await readPurchaseTaxTypes(tx) : [];
  const poRows = poIds.length ? bounded((await tx.execute(sql`SELECT line.*,po.id AS document_id,po.po_number AS document_reference,po.currency,
      po.discount_cents AS header_discount_cents,po.shipping_cost_cents AS header_shipping_cents
    FROM procurement.purchase_orders po LEFT JOIN procurement.purchase_order_lines line ON line.purchase_order_id=po.id AND line.status<>'cancelled'
    WHERE po.id=ANY(${sql.param(poIds)}::int[]) ORDER BY po.id,line.id LIMIT ${LIMIT + 1}`)).rows) : [];
  const invoiceRows = invoiceIds.length ? bounded((await tx.execute(sql`SELECT line.*,invoice.id AS document_id,invoice.invoice_number AS document_reference,
      invoice.currency,invoice.invoiced_amount_cents,invoice.vendor_id,po_line.line_type AS po_line_type,po.vendor_id AS po_vendor_id,
      charge.inbound_shipment_id,charge.vendor_invoice_id AS charge_invoice_id,charge.vendor_id AS charge_vendor_id,charge.currency AS charge_currency
    FROM procurement.vendor_invoices invoice LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
    LEFT JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
    LEFT JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    LEFT JOIN procurement.inbound_freight_costs charge ON charge.id=line.freight_cost_id
    WHERE invoice.id=ANY(${sql.param(invoiceIds)}::int[]) ORDER BY invoice.id,line.id LIMIT ${LIMIT + 1}`)).rows) : [];
  const groups = new Map<string, Raw[]>();
  for (const [kind, rows] of [["purchase_order", poRows], ["invoice", invoiceRows]] as const) {
    for (const row of rows) {
      const key = `${kind}:${costInteger(row.document_id, "header source", 1)}`;
      const grouped = groups.get(key) ?? []; grouped.push(row); groups.set(key, grouped);
    }
  }
  const result = new Map<string, HeaderSourceSelection>();
  for (const target of requested) {
    const key = supplierHeaderTargetKey(target), rows = groups.get(key);
    if (!rows?.length) throw new CostEvidenceError("SUPPLIER_HEADER_SOURCE_MISSING", "The original supplier header document is missing.");
    const first = rows[0];
    if (first.currency !== "USD") throw new CostEvidenceError("SUPPLIER_HEADER_CURRENCY_REQUIRED", "Review the original USD document; no exchange rate is inferred.");
    const source = supplierHeaderSourceSchema.parse(target.kind === "purchase_order"
      ? buildPurchaseOrderHeaderSource(target, rows, types) : buildInvoiceHeaderSource(target, rows, types));
    const current = reviews.get(key) ?? null;
    let shares: SupplierHeaderShare[] = [], issue: HeaderSourceSelection["issue"] = null;
    if (current) {
      try { shares = selectSupplierHeaderShares(source, current.evidence); }
      catch (error) {
        if (!(error instanceof CostEvidenceError || error instanceof z.ZodError || error instanceof RangeError)) throw error;
        issue = { code: "SUPPLIER_HEADER_ALLOCATION_REQUIRED", message: error instanceof CostEvidenceError ? error.message : "Review this supplier header's saved classifications against its current source." };
      }
    } else if (source.expectedMills !== 0 || source.facts.length) issue = {
      code: "SUPPLIER_HEADER_ALLOCATION_REQUIRED", message: `Review the header amounts on ${source.reference} so their exact shares can reach inventory costs.`,
    };
    result.set(key, { source, current, shares, issue });
  }
  return result;
}
