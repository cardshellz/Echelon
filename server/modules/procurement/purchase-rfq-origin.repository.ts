import { sql } from "drizzle-orm";
import { purchaseRfqOriginSchema, type PurchaseRfqOrigin } from "@shared/procurement/purchase-rfq-origin";
import { readRows, dateValues, PURCHASE_WORKSPACE_LINE_LIMIT, type Transaction } from "./purchase-workspace-read";
import { PurchaseWorkspaceError } from "./purchase-workspace.service";

/** Only the immutable conversion link proves which exact quote produced a PO
 * line. Shared suppliers, SKUs, dates and free-text references never establish it. */
export async function readPurchaseRfqOrigins(tx: Transaction, purchaseOrderId: number): Promise<PurchaseRfqOrigin[]> {
  const rows = await readRows(tx, sql`
    SELECT link.id,link.rfq_id AS "rfqId",rfq.rfq_number AS "rfqNumber",link.rfq_line_id AS "rfqLineId",
      link.purchase_order_line_id AS "purchaseOrderLineId",link.quote_revision_id AS "quoteRevisionId",
      link.quote_reference AS "quoteReference",link.quoted_pieces AS "quotedPieces",quote.currency,
      link.created_at AS "linkedAt",link.purchase_order_id AS "linkedPurchaseOrderId",
      line.purchase_order_id AS "actualPurchaseOrderId",quote.rfq_id AS "quoteRfqId",quote.rfq_line_id AS "quoteRfqLineId"
    FROM procurement.rfq_purchase_order_line_links link
    LEFT JOIN procurement.purchase_order_lines line ON line.id=link.purchase_order_line_id
    LEFT JOIN procurement.request_for_quotes rfq ON rfq.id=link.rfq_id
    LEFT JOIN procurement.rfq_quote_revisions quote ON quote.id=link.quote_revision_id
    WHERE link.purchase_order_id=${purchaseOrderId} OR line.purchase_order_id=${purchaseOrderId}
    ORDER BY link.id LIMIT ${PURCHASE_WORKSPACE_LINE_LIMIT + 1}
  `, "RFQ purchase sources", PURCHASE_WORKSPACE_LINE_LIMIT);
  return rows.map((row) => {
    if (row.linkedPurchaseOrderId !== purchaseOrderId || row.actualPurchaseOrderId !== purchaseOrderId
      || row.quoteRfqId !== row.rfqId || row.quoteRfqLineId !== row.rfqLineId) {
      throw new PurchaseWorkspaceError("PURCHASE_RFQ_SOURCE_CONFLICT", "An RFQ source link has conflicting purchase or quote identities. Review the recorded conversion.", 422);
    }
    const { linkedPurchaseOrderId, actualPurchaseOrderId, quoteRfqId, quoteRfqLineId, ...source } = row;
    return purchaseRfqOriginSchema.parse(dateValues(source, ["linkedAt"]));
  });
}
