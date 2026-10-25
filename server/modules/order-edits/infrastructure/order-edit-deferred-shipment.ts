import type { PoolClient } from "pg";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { appendOrderEditAuditSql } from "./order-edit-audit.writer";
import { proveStoppedRefundEditRecovery } from "./order-edit-refund-warehouse-evidence";
import { orderEditSnapshotSchema } from "../application/order-edit-provider.schema";
import { OrderEditError } from "../domain/order-edit-error";
import { PgDialect } from "drizzle-orm/pg-core";
import { wmsOmsOrderIdSql } from "../../oms/oms-wms-order-link.sql";

export const DEFERRED_REFUND_SHIPMENT_ACTION =
  "stopped_refund_new_shipment_deferred";
const positiveId = z.number().int().positive().safe();
const boundOmsOrderId = wmsOmsOrderIdSql({
  source: sql`wo.source`,
  omsFulfillmentOrderId: sql`wo.oms_fulfillment_order_id`,
  legacySourceTableId: sql`wo.source_table_id`,
});
const binding = new PgDialect().sqlToQuery(boundOmsOrderId).sql;

/** Called only in the transaction that CREATED the shipment while the owned
 * edit hold was already locked. Ordinary pushes cannot pass that hold. The
 * immutable receipt proves provider absence, unlike a missing local ID alone. */
export async function registerStoppedRefundDeferredShipment(
  tx: { execute(statement: SQL): Promise<{ rows: unknown[] }> },
  input: {
    omsOrderId: number;
    wmsOrderId: number;
    shipmentId: number;
    operationId: string;
    now: Date;
  },
): Promise<void> {
  z.object({
    omsOrderId: positiveId,
    wmsOrderId: positiveId,
    shipmentId: positiveId,
    operationId: z.string().uuid(),
    now: z.date(),
  })
    .strict()
    .parse(input);
  const result =
    await tx.execute(sql`SELECT op.document FROM oms.order_edit_operations op
    JOIN oms.oms_orders source ON source.id=op.oms_order_id
    JOIN wms.orders wo ON wo.id=${input.wmsOrderId} AND wo.order_edit_operation_id=op.id
    JOIN wms.outbound_shipments shipment ON shipment.id=${input.shipmentId} AND shipment.order_id=wo.id
    WHERE op.id=${input.operationId}::uuid AND op.oms_order_id=${input.omsOrderId} AND op.status='synchronizing'
      AND ${boundOmsOrderId}=op.oms_order_id
      AND source.cancelled_at IS NULL AND source.status NOT IN ('cancelled','refunded')
      AND source.channel_id=(op.document->'lastSnapshot'->>'channelId')::integer
      AND split_part(source.external_order_id,'/',-1)=split_part(op.document->'lastSnapshot'->>'orderId','/',-1)
      AND shipment.status='planned' AND shipment.shipstation_order_id IS NULL AND shipment.engine_order_ref IS NULL
      AND shipment.shipping_engine IS NULL AND shipment.requires_review=false
      AND EXISTS(SELECT 1 FROM oms.order_edit_events event WHERE event.operation_id=op.id
        AND event.action='stopped_refund_warehouse_restored'
        AND event.after_state->'restoredOrderIds' @> ${JSON.stringify([input.wmsOrderId])}::jsonb)
    FOR UPDATE OF op`);
  if (result.rows.length !== 1)
    throw new OrderEditError(
      "ORDER_EDIT_DEFERRED_SHIPMENT_UNPROVEN",
      "The new shipment does not belong to verified stopped-refund recovery.",
    );
  const document = z
    .object({ document: z.unknown() })
    .parse(result.rows[0]).document;
  const snapshot = orderEditSnapshotSchema.parse(
    z.object({ lastSnapshot: z.unknown() }).parse(document).lastSnapshot,
  );
  const proof = proveStoppedRefundEditRecovery({
    operationId: input.operationId,
    omsOrderId: input.omsOrderId,
    document,
    snapshot,
  });
  await appendOrderEditAuditSql(tx, {
    operationId: input.operationId,
    connectionId: proof.connectionId,
    actorId: proof.actorId,
    action: DEFERRED_REFUND_SHIPMENT_ACTION,
    before: null,
    after: {
      shipmentId: input.shipmentId,
      wmsOrderId: input.wmsOrderId,
      sourceFingerprint: snapshot.fingerprint,
      providerNeverSubmitted: true,
    },
    occurredAt: input.now,
  });
}

/** Never infer provider absence from NULL identity. Only the immutable birth
 * receipt and the still-owned, entirely unsubmitted shipment can defer push. */
export async function readDeferredRefundShipmentIds(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<number[]> {
  z.string().uuid().parse(operationId);
  const result = await client.query(
    `SELECT DISTINCT shipment.id FROM oms.order_edit_events event
    JOIN oms.order_edit_operations op ON op.id=event.operation_id
    JOIN wms.outbound_shipments shipment ON shipment.id=(event.after_state->>'shipmentId')::integer
    JOIN wms.orders wo ON wo.id=shipment.order_id
    WHERE event.operation_id=$1 AND event.action=$2 AND wo.order_edit_operation_id=op.id
      AND ${binding}=op.oms_order_id
      AND op.status='synchronizing' AND op.document->>'refundStartedAt' IS NOT NULL
      AND shipment.status='planned' AND shipment.shipstation_order_id IS NULL AND shipment.engine_order_ref IS NULL
      AND shipment.shipping_engine IS NULL AND shipment.requires_review=false
      AND shipment.tracking_number IS NULL AND shipment.shipped_at IS NULL
      AND event.after_state->>'providerNeverSubmitted'='true' ORDER BY shipment.id`,
    [operationId, DEFERRED_REFUND_SHIPMENT_ACTION],
  );
  return z
    .array(z.object({ id: positiveId }))
    .parse(result.rows)
    .map((row) => row.id);
}
