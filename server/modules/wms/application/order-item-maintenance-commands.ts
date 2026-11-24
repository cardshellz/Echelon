import { sql } from "drizzle-orm";

import {
  WmsOrderItemCommandError,
  type WmsOrderItemExecutor,
} from "./order-item-commands";

export interface WmsOrderItemMaintenanceQueryExecutor {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      `${field} must be a positive integer`,
      { field, value },
    );
  }
}

function assertPositiveIntegerArray(values: number[], field: string): void {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value <= 0)
  ) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      `${field} must contain positive integers`,
      { field, values },
    );
  }
}

function affectedRowCount(result: { rows?: unknown[]; rowCount?: number | null }): number {
  if (Array.isArray(result.rows)) return result.rows.length;
  return Number(result.rowCount ?? 0);
}

export async function repairDanglingCompletedWmsOrderItems(
  executor: WmsOrderItemExecutor,
): Promise<number> {
  const result = await executor.execute(sql`
    UPDATE wms.order_items
    SET picked_quantity = quantity,
        fulfilled_quantity = quantity
    WHERE status = 'completed'
      AND quantity > 0
      AND picked_quantity = 0
    RETURNING id
  `);
  return affectedRowCount(result);
}

export async function cancelUnstartedWmsOrderItemsForRetiredOrder(
  executor: WmsOrderItemMaintenanceQueryExecutor,
  orderId: number,
): Promise<number> {
  assertPositiveInteger(orderId, "orderId");
  const result = await executor.query<{ id: number }>(`
    UPDATE wms.order_items
    SET status = 'cancelled'
    WHERE order_id = $1
      AND COALESCE(picked_quantity, 0) = 0
      AND COALESCE(fulfilled_quantity, 0) = 0
      AND status NOT IN ('completed', 'cancelled')
    RETURNING id
  `, [orderId]);
  return affectedRowCount(result);
}

export async function clearHistoricalOrphanOmsLineReferences(
  executor: WmsOrderItemMaintenanceQueryExecutor,
  itemIds: number[],
): Promise<number> {
  assertPositiveIntegerArray(itemIds, "itemIds");
  const result = await executor.query<{ id: number }>(`
    UPDATE wms.order_items oi
       SET oms_order_line_id = NULL
      FROM wms.orders o
     WHERE oi.id = ANY($1::int[])
       AND o.id = oi.order_id
       AND oi.oms_order_line_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM oms.oms_order_lines ol
         WHERE ol.id = oi.oms_order_line_id
       )
       AND (
         o.warehouse_status IN ('shipped', 'completed', 'cancelled')
         OR o.completed_at IS NOT NULL
         OR o.cancelled_at IS NOT NULL
       )
    RETURNING oi.id
  `, [itemIds]);
  return affectedRowCount(result);
}

export async function closeReopenedFullyPickedWmsOrderItems(
  executor: WmsOrderItemMaintenanceQueryExecutor,
  itemIds: number[],
): Promise<number> {
  assertPositiveIntegerArray(itemIds, "itemIds");
  const result = await executor.query<{ id: number }>(`
    UPDATE wms.order_items oi
       SET status = 'completed'
     WHERE oi.id = ANY($1::int[])
       AND COALESCE(oi.requires_shipping, 0) = 1
       AND COALESCE(oi.quantity, 0) > 0
       AND COALESCE(oi.picked_quantity, 0) >= oi.quantity
       AND COALESCE(oi.status, '') IN ('pending', 'in_progress')
    RETURNING oi.id
  `, [itemIds]);
  return affectedRowCount(result);
}

export async function recoverCompletedWmsOrderItemPickState(
  executor: WmsOrderItemMaintenanceQueryExecutor,
  args: {
    itemId: number;
    locationCode: string;
    zone: string | null;
    pickedQuantity: number;
  },
): Promise<number> {
  assertPositiveInteger(args.itemId, "itemId");
  assertPositiveInteger(args.pickedQuantity, "pickedQuantity");
  const locationCode = args.locationCode.trim().toUpperCase();
  if (!locationCode) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "locationCode is required",
      { itemId: args.itemId },
    );
  }

  const result = await executor.query<{ id: number }>(`
    UPDATE wms.order_items
    SET
      location = $1,
      zone = COALESCE($2, 'U'),
      status = 'completed',
      picked_quantity = GREATEST(picked_quantity, $3),
      picked_at = COALESCE(picked_at, NOW())
    WHERE id = $4
    RETURNING id
  `, [locationCode, args.zone, args.pickedQuantity, args.itemId]);
  return affectedRowCount(result);
}

export interface WmsOrderItemBarcodeRepairRow {
  id: number;
  sku: string;
  barcode: string | null;
  order_number: string;
}

export async function repairOpenWmsOrderItemBarcode(
  executor: WmsOrderItemMaintenanceQueryExecutor,
  args: {
    sku: string;
    incorrectBarcode: string;
    correctBarcode: string;
  },
): Promise<WmsOrderItemBarcodeRepairRow[]> {
  const sku = args.sku.trim();
  const incorrectBarcode = args.incorrectBarcode.trim();
  const correctBarcode = args.correctBarcode.trim();
  if (!sku || !incorrectBarcode || !correctBarcode) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "sku, incorrectBarcode, and correctBarcode are required",
      { sku, incorrectBarcode, correctBarcode },
    );
  }

  const result = await executor.query<WmsOrderItemBarcodeRepairRow>(`
    UPDATE wms.order_items oi
    SET barcode = $1
    FROM wms.orders o
    WHERE oi.order_id = o.id
      AND oi.sku = $2
      AND oi.barcode = $3
      AND o.warehouse_status IN ('ready', 'picking', 'in_progress')
    RETURNING oi.id, oi.sku, oi.barcode, o.order_number
  `, [correctBarcode, sku, incorrectBarcode]);
  return result.rows;
}

export async function prepareLegacyWmsOrderItemSchema(
  executor: WmsOrderItemExecutor,
): Promise<void> {
  await executor.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'wms'
          AND table_name = 'order_items'
          AND column_name = 'wms_order_id'
      ) THEN
        ALTER TABLE wms.order_items RENAME COLUMN wms_order_id TO order_id;
      END IF;
    END $$
  `);
  await executor.execute(sql`
    ALTER TABLE wms.order_items
    ADD COLUMN IF NOT EXISTS shopify_line_item_id varchar(50),
    ADD COLUMN IF NOT EXISTS source_item_id varchar(100)
  `);
}

export async function replicateLegacyWmsOrderItems(
  executor: WmsOrderItemExecutor,
): Promise<number> {
  const result = await executor.execute(sql`
    INSERT INTO wms.order_items (
      id,
      order_id,
      product_id,
      sku,
      name,
      image_url,
      barcode,
      quantity,
      picked_quantity,
      fulfilled_quantity,
      status,
      location,
      zone,
      short_reason,
      picked_at,
      requires_shipping,
      shopify_line_item_id,
      source_item_id
    )
    SELECT
      id,
      order_id,
      product_id,
      sku,
      name,
      image_url,
      barcode,
      quantity,
      picked_quantity,
      fulfilled_quantity,
      status,
      location,
      zone,
      short_reason,
      picked_at,
      requires_shipping,
      shopify_line_item_id,
      source_item_id
    FROM public.order_items
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return affectedRowCount(result);
}
