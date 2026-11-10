import { and, eq } from "drizzle-orm";
import { omsOrderEvents, omsOrderLines } from "@shared/schema";
import type { db } from "../../db";

/**
 * OMS-owned command: move one open order line from a retired catalog variant
 * to the variant that replaced it (catalog product merge).
 *
 * Runs inside the caller's transaction. The guarded UPDATE only matches a line
 * that still points at the source variant, so a concurrent re-resolution makes
 * the merge roll back rather than overwrite. The transition is appended to
 * oms_order_events (line_catalog_identity_merged), so the order's history explains why its variant changed.
 */
export class OrderLineVariantReassignmentError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "OrderLineVariantReassignmentError";
  }
}

type Executor = Pick<typeof db, "update" | "insert">;

export async function reassignOrderLineVariant(
  executor: Executor,
  input: {
    orderId: number;
    orderLineId: number;
    channelId: number;
    fromVariantId: number;
    to: { variantId: number; productId: number; sku: string; inventoryTracking: boolean };
    mergeRunId: number;
    now: Date;
  },
): Promise<void> {
  const [updated] = await executor.update(omsOrderLines).set({
    productVariantId: input.to.variantId,
    catalogProductId: input.to.productId,
    updatedAt: input.now,
  }).where(and(
    eq(omsOrderLines.id, input.orderLineId),
    eq(omsOrderLines.orderId, input.orderId),
    eq(omsOrderLines.productVariantId, input.fromVariantId),
  )).returning({ id: omsOrderLines.id, sku: omsOrderLines.sku });
  if (!updated) {
    throw new OrderLineVariantReassignmentError(
      "OMS_LINE_REASSIGN_CONFLICT",
      `Order line ${input.orderLineId} no longer points at variant ${input.fromVariantId}`,
      { orderId: input.orderId, orderLineId: input.orderLineId },
    );
  }
  // A dedicated event type keeps the resolver's matchedBy contract closed.
  await executor.insert(omsOrderEvents).values({
    orderId: input.orderId,
    eventType: "line_catalog_identity_merged",
    details: {
      orderLineId: input.orderLineId, channelId: input.channelId,
      previousVariantId: input.fromVariantId, productVariantId: input.to.variantId,
      catalogProductId: input.to.productId, inventoryTracking: input.to.inventoryTracking,
      sourceSku: updated.sku ?? null, catalogSku: input.to.sku,
      sourceEventId: `product-merge:${input.mergeRunId}`,
    },
  });
}
