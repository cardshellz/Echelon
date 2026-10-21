import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { rfqWorkListHeaderSchema, rfqWorkListLineSchema, type RfqWorkListHeader, type RfqWorkListLine, type RfqWorkListQuery } from "@shared/procurement/rfq-work-list";
import type { RfqHandoffLinkEvidence } from "./domain/rfq-work-list";
import { isoTimestamp } from "./rfq-workflow.repository";

export interface RfqWorkListExecutor { execute(query: SQL): Promise<{ rows: unknown[] }> }
export interface RfqWorkListDatabase {
  transaction<T>(work: (tx: RfqWorkListExecutor) => Promise<T>, options: { isolationLevel: "repeatable read"; accessMode: "read only" }): Promise<T>;
}
export interface RfqWorkListEvidence {
  total: number; headers: RfqWorkListHeader[]; lines: RfqWorkListLine[]; links: RfqHandoffLinkEvidence[];
}
const id = z.number().int().positive().max(2_147_483_647);
const exactCount = z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, z.number().int().nonnegative().safe());
const linkSchema = z.object({
  id, rfqId: id, rfqLineId: id, quoteRevisionId: id, purchaseOrderId: id, purchaseOrderLineId: id,
  actualRfqId: id.nullable(), quoteRfqId: id.nullable(), quoteRfqLineId: id.nullable(), quoteCurrency: z.string().nullable(),
  actualPurchaseOrderId: id.nullable(), purchaseOrderVendorId: id.nullable(), poNumber: z.string().nullable(), purchaseOrderStatus: z.string().nullable(),
}).strict();
function normalizeTimestamps(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const row = z.record(z.unknown()).parse(value);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, fields.includes(key) && item !== null ? isoTimestamp(item) : item]));
}
function predicate(query: RfqWorkListQuery): SQL {
  const conditions: SQL[] = [sql`TRUE`];
  if (query.status !== undefined) conditions.push(sql`h.status=${query.status}`);
  if (query.search) {
    const pattern = `%${query.search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    conditions.push(sql`(h.rfq_number ILIKE ${pattern} OR vendor.name ILIKE ${pattern} OR EXISTS (
      SELECT 1 FROM procurement.request_for_quote_lines search_line
      JOIN procurement.purchase_recommendation_lines recommendation ON recommendation.id=search_line.recommendation_line_id
      LEFT JOIN procurement.vendor_products mapping ON mapping.id=search_line.vendor_product_id
      WHERE search_line.rfq_id=h.id AND (recommendation.sku ILIKE ${pattern} OR mapping.vendor_sku ILIKE ${pattern})
    ))`);
  }
  return sql.join(conditions, sql` AND `);
}

/** All read evidence shares one snapshot; a concurrent quote/conversion cannot
 * combine an old header/count with new line or purchase-link state. */
export async function readRfqWorkListEvidence(database: RfqWorkListDatabase, query: RfqWorkListQuery): Promise<RfqWorkListEvidence> {
  return database.transaction(async tx => {
    const where = predicate(query);
    const totals = await tx.execute(sql`SELECT count(*)::text AS total FROM procurement.request_for_quotes h
      LEFT JOIN procurement.vendors vendor ON vendor.id=h.vendor_id WHERE ${where}`);
    const total = z.object({ total: exactCount }).parse(totals.rows[0]).total;
    const result = await tx.execute(sql`SELECT h.id,h.rfq_number AS "rfqNumber",h.status,h.vendor_id AS "vendorId",vendor.name AS "vendorName",
      h.request_note AS "requestNote",h.currency,h.response_due_date::text AS "responseDueDate",h.created_by AS "createdBy",
      h.created_at AS "createdAt",h.updated_at AS "updatedAt",h.sent_at AS "sentAt",h.responded_at AS "respondedAt",h.cancelled_at AS "cancelledAt"
      FROM procurement.request_for_quotes h LEFT JOIN procurement.vendors vendor ON vendor.id=h.vendor_id WHERE ${where}
      ORDER BY h.created_at DESC,h.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
    const headers = result.rows.map(row => rfqWorkListHeaderSchema.parse(normalizeTimestamps(row, ["createdAt", "updatedAt", "sentAt", "respondedAt", "cancelledAt"])));
    if (headers.length === 0) return { total, headers, lines: [], links: [] };
    const ids = headers.map(header => header.id);
    const lineRows = await tx.execute(sql`SELECT q.id,q.rfq_id AS "rfqId",q.recommendation_line_id AS "recommendationLineId",r.run_id AS "recommendationRunId",
      q.vendor_product_id AS "vendorProductId",v.vendor_sku AS "vendorSku",r.sku,r.product_name AS "productName",q.status,
      q.requested_pieces AS "requestedPieces",r.recommended_pieces AS "recommendedPieces",q.purchase_uom AS "purchaseUom",q.pieces_per_purchase_uom AS "piecesPerPurchaseUom",
      q.quantity_override_reason AS "quantityOverrideReason",q.allocation_override_reason AS "allocationOverrideReason",
      q.allocation_override_approved_by AS "allocationOverrideApprovedBy",q.allocation_override_approved_at AS "allocationOverrideApprovedAt",
      q.allocation_override_baseline_pieces AS "allocationOverrideBaselinePieces",q.allocation_override_excess_pieces AS "allocationOverrideExcessPieces",
      q.quoted_pieces AS "quotedPieces",q.quoted_unit_cost_mills::text AS "quotedUnitCostMills",q.quote_reference AS "quoteReference",
      q.quote_valid_until::text AS "quoteValidUntil",q.quoted_at AS "quotedAt"
      FROM procurement.request_for_quote_lines q LEFT JOIN procurement.purchase_recommendation_lines r ON r.id=q.recommendation_line_id
      LEFT JOIN procurement.vendor_products v ON v.id=q.vendor_product_id WHERE q.rfq_id=ANY(${sql.param(ids)}::integer[]) ORDER BY q.rfq_id,q.id`);
    const lines = lineRows.rows.map(value => {
      const row = normalizeTimestamps(value, ["allocationOverrideApprovedAt", "quotedAt"]);
      return rfqWorkListLineSchema.parse({ ...row, quotedUnitCostMills: row.quotedUnitCostMills === null ? null : exactCount.parse(row.quotedUnitCostMills) });
    });
    const linkRows = await tx.execute(sql`SELECT link.id,link.rfq_id AS "rfqId",link.rfq_line_id AS "rfqLineId",link.quote_revision_id AS "quoteRevisionId",
      link.purchase_order_id AS "purchaseOrderId",link.purchase_order_line_id AS "purchaseOrderLineId",request_line.rfq_id AS "actualRfqId",
      quote.rfq_id AS "quoteRfqId",quote.rfq_line_id AS "quoteRfqLineId",quote.currency AS "quoteCurrency",purchase_line.purchase_order_id AS "actualPurchaseOrderId",
      purchase.vendor_id AS "purchaseOrderVendorId",purchase.po_number AS "poNumber",purchase.status AS "purchaseOrderStatus"
      FROM procurement.rfq_purchase_order_line_links link
      LEFT JOIN procurement.request_for_quote_lines request_line ON request_line.id=link.rfq_line_id
      LEFT JOIN procurement.rfq_quote_revisions quote ON quote.id=link.quote_revision_id
      LEFT JOIN procurement.purchase_order_lines purchase_line ON purchase_line.id=link.purchase_order_line_id
      LEFT JOIN procurement.purchase_orders purchase ON purchase.id=link.purchase_order_id
      WHERE link.rfq_id=ANY(${sql.param(ids)}::integer[]) OR request_line.rfq_id=ANY(${sql.param(ids)}::integer[]) ORDER BY link.id`);
    const links = linkRows.rows.map(row => linkSchema.parse(row));
    return { total, headers, lines, links };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
