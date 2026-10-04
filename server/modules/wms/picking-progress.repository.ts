import { and, eq, sql } from "drizzle-orm";
import { orders, orderItems, type OrderItem } from "@shared/schema";
import {
  deriveWmsPickingProgress,
  pickingReadinessBlockers,
  wmsPickingProgressLineSchema,
  type WmsPickingProgressLine,
} from "@shared/wms-picking-progress";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import type { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { persistWmsOrderItemPickProgress } from "./order-item-commands";
import { IntegrityError } from "@shared/errors";
import type { PickingCommandTransaction } from "./picking-command.repository";

type Transaction = PickingCommandTransaction;

function progressLine(item: OrderItem): WmsPickingProgressLine {
  return wmsPickingProgressLineSchema.parse({
    id: item.id,
    sku: item.sku,
    quantity: item.quantity,
    pickedQuantity: item.pickedQuantity,
    requiresShipping: item.requiresShipping === 1,
    onHold: item.onHold === true,
    status: item.status,
    inventoryTracking: item.inventoryTracking,
    catalogProductId: item.catalogProductId,
    productId: item.productId,
    location: item.location,
  });
}

export async function readWmsPickingBlockers(
  tx: Pick<Transaction, "select" | "execute">,
  orderId: number,
  providedItems?: readonly OrderItem[],
): Promise<string[]> {
  const items =
    providedItems ??
    (await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)));
  return [
    ...pickingReadinessBlockers(items.map(progressLine)),
    ...(await readDependencyBlockers(tx, orderId)),
  ];
}

async function readDependencyBlockers(
  tx: Pick<Transaction, "execute">,
  orderId: number,
): Promise<string[]> {
  const blockers: string[] = [];
  const pending =
    await tx.execute(sql`SELECT command_key FROM wms.picking_commands
    WHERE order_id=${orderId} AND physical_receipt IS NOT NULL AND completed_at IS NULL`);
  for (const command of pending.rows)
    blockers.push(
      `Picking command ${command.command_key} has pending operational follow-up`,
    );
  const exceptions =
    await tx.execute(sql`SELECT id,sku,exception_type,status,review_reason FROM wms.allocation_exceptions
    WHERE order_id=${orderId} AND status NOT IN ('resolved','resolved_inline','cancelled')
      AND (status='blocked' OR COALESCE(metadata->>'shipmentBlocking','false')='true') ORDER BY created_at DESC`);
  for (const row of exceptions.rows)
    blockers.push(
      `${row.sku || "item"} has ${row.exception_type || "exception"} #${row.id}: ${row.review_reason || row.status}`,
    );
  const tasks =
    await tx.execute(sql`SELECT rt.id,rt.status,rt.exception_reason,pv.sku FROM inventory.replen_tasks rt
    LEFT JOIN catalog.product_variants pv ON pv.id=rt.pick_product_variant_id WHERE rt.order_id=${orderId}
    AND rt.blocks_shipment=true AND rt.status NOT IN ('completed','cancelled') ORDER BY rt.created_at DESC`);
  for (const row of tasks.rows)
    blockers.push(
      `${row.sku || "item"} has replen task #${row.id}: ${row.exception_reason || row.status}`,
    );
  return blockers;
}

/** Caller-owned transaction; lock order before inspecting its current line facts. */
export async function reconcileWmsPickingProgress(
  tx: Transaction,
  orderId: number,
  postPickStatus: string,
  actor: string,
  clock: () => Date,
  mode: "picking" | "counts" = "picking",
) {
  await tx.execute(
    sql`SELECT id FROM wms.orders WHERE id=${orderId} FOR UPDATE`,
  );
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order)
    throw new IntegrityError(
      "WMS order was not found for progress projection",
      { orderId },
    );
  await tx.execute(
    sql`SELECT id FROM wms.order_items WHERE order_id=${orderId} ORDER BY id FOR UPDATE`,
  );
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const blockers = await readDependencyBlockers(tx, orderId);
  const projection = deriveWmsPickingProgress({
    currentStatus: order.warehouseStatus,
    postPickStatus,
    lines: items.map(progressLine),
    additionalBlockers: blockers,
  });
  if (mode === "counts") {
    projection.status = order.warehouseStatus as WmsWarehouseStatus;
    projection.completeNonShipping = false;
  }
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !actor.trim())
    throw new IntegrityError("Invalid picking projection actor or clock", {
      orderId,
    });
  if (projection.completeNonShipping)
    for (const item of items) {
      if (item.requiresShipping !== 1 && item.status === "pending")
        await persistWmsOrderItemPickProgress(tx, {
          itemId: item.id,
          status: "completed",
        });
    }
  const statusChanged = projection.status !== order.warehouseStatus;
  const changed =
    statusChanged ||
    projection.pickedCount !== order.pickedCount ||
    projection.itemCount !== order.itemCount ||
    projection.unitCount !== order.unitCount;
  const [updated] = await tx
    .update(orders)
    .set({
      pickedCount: projection.pickedCount,
      itemCount: projection.itemCount,
      unitCount: projection.unitCount,
      warehouseStatus: projection.status,
      ...(changed ? { updatedAt: now } : {}),
      ...(statusChanged
        ? {
            completedAt: projection.completeNonShipping ? now : null,
            exceptionAt: projection.status === "exception" ? now : null,
          }
        : {}),
    })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.warehouseStatus, order.warehouseStatus),
      ),
    )
    .returning();
  if (!updated)
    throw new IntegrityError(
      "Locked WMS order changed during progress projection",
      { orderId },
    );
  if (changed)
    await persistAuditEvent(
      tx,
      {
        actor,
        action: "wms.picking_progress_projected",
        target: `wms.order:${orderId}`,
        changes: {
          before: {
            warehouseStatus: order.warehouseStatus,
            pickedCount: order.pickedCount,
            itemCount: order.itemCount,
            unitCount: order.unitCount,
          },
          after: {
            warehouseStatus: updated.warehouseStatus,
            pickedCount: updated.pickedCount,
            itemCount: updated.itemCount,
            unitCount: updated.unitCount,
          },
        },
      },
      { timestamp: now },
    );
  return updated;
}
