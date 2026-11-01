import type { Pool } from "pg";
import { z } from "zod";
import { orderEditStatusSchema } from "@shared/order-edits/order-edit.contract";
import { orderCancellationDocumentSchema } from "@shared/customer-account/order-cancellation";
import { orderEditSnapshotSchema } from "../../order-edits/application/order-edit-provider.schema";
import { customerAccountProgressScopeSchema, type CustomerAccountCancellationRefundReader } from "../application/customer-account-progress.ports";
import { presentCancellationRefundProgress } from "../domain/cancellation-refund-progress";
import type { CustomerOrderProgress } from "@shared/customer-account/order-progress";
import { CANCELLATION_REFUND_PROGRESS_KEY_PREFIX } from "@shared/customer-account/order-progress";

const documentSchema = z.object({
  id: z.string().uuid(), kind: z.literal("cancel_order"), status: orderEditStatusSchema,
  omsOrderId: z.number().int().positive().safe(), connectionId: z.number().int().positive().safe(),
  commitStartedAt: z.string().datetime(), cancellation: orderCancellationDocumentSchema,
  baseline: orderEditSnapshotSchema, lastSnapshot: orderEditSnapshotSchema.nullable(),
});
const rowSchema = z.object({ omsOrderId: z.coerce.number().int().positive().safe(), externalOrderId: z.string(),
  connectionId: z.coerce.number().int().positive().safe(), operationId: z.string().uuid(), status: orderEditStatusSchema,
  observedAt: z.coerce.date(), document: documentSchema });

/** Local, read-only active cancellation receipts. Completed payments are already
 * presented by the native financial summary. The existing active-operation
 * unique index makes this a lookup rather than a scan of financial history.
 * Paired purchase/customer ownership
 * is checked at read time; no provider, refund, rewards or hold command exists. */
export class PostgresCancellationRefundProgressReader implements CustomerAccountCancellationRefundReader {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async read(raw: Parameters<CustomerAccountCancellationRefundReader["read"]>[0], now: Date) {
    const scope = customerAccountProgressScopeSchema.parse(raw); z.date().parse(now);
    const result = new Map<number, CustomerOrderProgress["refunds"]>(scope.orders.map(order => [order.omsOrderId, []]));
    if (!scope.orders.length) return result;
    const rows = await this.pool.query(`SELECT o.id AS "omsOrderId",expected."externalOrderId",op.connection_id AS "connectionId",
      op.id AS "operationId",op.status,op.updated_at AS "observedAt",op.document FROM oms.oms_orders o
      JOIN jsonb_to_recordset($3::jsonb) expected("omsOrderId" bigint,"externalOrderId" text)
        ON expected."omsOrderId"=o.id AND replace(o.external_order_id,'gid://shopify/Order/','')=expected."externalOrderId"
      JOIN LATERAL (SELECT p.* FROM oms.order_edit_operations p
        JOIN channels.channel_connections cc ON cc.id=p.connection_id AND cc.channel_id=o.channel_id
        WHERE p.oms_order_id=o.id AND p.document->>'kind'='cancel_order' AND p.document->>'commitStartedAt' IS NOT NULL
        AND p.status NOT IN ('completed','recovered','failed','expired')
        ORDER BY p.created_at DESC,p.id DESC LIMIT 1) op ON true
      WHERE o.channel_id=$1 AND o.external_customer_id=$2 ORDER BY o.id`,
    [scope.channelId, scope.externalCustomerId, JSON.stringify(scope.orders)]);
    for (const row of z.array(rowSchema).max(scope.orders.length).parse(rows.rows)) {
      const doc = row.document;
      const identity = (snapshot: z.infer<typeof orderEditSnapshotSchema>) => snapshot.channelId === scope.channelId && snapshot.connectionId === row.connectionId
        && snapshot.orderId === `gid://shopify/Order/${row.externalOrderId}`
        && snapshot.customerId === `gid://shopify/Customer/${scope.externalCustomerId}`;
      if (row.observedAt > now || doc.status !== row.status || doc.id !== row.operationId || doc.omsOrderId !== row.omsOrderId || doc.connectionId !== row.connectionId
        || !identity(doc.baseline) || (doc.lastSnapshot && !identity(doc.lastSnapshot)))
        throw new Error("Cancellation progress identity mismatch.");
      // Rejected/unsubmitted cancellations cannot promise a refund.
      if (["failed", "expired", "recovered"].includes(doc.status) || !doc.lastSnapshot?.cancelled) continue;
      result.set(row.omsOrderId, [{ key: `${CANCELLATION_REFUND_PROGRESS_KEY_PREFIX}${doc.id}`, reference: "Order cancellation",
        status: presentCancellationRefundProgress(doc.baseline, doc.lastSnapshot, doc.cancellation.refundCents) }]);
    }
    return result;
  }
}
