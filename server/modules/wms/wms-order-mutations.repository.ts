import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { orders, type Order } from "@shared/schema";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import {
  allowedWmsOrderFromStatuses,
  isTerminalWmsOrderStatus,
} from "./wms-order-status-core";

type SqlExecutor = { execute: (...args: any[]) => any };
type DrizzleUpdateExecutor = { update: (...args: any[]) => any };
export type NonStatusWmsOrderUpdates = Omit<Partial<typeof orders.$inferInsert>, "warehouseStatus">;

function stripWarehouseStatusField(
  updates: NonStatusWmsOrderUpdates,
): NonStatusWmsOrderUpdates {
  const { warehouseStatus: _omitted, ...safe } = updates as Record<string, unknown>;
  return safe as NonStatusWmsOrderUpdates;
}

export async function clearWmsOrderAssignedPickerInWms(
  executor: SqlExecutor,
  orderId: number,
): Promise<void> {
  await executor.execute(
    sql`UPDATE wms.orders SET assigned_picker_id = NULL WHERE id = ${orderId}`,
  );
}

export async function syncWmsOrderAddressAndFinancialFromShopifyWebhookInWms(
  executor: SqlExecutor,
  input: {
    omsOrderIdText: string;
    shippingName: string | null;
    shippingCompany: string | null;
    shippingAddress: string | null;
    shippingAddress2: string | null;
    shippingCity: string | null;
    shippingState: string | null;
    shippingPostalCode: string | null;
    shippingCountry: string | null;
    financialStatus: string;
    isPaidNow: boolean;
    customerName: string | null;
    customerEmail: string | null;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders SET
      shipping_name = ${input.shippingName},
      shipping_company = ${input.shippingCompany},
      shipping_address = ${input.shippingAddress},
      shipping_address2 = ${input.shippingAddress2},
      shipping_city = ${input.shippingCity},
      shipping_state = ${input.shippingState},
      shipping_postal_code = ${input.shippingPostalCode},
      shipping_country = ${input.shippingCountry},
      financial_status = ${input.financialStatus},
      warehouse_status = CASE
        WHEN warehouse_status = 'pending' AND ${input.isPaidNow} THEN 'ready'
        ELSE warehouse_status
      END,
      customer_name = ${input.customerName},
      customer_email = ${input.customerEmail}
    WHERE (source = 'oms' AND oms_fulfillment_order_id = ${input.omsOrderIdText})
       OR (source = 'shopify' AND source_table_id = ${input.omsOrderIdText})
  `);
}

export async function refreshWmsOrderItemAggregateCountsOnRefundInWms(
  executor: SqlExecutor,
  input: { wmsOrderId: number; now: Date },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders o
    SET item_count = agg.item_count,
        unit_count = agg.unit_count,
        picked_count = agg.picked_count,
        updated_at = ${input.now}
    FROM (
      SELECT
        order_id,
        COUNT(*)::int AS item_count,
        COALESCE(SUM(quantity), 0)::int AS unit_count,
        COALESCE(SUM(CASE WHEN requires_shipping <> 0 THEN picked_quantity ELSE 0 END), 0)::int AS picked_count
      FROM wms.order_items
      WHERE order_id = ${input.wmsOrderId}
      GROUP BY order_id
    ) agg
    WHERE o.id = agg.order_id
  `);
}

export async function updateWmsOrderSlaAndPromotionInWms(
  client: DrizzleUpdateExecutor,
  wmsOrderId: number,
  updates: {
    promoted: boolean;
    channelShipByDate: Date | null;
    slaDueAt: Date | null;
    slaStatus: string | null;
    sortRank: string;
    updatedAt?: Date;
  },
): Promise<void> {
  await client
    .update(orders)
    .set({
      ...(updates.promoted ? { warehouseStatus: "ready" } : {}),
      channelShipByDate: updates.channelShipByDate,
      slaDueAt: updates.slaDueAt,
      slaStatus: updates.slaStatus,
      sortRank: updates.sortRank,
      updatedAt: updates.updatedAt ?? new Date(),
    })
    .where(
      updates.promoted
        ? and(eq(orders.id, wmsOrderId), eq(orders.warehouseStatus, "pending"))
        : eq(orders.id, wmsOrderId),
    );
}

export async function recomputeWmsOrderStatusAndCountsAfterLineSyncInWms(
  executor: SqlExecutor,
  wmsOrderId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders w
       SET warehouse_status = CASE
             WHEN w.warehouse_status IN ('cancelled', 'pending', 'awaiting_3pl')
               THEN w.warehouse_status
             WHEN EXISTS (
               SELECT 1
               FROM wms.order_items pending_items
               WHERE pending_items.order_id = w.id
                 AND COALESCE(pending_items.requires_shipping, 1) <> 0
                 AND COALESCE(pending_items.quantity, 0) > 0
                 AND COALESCE(pending_items.quantity, 0) > COALESCE(pending_items.fulfilled_quantity, 0)
                 AND pending_items.status NOT IN ('cancelled', 'completed')
             ) THEN 'ready'
             WHEN w.warehouse_status <> 'shipped' AND (
               SELECT COUNT(*) FROM wms.order_items all_items
               WHERE all_items.order_id = w.id
             ) = 0 THEN 'cancelled'
             -- Anything else means the order has lines but none of them are
             -- pickable right now. That is not evidence of completion, and
             -- this rollup has none: it cannot see picks or shipments, and it
             -- never stamps completed_at.
             ELSE w.warehouse_status
           END,
           item_count = agg.item_count,
           unit_count = agg.unit_count,
           picked_count = agg.picked_count,
           updated_at = NOW()
      FROM (
        SELECT
          order_id,
          COUNT(*)::int AS item_count,
          COALESCE(SUM(quantity), 0)::int AS unit_count,
          COALESCE(SUM(picked_quantity), 0)::int AS picked_count
        FROM wms.order_items
        WHERE order_id = ${wmsOrderId}
        GROUP BY order_id
      ) agg
     WHERE w.id = agg.order_id
  `);
}

export async function updateWmsOrderAggregateCountsInWms(
  executor: SqlExecutor,
  input: {
    wmsOrderId: number;
    itemCount: number;
    unitCount: number;
    pickedCount: number;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders SET
      item_count = ${input.itemCount},
      unit_count = ${input.unitCount},
      picked_count = ${input.pickedCount},
      updated_at = NOW()
    WHERE id = ${input.wmsOrderId}
  `);
}

export async function updateWmsOrderCombinedGroupByIdInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  updates: { combinedGroupId?: number | null; combinedRole?: string | null },
): Promise<void> {
  await client
    .update(orders)
    .set(updates)
    .where(eq(orders.id, orderId));
}

export async function dissolveWmsOrderCombinedGroupInWms(
  client: DrizzleUpdateExecutor,
  groupId: number,
): Promise<void> {
  await client
    .update(orders)
    .set({ combinedGroupId: null, combinedRole: null })
    .where(eq(orders.combinedGroupId, groupId));
}

export async function updateWmsOrdersWarehouseStatusByCombinedGroupInWms(
  client: DrizzleUpdateExecutor,
  groupId: number,
  warehouseStatus: WmsWarehouseStatus,
): Promise<void> {
  const legalFrom = allowedWmsOrderFromStatuses(warehouseStatus);
  if (legalFrom.length === 0) return;
  const now = new Date();
  await client
    .update(orders)
    .set({
      warehouseStatus,
      updatedAt: now,
      ...(warehouseStatus === "shipped" ? { completedAt: now } : {}),
    })
    .where(
      and(
        eq(orders.combinedGroupId, groupId),
        inArray(orders.warehouseStatus, legalFrom),
      ),
    );
}

export async function updateWmsOrderByIdInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  updates: NonStatusWmsOrderUpdates,
): Promise<void> {
  const safeUpdates = stripWarehouseStatusField(updates);
  if (Object.keys(safeUpdates).length === 0) return;
  await client
    .update(orders)
    .set(safeUpdates)
    .where(eq(orders.id, orderId));
}

export async function updateWmsOrderByIdReturningInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  updates: NonStatusWmsOrderUpdates,
): Promise<Order[]> {
  const safeUpdates = stripWarehouseStatusField(updates);
  if (Object.keys(safeUpdates).length === 0) return [];
  return client
    .update(orders)
    .set(safeUpdates)
    .where(eq(orders.id, orderId))
    .returning();
}

export async function updateActiveWmsOrderFieldsReturningInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  updates: NonStatusWmsOrderUpdates,
): Promise<Order[]> {
  const safeUpdates = stripWarehouseStatusField(updates);
  if (Object.keys(safeUpdates).length === 0) return [];
  return client
    .update(orders)
    .set(safeUpdates)
    .where(and(eq(orders.id, orderId), notInArray(orders.warehouseStatus, ["shipped", "cancelled"])))
    .returning();
}

export async function transitionWmsOrderStatusByMatrixReturningInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  targetStatus: WmsWarehouseStatus,
  extraUpdates: NonStatusWmsOrderUpdates = {},
): Promise<Order[]> {
  const matrixFrom = allowedWmsOrderFromStatuses(targetStatus);
  const legalStates: string[] = isTerminalWmsOrderStatus(targetStatus)
    ? [...matrixFrom]
    : Array.from(
        new Set([
          ...matrixFrom,
          targetStatus,
          ...(targetStatus === "ready" ? ["pending"] : []),
        ]),
      );
  if (legalStates.length === 0) return [];
  const safeExtra = stripWarehouseStatusField(extraUpdates);
  return client
    .update(orders)
    .set({
      ...safeExtra,
      warehouseStatus: targetStatus,
    })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.warehouseStatus, legalStates),
      ),
    )
    .returning();
}

export async function releaseLockedPickingAssignmentInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
): Promise<Order[]> {
  return client
    .update(orders)
    .set({
      warehouseStatus: "ready",
      assignedPickerId: null,
      startedAt: null,
    })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.warehouseStatus, "in_progress"),
      ),
    )
    .returning();
}

export async function assignWmsOrderToWarehouseInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  input: {
    warehouseId: number;
    routeTo3pl: boolean;
    updatedAt?: Date;
  },
): Promise<void> {
  const now = input.updatedAt ?? new Date();
  if (!input.routeTo3pl) {
    await client
      .update(orders)
      .set({ warehouseId: input.warehouseId, updatedAt: now })
      .where(eq(orders.id, orderId));
    return;
  }
  const legalFor3pl = [
    ...allowedWmsOrderFromStatuses("awaiting_3pl"),
    "pending",
    "awaiting_3pl",
  ];
  await client
    .update(orders)
    .set({
      warehouseId: input.warehouseId,
      warehouseStatus: "awaiting_3pl",
      updatedAt: now,
    })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.warehouseStatus, legalFor3pl),
      ),
    );
}

export async function claimWmsOrderForPickerInWms(
  client: DrizzleUpdateExecutor,
  orderId: number,
  pickerId: string,
  startedAt: Date = new Date(),
): Promise<Order[]> {
  return client
    .update(orders)
    .set({
      warehouseStatus: "in_progress",
      assignedPickerId: pickerId,
      startedAt,
    })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.onHold, 0),
        isNull(orders.orderEditOperationId),
        inArray(orders.warehouseStatus, [
          "ready",
          "partially_shipped",
          "ready_to_ship",
          "in_progress",
        ]),
        or(
          ne(orders.warehouseStatus, "in_progress"),
          isNull(orders.assignedPickerId),
          eq(orders.assignedPickerId, pickerId),
        ),
      ),
    )
    .returning();
}

export async function restoreStoppedRefundEditWmsOrderInWms(
  client: Pick<PoolClient, "query">,
  input: { orderId: number; omsOrderId: number; operationId: string; now: Date },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE wms.orders wo SET warehouse_status='ready',cancelled_at=NULL,updated_at=$4
    WHERE wo.id=$1 AND wo.warehouse_status='cancelled' AND wo.order_edit_operation_id=$2
      AND wo.assigned_picker_id IS NULL AND wo.started_at IS NULL AND wo.picked_count=0 AND wo.combined_group_id IS NULL
      AND EXISTS(SELECT 1 FROM oms.order_edit_operations op JOIN oms.oms_orders source ON source.id=op.oms_order_id
        WHERE op.id=$2 AND op.oms_order_id=$3 AND op.status='synchronizing'
          AND op.document->>'refundStartedAt' IS NOT NULL AND op.document->'refundIntent'->>'operationId'=$2::text
          AND source.status<>'cancelled' AND source.cancelled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM wms.order_items oi WHERE oi.order_id=wo.id
        AND (oi.picked_quantity<>0 OR oi.fulfilled_quantity<>0 OR oi.status<>'cancelled' OR oi.quantity<>0))
      AND NOT EXISTS(SELECT 1 FROM wms.outbound_shipments shipment WHERE shipment.order_id=wo.id
        AND (shipment.status NOT IN ('cancelled','voided','planned','queued','on_hold')
          OR shipment.tracking_number IS NOT NULL OR shipment.shipped_at IS NOT NULL))
    RETURNING wo.id`,
    [input.orderId, input.operationId, input.omsOrderId, input.now],
  );
  return result.rows.length === 1;
}

export async function executeGuardedWmsOrderStatusTransitionInWms(
  executor: SqlExecutor,
  input: {
    orderId: number;
    fromListRaw: string;
    to: WmsWarehouseStatus;
    now: Date;
    setCompletedAt?: boolean;
    setCancelledAt?: boolean;
    requireNoOrderEdit?: boolean;
  },
): Promise<any> {
  return executor.execute(sql`
    WITH prior AS (
      SELECT id, warehouse_status
      FROM wms.orders
      WHERE id = ${input.orderId}
        AND warehouse_status IN (${sql.raw(input.fromListRaw)})
        ${input.requireNoOrderEdit ? sql`AND order_edit_operation_id IS NULL` : sql``}
      FOR UPDATE
    )
    UPDATE wms.orders AS o
    SET warehouse_status = ${input.to},
        updated_at = ${input.now}
        ${input.setCompletedAt ? sql`, completed_at = ${input.now}` : sql``}
        ${input.setCancelledAt ? sql`, cancelled_at = COALESCE(o.cancelled_at, ${input.now})` : sql``}
    FROM prior
    WHERE o.id = prior.id
    RETURNING prior.warehouse_status AS previous_status, o.warehouse_status AS new_status
  `);
}

export async function syncWmsOrdersCompletedFromFulfilledOmsInWms(
  executor: SqlExecutor,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders o SET
      warehouse_status = 'completed',
      completed_at = COALESCE(o.completed_at, NOW()),
      updated_at = NOW()
    FROM oms.oms_orders oms
    WHERE o.order_number = oms.external_order_number
      AND (oms.fulfillment_status = 'fulfilled' OR oms.status = 'shipped')
      AND o.warehouse_status NOT IN ('completed', 'shipped', 'cancelled')
      AND o.order_edit_operation_id IS NULL
  `);
}

export async function backfillWmsOrdersAddressBatchFromOmsInWms(
  executor: SqlExecutor,
  batch: Array<{ id: number; oms_order_id: number; country: string | null }>,
): Promise<{ rowCount?: number | null }> {
  return executor.execute(sql`
    UPDATE wms.orders o SET
      customer_name = COALESCE(oms.customer_name, oms.ship_to_name, o.customer_name),
      customer_email = COALESCE(oms.customer_email, o.customer_email),
      shipping_address = COALESCE(oms.ship_to_address1, o.shipping_address),
      shipping_city = COALESCE(oms.ship_to_city, o.shipping_city),
      shipping_state = COALESCE(oms.ship_to_state, o.shipping_state),
      shipping_postal_code = COALESCE(oms.ship_to_zip, o.shipping_postal_code),
      shipping_country = normalized.country
    FROM oms.oms_orders oms,
      (VALUES ${sql.join(batch.map((row) => sql`(${row.id}::integer, ${row.oms_order_id}::integer, ${row.country}::text)`), sql`, `)})
      AS normalized(order_id, oms_order_id, country)
    WHERE o.id = normalized.order_id AND oms.id = normalized.oms_order_id
      AND o.channel_id = oms.channel_id
  `);
}

export async function releaseWmsOrderHoldIfHeldInWms(
  executor: SqlExecutor,
  orderId: number,
): Promise<void> {
  await executor.execute(sql`UPDATE wms.orders SET on_hold = 0, held_at = NULL
    WHERE id = ${orderId} AND on_hold = 1`);
}

export async function applyWmsOrderShippingRollupStatusInWms(
  executor: SqlExecutor,
  input: {
    wmsOrderId: number;
    derived: string;
    now: Date;
    stampCompletedAt: boolean;
  },
): Promise<void> {
  if (input.stampCompletedAt) {
    await executor.execute(sql`
      WITH updated_order AS (
        UPDATE wms.orders SET
          warehouse_status = ${input.derived},
          completed_at = ${input.now},
          updated_at = ${input.now}
        WHERE id = ${input.wmsOrderId}
          AND (warehouse_status NOT IN ('shipped', 'cancelled') OR ${input.derived}::text = 'shipped')
        RETURNING id
      ),
      closed_blockers AS (
        UPDATE wms.allocation_exceptions
        SET
          status = CASE WHEN ${input.derived}::text = 'cancelled' THEN 'cancelled' ELSE 'resolved' END,
          resolution = CONCAT('order_', ${input.derived}::text, '_shipment_rollup'),
          resolved_at = ${input.now},
          updated_at = ${input.now},
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'closedBy', 'shipment_rollup',
            'closedByOrderStatus', ${input.derived}::text,
            'closedAt', ${input.now}::timestamptz
          )
        WHERE order_id = ${input.wmsOrderId}
          AND ${input.derived}::text IN ('shipped', 'cancelled')
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            status = 'blocked'
            OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
          )
        RETURNING id
      )
      SELECT id FROM updated_order
    `);
  } else {
    await executor.execute(sql`
      WITH updated_order AS (
        UPDATE wms.orders SET
          warehouse_status = ${input.derived},
          updated_at = ${input.now}
        WHERE id = ${input.wmsOrderId}
          AND (warehouse_status NOT IN ('shipped', 'cancelled') OR ${input.derived}::text = 'shipped')
        RETURNING id
      ),
      closed_blockers AS (
        UPDATE wms.allocation_exceptions
        SET
          status = CASE WHEN ${input.derived}::text = 'cancelled' THEN 'cancelled' ELSE 'resolved' END,
          resolution = CONCAT('order_', ${input.derived}::text, '_shipment_rollup'),
          resolved_at = ${input.now},
          updated_at = ${input.now},
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'closedBy', 'shipment_rollup',
            'closedByOrderStatus', ${input.derived}::text,
            'closedAt', ${input.now}::timestamptz
          )
        WHERE order_id = ${input.wmsOrderId}
          AND ${input.derived}::text IN ('shipped', 'cancelled')
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            status = 'blocked'
            OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
          )
        RETURNING id
      )
      SELECT id FROM updated_order
    `);
  }
}

export async function sweepWmsOrderSlaStatusesInWms(
  executor: SqlExecutor,
  now: Date,
  twentyFourHoursFromNow: Date,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.orders SET sla_status = 'met'
    WHERE sla_due_at IS NOT NULL
      AND sla_status NOT IN ('met')
      AND warehouse_status IN ('shipped', 'completed')
      AND (completed_at IS NULL OR completed_at <= sla_due_at)
  `);

  await executor.execute(sql`
    UPDATE wms.orders SET sla_status = 'overdue'
    WHERE sla_due_at IS NOT NULL
      AND sla_status NOT IN ('met', 'overdue')
      AND warehouse_status IN ('shipped', 'completed')
      AND completed_at > sla_due_at
  `);

  await executor.execute(sql`
    UPDATE wms.orders SET sla_status = 'overdue'
    WHERE sla_due_at IS NOT NULL
      AND sla_status NOT IN ('met', 'overdue')
      AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
      AND sla_due_at < ${now}
  `);

  await executor.execute(sql`
    UPDATE wms.orders SET sla_status = 'at_risk'
    WHERE sla_due_at IS NOT NULL
      AND sla_status NOT IN ('met', 'overdue', 'at_risk')
      AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
      AND sla_due_at >= ${now}
      AND sla_due_at < ${twentyFourHoursFromNow}
  `);

  await executor.execute(sql`
    UPDATE wms.orders SET sla_status = 'on_time'
    WHERE sla_due_at IS NOT NULL
      AND sla_status IS DISTINCT FROM 'on_time'
      AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
      AND sla_due_at >= ${twentyFourHoursFromNow}
  `);
}
