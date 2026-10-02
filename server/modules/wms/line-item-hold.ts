/**
 * Line-item hold — shipment split/un-split (LINE-ITEM-HOLD-DESIGN.md, P2).
 *
 * P1 (#679) only recorded the hold (wms.order_items.on_hold). P2 makes a held
 * line actually NOT ship while the rest of the order does, by moving the held
 * line into its OWN shipment with held=true. A held shipment is never pushed to
 * the engine (pushShipment refuses held=true — the single chokepoint), so the
 * line sits out until released. On release the held flag clears and the caller
 * pushes that shipment so it ships on its own.
 *
 * The data model already supports N shipments per order (FK only); this just
 * creates one more and reassigns the line's outbound_shipment_items row.
 */

import { sql } from "drizzle-orm";
import { decideLineHoldRelease, type LineHoldReleaseDecision } from "@shared/wms-hold-release";

const HELD_SHIPMENT_SOURCE = "line_item_hold";

export interface HoldSplitResult {
  heldShipmentId: number | null;
  mainShipmentId: number | null;
  /** main was already in ShipStation (queued/labeled) → caller re-pushes it without the held line */
  mainShipmentPushed: boolean;
  /** main still has shippable items after the move (don't re-push an emptied shipment) */
  mainStillHasItems: boolean;
}

/**
 * Atomically mark a line held and split it into its own held shipment.
 * Returns null-ish ids when the line isn't in a shippable shipment (already
 * shipped/held/etc.) — the caller has already enforced "pending only" upstream.
 */
export async function holdLineItemWithSplit(
  db: any,
  args: { wmsOrderId: number; orderItemId: number; reason: string; now: Date },
): Promise<HoldSplitResult> {
  const reason = args.reason.slice(0, 200);
  return await db.transaction(async (tx: any) => {
    // 1. Mark the line held (intent — same column P1 writes).
    await tx.execute(sql`
      UPDATE wms.order_items SET on_hold = true, hold_reason = ${reason}
      WHERE id = ${args.orderItemId}
    `);

    // 2. Find the line's current shippable (non-held, non-terminal) shipment.
    const mainRows: any = await tx.execute(sql`
      SELECT os.id, os.status, os.channel_id, os.shipstation_order_id
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE osi.order_item_id = ${args.orderItemId}
        AND os.order_id = ${args.wmsOrderId}
        AND os.held = false
        AND os.status NOT IN ('shipped', 'voided', 'cancelled', 'returned', 'lost')
      ORDER BY os.id
      LIMIT 1
    `);
    const main = mainRows?.rows?.[0];
    if (!main) {
      return { heldShipmentId: null, mainShipmentId: null, mainShipmentPushed: false, mainStillHasItems: false };
    }
    const mainShipmentId = Number(main.id);

    // 3. Create the held shipment (planned, held=true — never pushed until released).
    const inserted: any = await tx.execute(sql`
      INSERT INTO wms.outbound_shipments
        (order_id, channel_id, status, source, held, held_at, on_hold_reason)
      VALUES
        (${args.wmsOrderId}, ${main.channel_id ?? null}, 'planned', ${HELD_SHIPMENT_SOURCE}, true, ${args.now}, ${reason})
      RETURNING id
    `);
    const heldShipmentId = Number(inserted?.rows?.[0]?.id);

    // 4. Move the held line's item row into the held shipment.
    await tx.execute(sql`
      UPDATE wms.outbound_shipment_items SET shipment_id = ${heldShipmentId}
      WHERE shipment_id = ${mainShipmentId} AND order_item_id = ${args.orderItemId}
    `);

    // 5. Report whether the main still ships anything + was already pushed.
    const remainRows: any = await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM wms.outbound_shipment_items WHERE shipment_id = ${mainShipmentId}
    `);
    const mainStillHasItems = Number(remainRows?.rows?.[0]?.n ?? 0) > 0;
    const mainShipmentPushed =
      main.shipstation_order_id != null &&
      Number(main.shipstation_order_id) > 0 &&
      ["queued", "labeled"].includes(String(main.status));

    return { heldShipmentId, mainShipmentId, mainShipmentPushed, mainStillHasItems };
  });
}

export type LineHoldReleaseOutcome = "released" | Exclude<LineHoldReleaseDecision, "release">;

export interface LineHoldReleaseResult {
  outcome: LineHoldReleaseOutcome;
  /** Set only when released: the caller pushes this shipment so the line ships. */
  heldShipmentId: number | null;
  /** Locked state the decision was made on (null when that row was not found). */
  orderStatus: string | null;
  lineWasHeld: boolean | null;
}

/**
 * Atomically release a line's hold and un-hold its shipment so it can ship.
 * Returns the held shipment id so the caller pushes it (it becomes a normal
 * planned shipment that the engine will now accept).
 *
 * Guarded by decideLineHoldRelease: a line that is not held is a no-op, and a
 * line whose whole order is still held (or already shipped/cancelled) is
 * refused before anything changes. Locks the order row, then the line — the
 * same order the pick path locks them — so a concurrent order hold or pick
 * waits instead of interleaving with the decision.
 */
export async function releaseLineItemFromHold(
  db: any,
  args: { wmsOrderId: number; orderItemId: number; now: Date },
): Promise<LineHoldReleaseResult> {
  return await db.transaction(async (tx: any) => {
    const orderRows: any = await tx.execute(sql`
      SELECT id, on_hold, warehouse_status
      FROM wms.orders
      WHERE id = ${args.wmsOrderId}
      FOR UPDATE
    `);
    const lineRows: any = await tx.execute(sql`
      SELECT id, order_id, on_hold, status, quantity
      FROM wms.order_items
      WHERE id = ${args.orderItemId}
      FOR UPDATE
    `);
    const orderRow = orderRows?.rows?.[0];
    const lineRow = lineRows?.rows?.[0];
    const decision = decideLineHoldRelease({
      wmsOrderId: args.wmsOrderId,
      order: orderRow
        ? { id: Number(orderRow.id), onHold: orderRow.on_hold, warehouseStatus: orderRow.warehouse_status }
        : null,
      line: lineRow
        ? {
            orderId: Number(lineRow.order_id),
            onHold: lineRow.on_hold === true,
            status: lineRow.status,
            quantity: Number(lineRow.quantity ?? 0),
          }
        : null,
    });
    const orderStatus = orderRow ? String(orderRow.warehouse_status) : null;
    const lineWasHeld = lineRow ? lineRow.on_hold === true : null;
    if (decision !== "release") {
      return { outcome: decision, heldShipmentId: null, orderStatus, lineWasHeld };
    }

    await tx.execute(sql`
      UPDATE wms.order_items SET on_hold = false, hold_reason = NULL
      WHERE id = ${args.orderItemId}
    `);
    const heldRows: any = await tx.execute(sql`
      SELECT os.id
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE osi.order_item_id = ${args.orderItemId}
        AND os.order_id = ${args.wmsOrderId}
        AND os.held = true
      ORDER BY os.id DESC
      LIMIT 1
    `);
    const held = heldRows?.rows?.[0];
    // A held line with no held shipment predates the P2 split (or its split
    // found no shippable shipment): clearing the flag is the whole release.
    if (!held) return { outcome: "released", heldShipmentId: null, orderStatus, lineWasHeld };
    const heldShipmentId = Number(held.id);
    await tx.execute(sql`
      UPDATE wms.outbound_shipments
      SET held = false, held_at = NULL, on_hold_reason = NULL, updated_at = ${args.now}
      WHERE id = ${heldShipmentId}
    `);
    return { outcome: "released", heldShipmentId, orderStatus, lineWasHeld };
  });
}
