import { sql } from "drizzle-orm";
import { z } from "zod";
import { linkedRfqPurchaseSchema, type LinkedRfqPurchase } from "./domain/rfq-sourcing-reservation";
import { RfqEvidenceIntegrityError, type RfqWorkflowExecutor } from "./rfq-workflow.repository";

export async function loadLinkedRfqPurchases(executor: RfqWorkflowExecutor, rfqLineIds: number[]): Promise<Map<number, LinkedRfqPurchase>> {
  if (rfqLineIds.length === 0) return new Map();
  const rows = await executor.execute(sql`
    SELECT l.rfq_line_id, p.id AS purchase_order_id, p.status, pl.status AS line_status,
      pl.order_qty, COALESCE(pl.received_qty, 0) AS received_qty, COALESCE(pl.cancelled_qty, 0) AS cancelled_qty,
      EXTRACT(EPOCH FROM (GREATEST(p.updated_at, pl.updated_at) AT TIME ZONE 'UTC')) * 1000 AS updated_at_ms
    FROM procurement.rfq_purchase_order_line_links l
    JOIN procurement.purchase_orders p ON p.id = l.purchase_order_id
    JOIN procurement.purchase_order_lines pl ON pl.id = l.purchase_order_line_id AND pl.purchase_order_id = p.id
    WHERE l.rfq_line_id = ANY(${sql.param(rfqLineIds)}::integer[])`);
  const purchases = new Map<number, LinkedRfqPurchase>();
  for (const row of rows.rows) {
    const parsed = linkedRfqPurchaseSchema.safeParse({
      rfqLineId: Number(row.rfq_line_id), purchaseOrderId: Number(row.purchase_order_id), status: row.status, lineStatus: row.line_status,
      orderQty: Number(row.order_qty), receivedQty: Number(row.received_qty), cancelledQty: Number(row.cancelled_qty),
      updatedAt: row.updated_at_ms === null ? null : new Date(Number(row.updated_at_ms)),
    });
    if (!parsed.success || purchases.has(parsed.data.rfqLineId)) throw new RfqEvidenceIntegrityError();
    purchases.set(parsed.data.rfqLineId, parsed.data);
  }
  return purchases;
}

export async function loadRecommendationRunDates(executor: RfqWorkflowExecutor, recommendationIds: number[]): Promise<Map<number, Date>> {
  const rows = await executor.execute(sql`
    SELECT r.id, EXTRACT(EPOCH FROM run.as_of) * 1000 AS as_of_ms
    FROM procurement.purchase_recommendation_lines r JOIN procurement.purchase_recommendation_runs run ON run.id = r.run_id
    WHERE r.id IN (${sql.join(recommendationIds.map((id) => sql`${id}`), sql`, `)})`);
  const dates = new Map<number, Date>();
  for (const row of rows.rows) {
    const id = z.number().int().positive().safe().safeParse(Number(row.id));
    const date = z.date().safeParse(row.as_of_ms === null ? null : new Date(Number(row.as_of_ms)));
    if (!id.success || !date.success) throw new RfqEvidenceIntegrityError();
    dates.set(id.data, date.data);
  }
  if (dates.size !== new Set(recommendationIds).size) throw new RfqEvidenceIntegrityError();
  return dates;
}
