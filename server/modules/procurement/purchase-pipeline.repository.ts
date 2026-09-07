import { sql, type SQL } from "drizzle-orm";
import type { db as applicationDatabase } from "../../db";
import { emptySupplierProgress, supplierProgressHistorySchema, supplierProgressSchema } from "@shared/procurement/purchase-pipeline";
import { pipelineEvidenceSchema, PIPELINE_EVIDENCE_LIMIT, PurchasePipelineError, type PipelineEvidence } from "./purchase-pipeline.service";

export type PipelineDatabase = Pick<typeof applicationDatabase, "transaction">;
export type PipelineTransaction = Parameters<Parameters<PipelineDatabase["transaction"]>[0]>[0];
export type PipelineRow = Record<string, unknown>;
export async function pipelineRows(tx: PipelineTransaction, query: SQL, label: string, limit = PIPELINE_EVIDENCE_LIMIT): Promise<PipelineRow[]> {
  const result = await tx.execute(query);
  if (!Array.isArray(result.rows) || result.rows.length > limit) throw new PurchasePipelineError("PIPELINE_EVIDENCE_LIMIT", `The ${label} evidence exceeds ${limit} records. Narrow or review the source data before calculating totals.`);
  return result.rows as PipelineRow[];
}
export function pipelineDates(row: PipelineRow, names: readonly string[]): PipelineRow {
  const copy = { ...row };
  for (const name of names) {
    const value = copy[name];
    if (value === null) continue;
    if (!(value instanceof Date) && typeof value !== "string") throw new PurchasePipelineError("PIPELINE_DATE_INVALID", `Invalid recorded ${name}.`);
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new PurchasePipelineError("PIPELINE_DATE_INVALID", `Invalid recorded ${name}.`);
    copy[name] = date.toISOString();
  }
  return copy;
}
export function pipelineProgress(row: PipelineRow | undefined) {
  if (!row) return emptySupplierProgress();
  return supplierProgressSchema.parse(pipelineDates(row, ["recordedAt"]));
}

export function createPurchasePipelineRepository(database: PipelineDatabase) {
  return {
    async read(): Promise<PipelineEvidence> {
      return database.transaction(async (tx) => {
        const lines = await pipelineRows(tx, sql`
          SELECT l.id,l.purchase_order_id AS "purchaseOrderId",po.po_number AS "poNumber",COALESCE(v.name,'Supplier unknown') AS "vendorName",
            po.status AS "poStatus",l.status,l.sku,l.product_name AS "productName",po.currency,
            l.order_qty AS ordered,COALESCE(l.received_qty,0) AS received,COALESCE(l.cancelled_qty,0) AS cancelled,
            l.pricing_basis AS "pricingBasis",l.quoted_unit_cost_mills::text AS "quotedUnitMills",l.quoted_total_cents::text AS "quotedTotalCents",
            l.purchase_uom_quantity AS "purchaseUomQuantity",l.pieces_per_purchase_uom AS "piecesPerPurchaseUom",l.packaging_cost_cents::text AS "packagingCents",
            l.quote_reference AS "quoteReference",l.expected_delivery_date AS "expectedDate",l.promised_date AS "promisedDate",
            po.confirmed_delivery_date AS "confirmedDate",po.expected_delivery_date AS "purchaseExpectedDate",
            p.revision AS "progressRevision",p.report AS "progressReport",p.recorded_by AS "progressActor",p.recorded_at AS "progressAt"
          FROM procurement.purchase_order_lines l JOIN procurement.purchase_orders po ON po.id=l.purchase_order_id
          LEFT JOIN procurement.vendors v ON v.id=po.vendor_id
          LEFT JOIN procurement.purchase_supplier_progress p ON p.purchase_order_line_id=l.id
          WHERE po.status IN ('approved','sent','acknowledged','partially_received') AND l.line_type='product'
            AND l.status NOT IN ('closed','cancelled','received')
          ORDER BY po.id,l.id LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "purchase line");
        const ids = lines.map((line) => line.id); const purchaseIds = [...new Set(lines.map((line) => line.purchaseOrderId))];
        if (ids.length === 0) return { lines: [], shipments: [], receipts: [], postings: [], reversals: [], revisions: [] };
        const shipments = await pipelineRows(tx, sql`
          SELECT sl.id,sl.inbound_shipment_id AS "shipmentId",sl.purchase_order_id AS "purchaseOrderId",sl.purchase_order_line_id AS "purchaseOrderLineId",
            s.shipment_number AS "shipmentNumber",s.status,sl.qty_shipped AS quantity,s.eta,s.delivered_date AS "deliveredAt"
          FROM procurement.inbound_shipment_lines sl JOIN procurement.inbound_shipments s ON s.id=sl.inbound_shipment_id
          WHERE sl.purchase_order_line_id=ANY(${sql.param(ids)}::int[])
            OR (sl.purchase_order_id=ANY(${sql.param(purchaseIds)}::int[]) AND sl.purchase_order_line_id IS NULL)
          ORDER BY sl.id LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "shipment line");
        const receipts = await pipelineRows(tx, sql`
          SELECT rl.id,rl.receiving_order_id AS "receivingOrderId",ro.purchase_order_id AS "purchaseOrderId",rl.purchase_order_line_id AS "purchaseOrderLineId",
            ro.inbound_shipment_id AS "shipmentId",rl.inbound_shipment_line_id AS "shipmentLineId",rl.received_qty AS received,COALESCE(rl.reversed_qty,0) AS reversed,
            rl.units_per_variant_snapshot AS units,ro.status
          FROM procurement.receiving_lines rl JOIN procurement.receiving_orders ro ON ro.id=rl.receiving_order_id
          WHERE ro.status='closed' AND (rl.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) OR ro.purchase_order_id=ANY(${sql.param(purchaseIds)}::int[]))
          ORDER BY rl.id LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "closed receipt");
        const receiptIds = receipts.map((row) => row.id);
        const postings = receiptIds.length === 0 ? [] : await pipelineRows(tx, sql`
          SELECT receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",purchase_order_id AS "purchaseOrderId",purchase_order_line_id AS "purchaseOrderLineId",qty_received AS "qtyReceived"
          FROM procurement.po_receipts WHERE receiving_line_id=ANY(${sql.param(receiptIds)}::int[]) ORDER BY id LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "receipt posting");
        const reversals = receiptIds.length === 0 ? [] : await pipelineRows(tx, sql`
          SELECT id,receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",qty,base_units_reversed AS "baseUnitsReversed"
          FROM procurement.receipt_reversals WHERE receiving_line_id=ANY(${sql.param(receiptIds)}::int[]) ORDER BY id LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "receipt reversal");
        const revisions = await pipelineRows(tx, sql`
          SELECT DISTINCT ON (purchase_order_line_id,inbound_shipment_line_id,component)
            id::text,purchase_order_line_id AS "purchaseOrderLineId",inbound_shipment_line_id AS "shipmentLineId",component,revision,fingerprint,contract,
            source_evidence AS "sourceEvidence",recorded_at AS "recordedAt"
          FROM procurement.cost_source_revisions WHERE purchase_order_line_id=ANY(${sql.param(ids)}::int[])
          ORDER BY purchase_order_line_id,inbound_shipment_line_id,component,revision DESC LIMIT ${PIPELINE_EVIDENCE_LIMIT + 1}
        `, "latest cost revision");
        return pipelineEvidenceSchema.parse({
          lines: lines.map((row) => ({ ...pipelineDates(row, ["expectedDate", "promisedDate", "confirmedDate", "purchaseExpectedDate"]),
            progress: row.progressRevision === null ? emptySupplierProgress() : pipelineProgress({ revision: row.progressRevision, report: row.progressReport, recordedBy: row.progressActor, recordedAt: row.progressAt }) })),
          shipments: shipments.map((row) => pipelineDates(row, ["eta", "deliveredAt"])), receipts, postings, reversals,
          revisions: revisions.map((row) => {
            const id = typeof row.id === "string" && /^\d+$/.test(row.id) && BigInt(row.id) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(row.id) : row.id;
            return pipelineDates({ ...row, id }, ["recordedAt"]);
          }),
        });
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async history(purchaseOrderLineId: number) {
      return database.transaction(async (tx) => {
        const line = await pipelineRows(tx, sql`SELECT id FROM procurement.purchase_order_lines WHERE id=${purchaseOrderLineId}`, "purchase line", 1);
        if (!line.length) throw new PurchasePipelineError("PIPELINE_LINE_NOT_FOUND", "The purchase line does not exist.", 404);
        const current = await pipelineRows(tx, sql`SELECT revision,report,recorded_by AS "recordedBy",recorded_at AS "recordedAt" FROM procurement.purchase_supplier_progress WHERE purchase_order_line_id=${purchaseOrderLineId}`, "current progress", 1);
        const changes = await pipelineRows(tx, sql`
          SELECT revision,before_report AS before,after_report AS after,recorded_by AS "recordedBy",recorded_at AS "recordedAt"
          FROM procurement.purchase_supplier_progress_revisions WHERE purchase_order_line_id=${purchaseOrderLineId} ORDER BY revision DESC LIMIT 1001
        `, "supplier progress history", 1_000);
        return supplierProgressHistorySchema.parse({ purchaseOrderLineId, current: pipelineProgress(current[0]), changes: changes.map((row) => pipelineDates(row, ["recordedAt"])) });
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
