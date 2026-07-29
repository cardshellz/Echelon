import { and, eq, sql } from "drizzle-orm";

import {
  wmsOrderItems,
  type InsertWmsOrderItem,
  type WmsOrderItem,
} from "@shared/schema";
import type { ItemStatus } from "@shared/schema";

import { deriveReconciledWmsOrderItemStatus } from "./wms-line-reconciliation";

export type WmsOrderItemExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
};

export class WmsOrderItemCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WmsOrderItemCommandError";
  }
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

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      `${field} must be a non-negative integer`,
      { field, value },
    );
  }
}

function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function affectedRowCount(result: any): number {
  const returnedRows = rowsOf(result);
  if (returnedRows.length > 0) return returnedRows.length;

  const rowCount = Number(result?.rowCount ?? 0);
  return Number.isInteger(rowCount) && rowCount >= 0 ? rowCount : 0;
}

function validateInsertItem(item: InsertWmsOrderItem): void {
  assertPositiveInteger(Number(item.orderId), "orderId");
  assertNonNegativeInteger(Number(item.quantity), "quantity");
  assertNonNegativeInteger(Number(item.pickedQuantity ?? 0), "pickedQuantity");
  assertNonNegativeInteger(Number(item.fulfilledQuantity ?? 0), "fulfilledQuantity");

  if (!String(item.sku ?? "").trim()) {
    throw new WmsOrderItemCommandError("INVALID_INPUT", "sku is required");
  }
  if (!String(item.name ?? "").trim()) {
    throw new WmsOrderItemCommandError("INVALID_INPUT", "name is required");
  }
  if (Number(item.pickedQuantity ?? 0) > Number(item.quantity)) {
    throw new WmsOrderItemCommandError(
      "PICKED_QUANTITY_EXCEEDS_LINE_QUANTITY",
      "pickedQuantity cannot exceed quantity",
      { pickedQuantity: item.pickedQuantity, quantity: item.quantity },
    );
  }
  if (Number(item.fulfilledQuantity ?? 0) > Number(item.quantity)) {
    throw new WmsOrderItemCommandError(
      "FULFILLED_QUANTITY_EXCEEDS_LINE_QUANTITY",
      "fulfilledQuantity cannot exceed quantity",
      { fulfilledQuantity: item.fulfilledQuantity, quantity: item.quantity },
    );
  }
}

export async function insertWmsOrderItems(
  executor: WmsOrderItemExecutor,
  items: InsertWmsOrderItem[],
): Promise<WmsOrderItem[]> {
  if (items.length === 0) return [];
  for (const item of items) validateInsertItem(item);

  return await executor
    .insert(wmsOrderItems)
    .values(items as any)
    .returning();
}

export async function replaceUnstartedWmsOrderItemsForRepair(
  executor: WmsOrderItemExecutor,
  args: {
    orderId: number;
    items: InsertWmsOrderItem[];
  },
): Promise<WmsOrderItem[]> {
  assertPositiveInteger(args.orderId, "orderId");
  for (const item of args.items) {
    if (Number(item.orderId) !== args.orderId) {
      throw new WmsOrderItemCommandError(
        "ORDER_SCOPE_MISMATCH",
        "Every replacement item must belong to the requested WMS order",
        { orderId: args.orderId, itemOrderId: item.orderId },
      );
    }
    validateInsertItem(item);
  }

  const progress = await executor.execute(sql`
    SELECT
      oi.id,
      oi.picked_quantity,
      oi.fulfilled_quantity,
      EXISTS (
        SELECT 1
        FROM wms.outbound_shipment_items shipment_item
        WHERE shipment_item.order_item_id = oi.id
      ) AS has_shipment_link
    FROM wms.order_items oi
    WHERE oi.order_id = ${args.orderId}
    FOR UPDATE
  `);
  const unsafe = rowsOf<any>(progress).find(
    (row) =>
      Number(row.picked_quantity ?? 0) > 0 ||
      Number(row.fulfilled_quantity ?? 0) > 0 ||
      Boolean(row.has_shipment_link),
  );
  if (unsafe) {
    throw new WmsOrderItemCommandError(
      "DESTRUCTIVE_REPAIR_BLOCKED",
      "Cannot replace WMS order items after physical or shipment progress exists",
      {
        orderId: args.orderId,
        orderItemId: Number(unsafe.id),
        pickedQuantity: Number(unsafe.picked_quantity ?? 0),
        fulfilledQuantity: Number(unsafe.fulfilled_quantity ?? 0),
        hasShipmentLink: Boolean(unsafe.has_shipment_link),
      },
    );
  }

  await executor.delete(wmsOrderItems).where(eq(wmsOrderItems.orderId, args.orderId));
  return insertWmsOrderItems(executor, args.items);
}

export async function reconcileWmsOrderItemAuthority(
  executor: WmsOrderItemExecutor,
  args: {
    itemId: number;
    orderId?: number;
    authorityQuantity: number;
    catalogSnapshot?: {
      sku?: string;
      name?: string;
      productId?: number | null;
      location?: string;
      zone?: string;
    };
  },
): Promise<WmsOrderItem> {
  assertPositiveInteger(args.itemId, "itemId");
  assertNonNegativeInteger(args.authorityQuantity, "authorityQuantity");

  const result = await executor.execute(sql`
    SELECT *
    FROM wms.order_items
    WHERE id = ${args.itemId}
      AND (${args.orderId ?? null}::int IS NULL OR order_id = ${args.orderId ?? null})
    FOR UPDATE
  `);
  const current = rowsOf<any>(result)[0];
  if (!current) {
    throw new WmsOrderItemCommandError(
      "ORDER_ITEM_NOT_FOUND",
      `WMS order item ${args.itemId} was not found`,
      { itemId: args.itemId, orderId: args.orderId },
    );
  }

  const pickedQuantity = Number(current.picked_quantity ?? 0);
  const fulfilledQuantity = Number(current.fulfilled_quantity ?? 0);
  const physicalFloor = Math.max(pickedQuantity, fulfilledQuantity);
  if (args.authorityQuantity < physicalFloor) {
    throw new WmsOrderItemCommandError(
      "AUTHORITY_BELOW_PHYSICAL_PROGRESS",
      "Channel authority cannot reduce a WMS line below picked or fulfilled quantity",
      {
        itemId: args.itemId,
        authorityQuantity: args.authorityQuantity,
        pickedQuantity,
        fulfilledQuantity,
      },
    );
  }

  const status = deriveReconciledWmsOrderItemStatus({
    authorityQuantity: args.authorityQuantity,
    pickedQuantity,
    fulfilledQuantity,
  });
  const patch: Record<string, unknown> = {
    quantity: args.authorityQuantity,
    status,
  };
  const snapshot = args.catalogSnapshot;
  if (snapshot?.sku !== undefined) patch.sku = snapshot.sku;
  if (snapshot?.name !== undefined) patch.name = snapshot.name;
  if (snapshot?.productId !== undefined) patch.productId = snapshot.productId;
  if (snapshot?.location !== undefined) patch.location = snapshot.location;
  if (snapshot?.zone !== undefined) patch.zone = snapshot.zone;

  const [updated] = await executor
    .update(wmsOrderItems)
    .set(patch)
    .where(eq(wmsOrderItems.id, args.itemId))
    .returning();
  return updated;
}

export async function updateWmsOrderItemCatalogSnapshot(
  executor: WmsOrderItemExecutor,
  args: {
    itemId: number;
    sku?: string;
    name?: string;
    productId?: number | null;
    location?: string;
    zone?: string;
  },
): Promise<WmsOrderItem> {
  assertPositiveInteger(args.itemId, "itemId");
  const patch: Record<string, unknown> = {};
  if (args.sku !== undefined) patch.sku = args.sku;
  if (args.name !== undefined) patch.name = args.name;
  if (args.productId !== undefined) patch.productId = args.productId;
  if (args.location !== undefined) patch.location = args.location;
  if (args.zone !== undefined) patch.zone = args.zone;
  if (Object.keys(patch).length === 0) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "Catalog snapshot update requires at least one field",
      { itemId: args.itemId },
    );
  }

  const [updated] = await executor
    .update(wmsOrderItems)
    .set(patch)
    .where(eq(wmsOrderItems.id, args.itemId))
    .returning();
  if (!updated) {
    throw new WmsOrderItemCommandError(
      "ORDER_ITEM_NOT_FOUND",
      `WMS order item ${args.itemId} was not found`,
      { itemId: args.itemId },
    );
  }
  return updated;
}

export async function persistWmsOrderItemPickProgress(
  executor: WmsOrderItemExecutor,
  args: {
    itemId: number;
    status: ItemStatus;
    pickedQuantity?: number;
    shortReason?: string | null;
    pickedAt?: Date | null;
    expectedCurrentStatus?: ItemStatus;
  },
): Promise<WmsOrderItem | null> {
  assertPositiveInteger(args.itemId, "itemId");
  if (args.pickedQuantity !== undefined) {
    assertNonNegativeInteger(args.pickedQuantity, "pickedQuantity");
  }

  const patch: Record<string, unknown> = { status: args.status };
  if (args.pickedQuantity !== undefined) patch.pickedQuantity = args.pickedQuantity;
  if (args.shortReason !== undefined) patch.shortReason = args.shortReason;
  if (args.pickedAt !== undefined) patch.pickedAt = args.pickedAt;

  const condition = args.expectedCurrentStatus
    ? and(
        eq(wmsOrderItems.id, args.itemId),
        eq(wmsOrderItems.status, args.expectedCurrentStatus),
        args.pickedQuantity === undefined
          ? sql`TRUE`
          : sql`${args.pickedQuantity} BETWEEN 0 AND ${wmsOrderItems.quantity}`,
      )
    : and(
        eq(wmsOrderItems.id, args.itemId),
        args.pickedQuantity === undefined
          ? sql`TRUE`
          : sql`${args.pickedQuantity} BETWEEN 0 AND ${wmsOrderItems.quantity}`,
      );

  const [updated] = await executor
    .update(wmsOrderItems)
    .set(patch)
    .where(condition)
    .returning();
  return updated ?? null;
}

export async function setWmsOrderItemLocation(
  executor: WmsOrderItemExecutor,
  args: {
    itemId: number;
    location: string;
    zone: string;
    barcode?: string | null;
    imageUrl?: string | null;
  },
): Promise<WmsOrderItem | null> {
  assertPositiveInteger(args.itemId, "itemId");
  const location = args.location.trim().toUpperCase();
  const zone = args.zone.trim().toUpperCase();
  if (!location || !zone) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "location and zone are required",
      { itemId: args.itemId, location: args.location, zone: args.zone },
    );
  }
  const patch: Record<string, unknown> = { location, zone };
  if (args.barcode !== undefined) patch.barcode = args.barcode;
  if (args.imageUrl !== undefined) patch.imageUrl = args.imageUrl;

  const [updated] = await executor
    .update(wmsOrderItems)
    .set(patch)
    .where(eq(wmsOrderItems.id, args.itemId))
    .returning();
  return updated ?? null;
}

export async function resetUnstartedWmsOrderItems(
  executor: WmsOrderItemExecutor,
  orderId: number,
): Promise<number> {
  assertPositiveInteger(orderId, "orderId");
  const result = await executor
    .update(wmsOrderItems)
    .set({
      status: "pending",
      pickedQuantity: 0,
      shortReason: null,
      pickedAt: null,
    })
    .where(
      and(
        eq(wmsOrderItems.orderId, orderId),
        eq(wmsOrderItems.pickedQuantity, 0),
        eq(wmsOrderItems.fulfilledQuantity, 0),
      ),
    )
    .returning({ id: wmsOrderItems.id });
  return result.length;
}

export async function completePendingNonShippingWmsOrderItems(
  executor: WmsOrderItemExecutor,
  orderId: number,
): Promise<number> {
  assertPositiveInteger(orderId, "orderId");
  const result = await executor
    .update(wmsOrderItems)
    .set({ status: "completed" })
    .where(
      and(
        eq(wmsOrderItems.orderId, orderId),
        eq(wmsOrderItems.requiresShipping, 0),
        eq(wmsOrderItems.status, "pending"),
      ),
    )
    .returning({ id: wmsOrderItems.id });
  return result.length;
}

export async function finalizePhysicallyCompleteWmsOrderItems(
  executor: WmsOrderItemExecutor,
  args: { orderId: number; cancelled: boolean },
): Promise<number> {
  assertPositiveInteger(args.orderId, "orderId");
  const result = await executor.execute(sql`
    UPDATE wms.order_items
    SET status = CASE
      WHEN ${args.cancelled}
       AND COALESCE(picked_quantity, 0) = 0
       AND COALESCE(fulfilled_quantity, 0) = 0
        THEN 'cancelled'
      WHEN COALESCE(requires_shipping, 0) <> 1
        OR COALESCE(picked_quantity, 0) >= quantity
        OR COALESCE(fulfilled_quantity, 0) >= quantity
        THEN 'completed'
      ELSE status
    END
    WHERE order_id = ${args.orderId}
      AND status NOT IN ('completed', 'short', 'cancelled')
    RETURNING id
  `);
  return affectedRowCount(result);
}

export async function setWmsOrderItemHoldState(
  executor: WmsOrderItemExecutor,
  args: { itemId: number; onHold: boolean; reason?: string | null },
): Promise<WmsOrderItem | null> {
  assertPositiveInteger(args.itemId, "itemId");
  const reason = args.onHold ? String(args.reason ?? "").trim().slice(0, 200) : null;
  if (args.onHold && !reason) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "A hold reason is required",
      { itemId: args.itemId },
    );
  }
  const [updated] = await executor
    .update(wmsOrderItems)
    .set({ onHold: args.onHold, holdReason: reason })
    .where(eq(wmsOrderItems.id, args.itemId))
    .returning();
  return updated ?? null;
}

export async function incrementWmsOrderItemFulfilledQuantityByShopifyLineId(
  executor: WmsOrderItemExecutor,
  args: { shopifyLineItemId: string; additionalQuantity: number },
): Promise<WmsOrderItem | null> {
  assertNonNegativeInteger(args.additionalQuantity, "additionalQuantity");
  if (!args.shopifyLineItemId.trim()) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "shopifyLineItemId is required",
    );
  }
  const [updated] = await executor
    .update(wmsOrderItems)
    .set({
      fulfilledQuantity: sql`LEAST(
        ${wmsOrderItems.quantity},
        ${wmsOrderItems.fulfilledQuantity} + ${args.additionalQuantity}
      )`,
    })
    .where(eq(wmsOrderItems.shopifyLineItemId, args.shopifyLineItemId))
    .returning();
  return updated ?? null;
}

export async function refreshWmsOrderItemFinancialSnapshotsFromOms(
  executor: WmsOrderItemExecutor,
  args: { wmsOrderId: number; omsOrderId: number },
): Promise<number> {
  assertPositiveInteger(args.wmsOrderId, "wmsOrderId");
  assertPositiveInteger(args.omsOrderId, "omsOrderId");
  const result = await executor.execute(sql`
    UPDATE wms.order_items oi
       SET unit_price_cents = COALESCE(ol.paid_price_cents, 0),
           paid_price_cents = COALESCE(ol.paid_price_cents, 0),
           total_price_cents = COALESCE(ol.total_price_cents, 0)
      FROM oms.oms_order_lines ol
     WHERE oi.order_id = ${args.wmsOrderId}
       AND oi.oms_order_line_id = ol.id
       AND ol.order_id = ${args.omsOrderId}
    RETURNING oi.id
  `);
  return affectedRowCount(result);
}

export async function syncWmsOrderItemsFulfilledFromOms(
  executor: WmsOrderItemExecutor,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.order_items oi SET
      status = 'completed',
      picked_quantity = oi.quantity,
      fulfilled_quantity = oi.quantity,
      picked_at = COALESCE(oi.picked_at, NOW())
    FROM oms.oms_order_lines ol
    WHERE oi.source_item_id = ol.external_line_item_id
      AND ol.fulfillment_status = 'fulfilled'
      AND (
        oi.status <> 'completed'
        OR oi.picked_quantity <> oi.quantity
        OR oi.fulfilled_quantity <> oi.quantity
      )
  `);

  await executor.execute(sql`
    UPDATE wms.order_items oi SET
      status = 'completed',
      picked_quantity = oi.quantity,
      fulfilled_quantity = oi.quantity,
      picked_at = COALESCE(oi.picked_at, NOW())
    FROM wms.orders o
    INNER JOIN oms.oms_orders oms ON o.order_number = oms.external_order_number
    WHERE oi.order_id = o.id
      AND (oms.fulfillment_status = 'fulfilled' OR oms.status = 'shipped')
      AND (
        oi.status <> 'completed'
        OR oi.picked_quantity <> oi.quantity
        OR oi.fulfilled_quantity <> oi.quantity
      )
  `);
}

export async function renameWmsOrderItemSku(
  executor: WmsOrderItemExecutor,
  args: { oldSku: string; newSku: string },
): Promise<number> {
  const oldSku = args.oldSku.trim();
  const newSku = args.newSku.trim();
  if (!oldSku || !newSku) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "oldSku and newSku are required",
      { oldSku: args.oldSku, newSku: args.newSku },
    );
  }
  const rows = await executor
    .update(wmsOrderItems)
    .set({ sku: newSku })
    .where(eq(wmsOrderItems.sku, oldSku))
    .returning({ id: wmsOrderItems.id });
  return rows.length;
}

export async function repointPendingWmsOrderItemsForInventoryTransfer(
  executor: WmsOrderItemExecutor,
  args: {
    productVariantId: number;
    fromLocationCode: string;
    toLocationCode: string;
    toZone: string;
  },
): Promise<number> {
  assertPositiveInteger(args.productVariantId, "productVariantId");
  const result = await executor.execute(sql`
    UPDATE wms.order_items AS oi
    SET location = ${args.toLocationCode}, zone = ${args.toZone}
    FROM wms.orders o, catalog.product_variants pv
    WHERE oi.order_id = o.id
      AND UPPER(pv.sku) = UPPER(oi.sku)
      AND pv.id = ${args.productVariantId}
      AND UPPER(oi.location) = UPPER(${args.fromLocationCode})
      AND oi.requires_shipping = 1
      AND oi.status = 'pending'
      AND oi.picked_quantity = 0
      AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')
    RETURNING oi.id
  `);
  return affectedRowCount(result);
}

export async function backfillUnassignedWmsOrderItemBin(
  executor: WmsOrderItemExecutor,
  args: { sku: string; locationCode: string; zone: string },
): Promise<number> {
  const result = await executor.execute(sql`
    UPDATE wms.order_items oi
    SET location = ${args.locationCode}, zone = ${args.zone}
    FROM wms.orders o
    WHERE o.id = oi.order_id
      AND (oi.location IS NULL OR oi.location IN ('UNASSIGNED', 'U'))
      AND oi.picked_quantity < oi.quantity
      AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')
      AND UPPER(oi.sku) = UPPER(${args.sku})
    RETURNING oi.id
  `);
  return affectedRowCount(result);
}

export async function deleteDuplicateShopifyWmsOrderItems(
  executor: WmsOrderItemExecutor,
  normalized: boolean,
): Promise<number[]> {
  const result = normalized
    ? await executor.execute(sql`
        DELETE FROM wms.order_items
        WHERE order_id IN (
          SELECT id FROM (
            SELECT
              id,
              REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') AS normalized_id,
              ROW_NUMBER() OVER (
                PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                ORDER BY created_at ASC
              ) AS rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) duplicate_order
          WHERE rn > 1 AND normalized_id <> ''
        )
        RETURNING id
      `)
    : await executor.execute(sql`
        DELETE FROM wms.order_items
        WHERE order_id IN (
          SELECT id FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY shopify_order_id
                ORDER BY created_at ASC
              ) AS rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) duplicate_order
          WHERE rn > 1
        )
        RETURNING id
      `);
  return rowsOf<{ id: number }>(result).map((row) => Number(row.id));
}

export interface LockedRefundWmsOrderItemState {
  id: number;
  orderId: number;
  quantity: number;
  pickedQuantity: number;
  fulfilledQuantity: number;
  status: string;
  shortReason: string | null;
  onHold: boolean;
}

export interface RefundWmsOrderItemTransition {
  item: {
    id: number;
    quantity: number;
    pickedQuantity: number;
    fulfilledQuantity: number;
    status: string;
  };
  manualReviewReason: string | null;
  changed: boolean;
}

/**
 * Applies refund authority to a WMS line whose row was already selected
 * FOR UPDATE by the caller in the same transaction. The lock belongs at the
 * orchestration boundary so authority, WMS state, and shipment reconciliation
 * are based on one consistent snapshot without a second database read.
 */
export async function applyRefundAuthorityToWmsOrderItem(
  executor: WmsOrderItemExecutor,
  args: {
    current: LockedRefundWmsOrderItemState;
    authorityFulfillableQuantity: number;
    restockPolicy: string;
  },
): Promise<RefundWmsOrderItemTransition> {
  const current = args.current;
  assertPositiveInteger(current.id, "current.id");
  assertPositiveInteger(current.orderId, "current.orderId");
  assertNonNegativeInteger(current.quantity, "current.quantity");
  assertNonNegativeInteger(current.pickedQuantity, "current.pickedQuantity");
  assertNonNegativeInteger(current.fulfilledQuantity, "current.fulfilledQuantity");
  assertNonNegativeInteger(
    args.authorityFulfillableQuantity,
    "authorityFulfillableQuantity",
  );
  if (!current.status.trim()) {
    throw new WmsOrderItemCommandError(
      "INVALID_INPUT",
      "current.status is required",
      { itemId: current.id, orderId: current.orderId },
    );
  }

  const physicalFloor = Math.max(current.pickedQuantity, current.fulfilledQuantity);
  const refundAfterPick =
    current.pickedQuantity > args.authorityFulfillableQuantity &&
    current.pickedQuantity > current.fulfilledQuantity;
  const preserveHistoricalQuantity =
    current.status === "completed" || current.status === "short";
  const nextQuantity = preserveHistoricalQuantity
    ? current.quantity
    : Math.max(args.authorityFulfillableQuantity, physicalFloor);
  let nextStatus = current.status;
  let nextShortReason = current.shortReason;
  let nextOnHold = current.onHold;

  if (refundAfterPick) {
    nextStatus = "short";
    nextShortReason = "refund_after_pick";
    nextOnHold = true;
  } else if (current.fulfilledQuantity > args.authorityFulfillableQuantity) {
    nextStatus = "completed";
  } else if (
    args.authorityFulfillableQuantity === 0 &&
    current.pickedQuantity === 0 &&
    current.fulfilledQuantity === 0 &&
    current.status !== "short" &&
    current.status !== "completed"
  ) {
    nextStatus = "cancelled";
  }

  const changed =
    nextQuantity !== current.quantity ||
    nextStatus !== current.status ||
    nextShortReason !== current.shortReason ||
    nextOnHold !== current.onHold;
  if (changed) {
    await executor.execute(sql`
      UPDATE wms.order_items
      SET quantity = ${nextQuantity},
          status = ${nextStatus},
          short_reason = ${nextShortReason},
          on_hold = ${nextOnHold}
      WHERE id = ${current.id}
        AND order_id = ${current.orderId}
    `);
  }

  return {
    item: {
      id: current.id,
      quantity: nextQuantity,
      pickedQuantity: current.pickedQuantity,
      fulfilledQuantity: current.fulfilledQuantity,
      status: nextStatus,
    },
    manualReviewReason: refundAfterPick
      ? "refund_after_pick"
      : args.restockPolicy === "unknown"
        ? "refund_unknown_restock_policy"
        : null,
    changed,
  };
}
