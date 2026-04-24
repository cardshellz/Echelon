/**
 * WMS order insert factory.
 *
 * Enforces the refactor invariant (plan §6 Commit 9): every wms.orders
 * row must have a non-null `omsFulfillmentOrderId` + a positive integer
 * `channelId`. Runtime guards + TS-enforced required shape.
 *
 * This file only provides the factory. Call-site migration to route
 * through it lands in Commit 9b (createOrderWithItems + existing
 * callers) and 9c (manual-order route).
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 9.
 */

import { wmsOrders } from "@shared/schema";
import type { InsertWmsOrder } from "@shared/schema";

/**
 * Required-non-null shape for wms.orders inserts. Callers passing
 * null / undefined for the two mandatory linkage fields fail tsc.
 */
export type WmsOrderInsert = Omit<
  InsertWmsOrder,
  "omsFulfillmentOrderId" | "channelId"
> & {
  omsFulfillmentOrderId: string;
  channelId: number;
};

export class WmsOrderInvariantError extends Error {
  constructor(
    public readonly field: "omsFulfillmentOrderId" | "channelId",
    public readonly value: unknown,
  ) {
    super(
      `insertWmsOrder: ${field} must be non-null/non-empty (got ${JSON.stringify(value)})`,
    );
    this.name = "WmsOrderInvariantError";
  }
}

/**
 * Insert a wms.orders row. Throws WmsOrderInvariantError at runtime if
 * the invariant is violated (e.g. caller bypasses TS via `as any`).
 *
 * Returns `{ id }` on success.
 */
export async function insertWmsOrder(
  db: any,
  payload: WmsOrderInsert,
): Promise<{ id: number }> {
  if (
    typeof payload.omsFulfillmentOrderId !== "string" ||
    payload.omsFulfillmentOrderId.length === 0
  ) {
    throw new WmsOrderInvariantError(
      "omsFulfillmentOrderId",
      payload.omsFulfillmentOrderId,
    );
  }
  if (
    payload.channelId === null ||
    payload.channelId === undefined ||
    typeof payload.channelId !== "number" ||
    !Number.isInteger(payload.channelId) ||
    payload.channelId <= 0
  ) {
    throw new WmsOrderInvariantError("channelId", payload.channelId);
  }

  const inserted = await db
    .insert(wmsOrders)
    .values(payload)
    .returning({ id: wmsOrders.id });

  const row = Array.isArray(inserted) ? inserted[0] : undefined;
  if (!row?.id) {
    throw new Error("insertWmsOrder: insert returned no row");
  }

  return { id: row.id };
}
