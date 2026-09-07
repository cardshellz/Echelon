import { sql, type SQL } from "drizzle-orm";
import { purchaseReceiptEvidenceSchema, PURCHASE_RECEIPT_EVIDENCE_LIMIT } from "./purchase-receipt-quantity-evidence";
import { projectPurchasePlanningSupply, purchasePlanningOpenLinesSchema, PurchasePlanningSupplyError, type PurchasePlanningSupplyPosition } from "./purchase-planning-receipt-supply";

type ReadExecutor = { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> };

async function evidenceRows(tx: ReadExecutor, query: SQL, label: string): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(query);
  if (!Array.isArray(result.rows) || result.rows.length > PURCHASE_RECEIPT_EVIDENCE_LIMIT) {
    throw new PurchasePlanningSupplyError("PLANNING_SUPPLY_EVIDENCE_LIMIT", `The ${label} evidence exceeds ${PURCHASE_RECEIPT_EVIDENCE_LIMIT} records. Review the source data before calculating purchasing recommendations.`);
  }
  return result.rows;
}

/** Must run in the same read-only repeatable-read transaction as warehouse
 * stock. Read committed could observe stock before close and receipts after it,
 * or the reverse, even when every individual quantity source is correct. */
export async function readPurchasePlanningSupply(tx: ReadExecutor): Promise<Map<number, PurchasePlanningSupplyPosition>> {
  const lines = purchasePlanningOpenLinesSchema.parse(await evidenceRows(tx, sql`
    SELECT pol.id,pol.purchase_order_id AS "purchaseOrderId",po.po_number AS "purchaseOrderNumber",pol.product_id AS "productId",
      pol.order_qty AS ordered,COALESCE(pol.received_qty,0) AS received,COALESCE(pol.cancelled_qty,0) AS cancelled,
      pol.promised_date::date::text AS "promisedDate",pol.expected_delivery_date::date::text AS "expectedDate",
      po.confirmed_delivery_date::date::text AS "confirmedDate",po.expected_delivery_date::date::text AS "purchaseExpectedDate"
    FROM procurement.purchase_order_lines pol JOIN procurement.purchase_orders po ON po.id=pol.purchase_order_id
    WHERE po.status IN ('approved','sent','acknowledged','partially_received')
      AND pol.status IN ('open','partially_received') AND pol.line_type='product' AND pol.product_id IS NOT NULL
    ORDER BY po.id,pol.id LIMIT ${PURCHASE_RECEIPT_EVIDENCE_LIMIT + 1}
  `, "open purchase line"));
  if (lines.length === 0) return new Map();
  const ids = lines.map((line) => line.id);
  const purchaseIds = [...new Set(lines.map((line) => line.purchaseOrderId))];
  const receipts = await evidenceRows(tx, sql`
    SELECT rl.id,rl.receiving_order_id AS "receivingOrderId",ro.purchase_order_id AS "purchaseOrderId",rl.purchase_order_line_id AS "purchaseOrderLineId",
      ro.inbound_shipment_id AS "shipmentId",rl.inbound_shipment_line_id AS "shipmentLineId",rl.received_qty AS received,
      COALESCE(rl.reversed_qty,0) AS reversed,rl.units_per_variant_snapshot AS units,ro.status
    FROM procurement.receiving_lines rl JOIN procurement.receiving_orders ro ON ro.id=rl.receiving_order_id
    WHERE ro.status='closed' AND (rl.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) OR ro.purchase_order_id=ANY(${sql.param(purchaseIds)}::int[]))
    ORDER BY rl.id LIMIT ${PURCHASE_RECEIPT_EVIDENCE_LIMIT + 1}
  `, "closed receipt");
  const receiptIds = receipts.map((row) => row.id);
  const shipments = receipts.length === 0 ? [] : await evidenceRows(tx, sql`
    SELECT sl.id,sl.inbound_shipment_id AS "shipmentId",sl.purchase_order_id AS "purchaseOrderId",sl.purchase_order_line_id AS "purchaseOrderLineId"
    FROM procurement.inbound_shipment_lines sl
    WHERE sl.purchase_order_line_id=ANY(${sql.param(ids)}::int[])
    ORDER BY sl.id LIMIT ${PURCHASE_RECEIPT_EVIDENCE_LIMIT + 1}
  `, "receipt shipment identity");
  const postings = receiptIds.length === 0 ? [] : await evidenceRows(tx, sql`
    SELECT receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",purchase_order_id AS "purchaseOrderId",
      purchase_order_line_id AS "purchaseOrderLineId",qty_received AS "qtyReceived"
    FROM procurement.po_receipts WHERE receiving_line_id=ANY(${sql.param(receiptIds)}::int[]) ORDER BY id LIMIT ${PURCHASE_RECEIPT_EVIDENCE_LIMIT + 1}
  `, "receipt posting");
  const reversals = receiptIds.length === 0 ? [] : await evidenceRows(tx, sql`
    SELECT id,receiving_line_id AS "receivingLineId",receiving_order_id AS "receivingOrderId",qty,base_units_reversed AS "baseUnitsReversed"
    FROM procurement.receipt_reversals WHERE receiving_line_id=ANY(${sql.param(receiptIds)}::int[]) ORDER BY id LIMIT ${PURCHASE_RECEIPT_EVIDENCE_LIMIT + 1}
  `, "receipt reversal");
  return projectPurchasePlanningSupply(lines, purchaseReceiptEvidenceSchema.parse({ lines, shipments, receipts, postings, reversals }));
}
