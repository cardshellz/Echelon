import { sql } from "drizzle-orm";
import { allocationExceptions } from "@shared/schema";

type SqlExecutor = { execute: (...args: any[]) => any };
type DrizzleInsertExecutor = { insert: (...args: any[]) => any };
type PgTextQueryClient = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export async function insertPickerObservationReviewAllocationExceptionInWms(
  client: PgTextQueryClient,
  input: {
    targetVariantId: number;
    requestedQty: number;
    selectedLocationId: number;
    resolution: string;
    reviewReason: string;
    metadataJson: string;
    occurredAt: Date;
    orderItemId: number;
    orderId: number;
  },
): Promise<{ rows: Array<{ id?: unknown }> }> {
  return client.query(
    `INSERT INTO wms.allocation_exceptions (
       order_id, order_item_id, order_number, sku, product_variant_id,
       exception_type, status, requested_qty, selected_location_id,
       selected_location_code, resolution, auto_fixed_setup, review_reason, metadata,
       created_at, updated_at
     )
     SELECT item.order_id, item.id, order_row.order_number, item.sku, $1,
            'inventory_auto_resolved', 'needs_review', $2, $3,
            location.code, $4, false, $5, $6::jsonb, $7, $7
     FROM wms.order_items AS item
     JOIN wms.orders AS order_row ON order_row.id = item.order_id
     JOIN warehouse.warehouse_locations AS location ON location.id = $3
     WHERE item.id = $8 AND item.order_id = $9
     RETURNING id`,
    [
      input.targetVariantId,
      input.requestedQty,
      input.selectedLocationId,
      input.resolution,
      input.reviewReason,
      input.metadataJson,
      input.occurredAt,
      input.orderItemId,
      input.orderId,
    ],
  );
}

export async function cancelOrderBlockingAllocationExceptionsOnStatusCancelInWms(
  executor: SqlExecutor,
  orderId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.allocation_exceptions
    SET
      status = 'cancelled',
      resolution = 'order_cancelled_status_update',
      resolved_at = NOW(),
      updated_at = NOW(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'closedBy', 'orders_storage',
        'closedByOrderStatus', 'cancelled',
        'closedAt', NOW()
      )
    WHERE order_id = ${orderId}
      AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
      AND (
        status = 'blocked'
        OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
      )
  `);
}

export async function updateDuplicateBlockingAllocationExceptionInWms(
  executor: SqlExecutor,
  input: {
    exceptionId: number;
    requestedQty: number;
    mergedMetadataJson: string;
    now: Date;
  },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.allocation_exceptions
    SET
      requested_qty = ${input.requestedQty},
      metadata = ${input.mergedMetadataJson}::jsonb,
      updated_at = ${input.now}
    WHERE id = ${input.exceptionId}
    RETURNING *
  `);
}

export async function supersedePriorBlockingAllocationExceptionsInWms(
  executor: SqlExecutor,
  params: {
    orderItemId: number;
    exceptionType: string;
    now: Date;
  },
): Promise<void> {
  const { now } = params;
  await executor.execute(sql`
    UPDATE wms.allocation_exceptions
    SET
      status = 'cancelled',
      resolution = 'superseded_by_new_blocker',
      resolved_at = ${now},
      updated_at = ${now},
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'supersededBy', 'newer_blocking_exception',
        'supersededAt', ${now}::timestamptz,
        'supersededExceptionType', ${params.exceptionType}::text
      )
    WHERE order_item_id = ${params.orderItemId}
      AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
      AND (
        status = 'blocked'
        OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
      )
  `);
}

export async function insertWmsAllocationExceptionReturningInWms(
  client: DrizzleInsertExecutor,
  values: typeof allocationExceptions.$inferInsert,
  options?: { onConflictDoNothing?: boolean },
): Promise<Array<typeof allocationExceptions.$inferSelect>> {
  const query = client.insert(allocationExceptions).values(values);
  if (options?.onConflictDoNothing) {
    return query.onConflictDoNothing().returning();
  }
  return query.returning();
}

export async function closeOrderShipmentBlockingAllocationExceptionsInWms(
  executor: SqlExecutor,
  input: {
    orderId: number;
    closedStatus: string;
    resolutionLabel: string;
    resolvedBy: string | null;
  },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.allocation_exceptions
    SET
      status = ${input.closedStatus},
      resolution = ${input.resolutionLabel},
      resolved_by = ${input.resolvedBy},
      resolved_at = NOW(),
      updated_at = NOW()
    WHERE order_id = ${input.orderId}
      AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
      AND (
        status = 'blocked'
        OR COALESCE(metadata->>'shipmentBlocking', 'false') = 'true'
      )
    RETURNING id
  `);
}
