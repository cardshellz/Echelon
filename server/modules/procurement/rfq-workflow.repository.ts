import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  RFQ_WORKFLOW_MAX_LINES,
  rfqQuoteRevisionSchema,
  rfqResourceIdSchema,
  type RfqQuoteRevision,
  type RfqWorkflowDetail,
} from "@shared/procurement/rfq-workflow";

export interface RfqWorkflowExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export class RfqEvidenceIntegrityError extends Error {
  readonly code = "RFQ_EVIDENCE_INVALID";
  constructor() { super("Stored RFQ evidence failed validation"); this.name = "RfqEvidenceIntegrityError"; }
}

function readEvidence<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RfqEvidenceIntegrityError();
  return result.data;
}

const dbInteger = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number).pipe(z.number().int().safe());
const dbId = dbInteger.pipe(rfqResourceIdSchema);
const nullableId = dbId.nullable();
const headerSchema = z.object({ id: dbId, rfq_number: z.string(), vendor_id: dbId, currency: z.string(), status: z.string() });
const lineSchema = z.object({
  id: dbId, status: z.string(), product_id: dbId, product_variant_id: nullableId,
  warehouse_id: nullableId, vendor_product_id: dbId, sku: z.string(), product_name: z.string(), requested_pieces: dbId,
});

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  // Echelon's PostgreSQL parser preserves timestamptz as text. Require an
  // explicit zone, then normalize its space separator to the API ISO contract.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[ T].*(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)) throw new Error("RFQ evidence timestamp has no explicit timezone");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("RFQ evidence timestamp is invalid");
  return parsed.toISOString();
}

export function mapRfqQuoteRevision(row: Record<string, unknown>): RfqQuoteRevision {
  return readEvidence(rfqQuoteRevisionSchema, {
    id: readEvidence(dbId, row.id), rfqLineId: readEvidence(dbId, row.rfq_line_id), revision: readEvidence(dbId, row.revision),
    fingerprint: row.fingerprint, currency: row.currency, quotedPieces: readEvidence(dbId, row.quoted_pieces),
    quotedUnitCostMills: readEvidence(dbInteger, row.quoted_unit_cost_mills), productTotalMills: readEvidence(dbInteger, row.product_total_mills),
    pricingRemainderMills: readEvidence(dbInteger, row.pricing_remainder_mills), quote: row.quote_data,
    createdBy: row.created_by, createdAt: isoTimestamp(row.created_at),
  });
}

export type RfqWorkflowSnapshot = Omit<RfqWorkflowDetail, "version" | "lines"> & {
  lines: Array<Omit<RfqWorkflowDetail["lines"][number], "quantityReview"> & {
    quantityRuleEvidence: { recommendationRules: unknown; currentRules: unknown };
  }>;
};

export async function loadRfqWorkflow(executor: RfqWorkflowExecutor, rfqId: number, lock = false): Promise<RfqWorkflowSnapshot | null> {
  const headerRows = await executor.execute(sql`SELECT id, rfq_number, vendor_id, currency, status FROM procurement.request_for_quotes WHERE id = ${rfqId} ${lock ? sql`FOR UPDATE` : sql``}`);
  if (headerRows.rows.length === 0) return null;
  const header = readEvidence(headerSchema, headerRows.rows[0]);
  if (lock) {
    await executor.execute(sql`SELECT id FROM procurement.request_for_quote_lines WHERE rfq_id = ${rfqId} ORDER BY id FOR UPDATE`);
    // The existing RFQ allocation guard locks recommendation then product. Take
    // those locks before the PO owner obtains catalog SHARE locks to avoid an
    // upgrade inversion between quote conversion and new RFQ creation.
    await executor.execute(sql`SELECT id FROM procurement.purchase_recommendation_lines WHERE id IN (SELECT recommendation_line_id FROM procurement.request_for_quote_lines WHERE rfq_id = ${rfqId}) ORDER BY id FOR UPDATE`);
    await executor.execute(sql`SELECT id FROM catalog.products WHERE id IN (SELECT r.product_id FROM procurement.purchase_recommendation_lines r JOIN procurement.request_for_quote_lines q ON q.recommendation_line_id = r.id WHERE q.rfq_id = ${rfqId}) ORDER BY id FOR UPDATE`);
    // The application acquired the common cost graph lock before RFQ/source
    // locks. Keep catalog reads stable through the reused PO owner transaction;
    // catalog mutations use the same graph-first protocol and product-before-
    // mapping order. The PO owner later reacquires these SHARE locks.
    await executor.execute(sql`SELECT id FROM procurement.vendor_products WHERE id IN (SELECT vendor_product_id FROM procurement.request_for_quote_lines WHERE rfq_id = ${rfqId}) ORDER BY id FOR SHARE`);
  }
  const lineRows = await executor.execute(sql`
    SELECT q.id, q.status, q.vendor_product_id, q.requested_pieces, r.product_id, r.product_variant_id,
      r.warehouse_id, r.sku, r.product_name, r.evidence_snapshot->'supplierBasis' AS recommendation_supplier_rules,
      vendor_product.id AS current_vendor_product_id, vendor_product.moq AS current_moq,
      vendor_product.pack_size AS current_pack_size, vendor_product.pieces_per_purchase_uom AS current_purchase_uom_pieces
    FROM procurement.request_for_quote_lines q JOIN procurement.purchase_recommendation_lines r ON r.id = q.recommendation_line_id
    LEFT JOIN procurement.vendor_products vendor_product ON vendor_product.id = q.vendor_product_id
    WHERE q.rfq_id = ${rfqId} ORDER BY q.id LIMIT ${RFQ_WORKFLOW_MAX_LINES + 1}`);
  if (lineRows.rows.length > RFQ_WORKFLOW_MAX_LINES) throw new Error("RFQ workflow exceeds the supported line bound");
  const revisions = await executor.execute(sql`SELECT DISTINCT ON (rfq_line_id) * FROM procurement.rfq_quote_revisions WHERE rfq_id = ${rfqId} ORDER BY rfq_line_id, revision DESC`);
  const latest = new Map(revisions.rows.map((row) => { const revision = mapRfqQuoteRevision(row); return [revision.rfqLineId, revision] as const; }));
  const links = await executor.execute(sql`SELECT l.rfq_line_id, l.purchase_order_id, l.purchase_order_line_id, l.quote_revision_id, p.po_number, p.status FROM procurement.rfq_purchase_order_line_links l JOIN procurement.purchase_orders p ON p.id = l.purchase_order_id WHERE l.rfq_id = ${rfqId}`);
  const byLine = new Map(links.rows.map((row) => [readEvidence(dbId, row.rfq_line_id), {
    purchaseOrderId: readEvidence(dbId, row.purchase_order_id), purchaseOrderLineId: readEvidence(dbId, row.purchase_order_line_id), quoteRevisionId: readEvidence(dbId, row.quote_revision_id), poNumber: readEvidence(z.string(), row.po_number), status: readEvidence(z.string(), row.status),
  }] as const));
  return {
    id: header.id, rfqNumber: header.rfq_number, vendorId: header.vendor_id, currency: header.currency, status: header.status,
    lines: lineRows.rows.map((row) => {
      const line = readEvidence(lineSchema, row);
      return { id: line.id, status: line.status, productId: line.product_id, productVariantId: line.product_variant_id, warehouseId: line.warehouse_id, vendorProductId: line.vendor_product_id, sku: line.sku, productName: line.product_name, requestedPieces: line.requested_pieces, quantityRuleEvidence: { recommendationRules: row.recommendation_supplier_rules, currentRules: { vendorProductId: row.current_vendor_product_id, minimumOrderPieces: row.current_moq, packSize: row.current_pack_size, piecesPerPurchaseUom: row.current_purchase_uom_pieces } }, latestQuote: latest.get(line.id) ?? null, purchaseOrder: byLine.get(line.id) ?? null };
    }),
  };
}

export async function insertRfqQuoteRevision(executor: RfqWorkflowExecutor, rfqId: number, revision: Omit<RfqQuoteRevision, "id">): Promise<RfqQuoteRevision> {
  const result = await executor.execute(sql`INSERT INTO procurement.rfq_quote_revisions
    (rfq_id, rfq_line_id, revision, fingerprint, currency, quoted_pieces, quoted_unit_cost_mills, product_total_mills, pricing_remainder_mills, quote_data, created_by, created_at)
    VALUES (${rfqId}, ${revision.rfqLineId}, ${revision.revision}, ${revision.fingerprint}, ${revision.currency}, ${revision.quotedPieces}, ${revision.quotedUnitCostMills}, ${revision.productTotalMills}, ${revision.pricingRemainderMills}, ${JSON.stringify(revision.quote)}::jsonb, ${revision.createdBy}, ${revision.createdAt}::timestamptz)
    RETURNING *`);
  return mapRfqQuoteRevision(result.rows[0]);
}

export async function updateRfqQuoteMirrors(executor: RfqWorkflowExecutor, rfqId: number, revision: RfqQuoteRevision, headerStatus: string, at: Date): Promise<void> {
  await executor.execute(sql`UPDATE procurement.request_for_quote_lines SET status = 'quoted', quoted_pieces = ${revision.quotedPieces}, quoted_unit_cost_mills = ${revision.quotedUnitCostMills}, quote_reference = ${revision.quote.quoteReference}, quote_valid_until = ${revision.quote.quoteValidUntil}::date, quoted_at = ${revision.quote.quotedAt}::timestamptz, updated_at = ${at} WHERE id = ${revision.rfqLineId} AND rfq_id = ${rfqId}`);
  await executor.execute(sql`UPDATE procurement.request_for_quotes SET status = ${headerStatus}, responded_at = COALESCE(responded_at, ${at}), updated_at = ${at} WHERE id = ${rfqId}`);
}

export async function appendRfqAudit(executor: RfqWorkflowExecutor, input: { actorId: string; action: string; rfqId: number; before: unknown; after: unknown; at: Date; context?: Record<string, unknown> }): Promise<void> {
  await executor.execute(sql`INSERT INTO public.audit_events (timestamp, level, actor, action, target, changes, context) VALUES (${input.at}, 'AUDIT', ${input.actorId}, ${input.action}, ${`request_for_quote:${input.rfqId}`}, ${JSON.stringify({ before: input.before, after: input.after })}::jsonb, ${JSON.stringify(input.context ?? {})}::jsonb)`);
}

export async function loadCreatedPurchaseLines(executor: RfqWorkflowExecutor, purchaseOrderId: number): Promise<Array<{ id: number; lineNumber: number }>> {
  const rows = await executor.execute(sql`SELECT id, line_number FROM procurement.purchase_order_lines WHERE purchase_order_id = ${purchaseOrderId} ORDER BY line_number`);
  return rows.rows.map((row) => ({ id: readEvidence(dbId, row.id), lineNumber: readEvidence(dbId, row.line_number) }));
}

export async function insertRfqPurchaseLink(executor: RfqWorkflowExecutor, input: { rfqId: number; quote: RfqQuoteRevision; purchaseOrderId: number; purchaseOrderLineId: number; quantityOverrideReason: string | null; idempotencyKey: string; actorId: string; at: Date }): Promise<void> {
  const { quote } = input;
  await executor.execute(sql`INSERT INTO procurement.rfq_purchase_order_line_links (rfq_id, rfq_line_id, quote_revision_id, purchase_order_id, purchase_order_line_id, quoted_pieces, quoted_unit_cost_mills, quote_reference, quote_valid_until, quantity_override_reason, conversion_idempotency_key, created_by, created_at)
    VALUES (${input.rfqId}, ${quote.rfqLineId}, ${quote.id}, ${input.purchaseOrderId}, ${input.purchaseOrderLineId}, ${quote.quotedPieces}, ${quote.quotedUnitCostMills}, ${quote.quote.quoteReference}, ${quote.quote.quoteValidUntil}::date, ${input.quantityOverrideReason}, ${input.idempotencyKey}, ${input.actorId}, ${input.at})`);
  await executor.execute(sql`UPDATE procurement.request_for_quote_lines SET status = 'ordered', accepted_at = COALESCE(accepted_at, ${input.at}), ordered_at = ${input.at}, updated_at = ${input.at} WHERE id = ${quote.rfqLineId} AND rfq_id = ${input.rfqId}`);
}

export async function readRfqQuoteHistory(executor: RfqWorkflowExecutor, rfqId: number, lineId: number, beforeRevision: number | null, limit: number): Promise<{ revisions: RfqQuoteRevision[]; nextBeforeRevision: number | null }> {
  const result = await executor.execute(sql`SELECT * FROM procurement.rfq_quote_revisions WHERE rfq_id = ${rfqId} AND rfq_line_id = ${lineId} ${beforeRevision === null ? sql`` : sql`AND revision < ${beforeRevision}`} ORDER BY revision DESC LIMIT ${limit + 1}`);
  const revisions = result.rows.slice(0, limit).map(mapRfqQuoteRevision);
  return { revisions, nextBeforeRevision: result.rows.length > limit ? revisions[revisions.length - 1].revision : null };
}

export async function readRfqLineAuditSnapshot(executor: RfqWorkflowExecutor, lineId: number): Promise<unknown> {
  // Serialize legacy BIGINT and decimal fields as strings before PostgreSQL JSON
  // reaches the JavaScript parser, preserving values beyond its safe integer range.
  // Keep all remaining legacy fields and timestamp evidence before the
  // compatibility mirrors change, without inventing a historical quote revision.
  const result = await executor.execute(sql`SELECT to_jsonb(q) || jsonb_build_object('quoted_unit_cost_mills', q.quoted_unit_cost_mills::text, 'requested_purchase_uom_qty', q.requested_purchase_uom_qty::text) AS snapshot FROM procurement.request_for_quote_lines q WHERE q.id = ${lineId}`);
  if (result.rows.length !== 1) throw new Error("RFQ line audit snapshot is unavailable");
  return result.rows[0].snapshot;
}