/**
 * Backfill the picker-facing bin onto OPEN order items after a bin assignment.
 *
 * Lives in modules/orders because wms.order_items is THIS module's table
 * (writer-ratchet P2.1); the warehouse module's bin-assignment paths call it
 * as a public API.
 *
 * Why: wms-sync snapshots the primary bin onto wms.order_items.location at
 * order-sync time ("UNASSIGNED" when no setup exists). Assigning a bin later
 * only affected FUTURE orders — already-synced open items stayed UNASSIGNED
 * forever, so the picker gun never updated (2026-07 ESS-TOP-STD-SLV-CLR-C1000
 * incident). This stamps the newly assigned bin onto items that are still
 * unpicked AND still UNASSIGNED, on non-terminal orders only. Items already
 * pointing at a real bin are deliberately left alone — an in-flight pick may
 * depend on them, and moving a bin mid-pick is the resolve-allocation flow's
 * job, not ours.
 *
 * Matching is strictly by SKU (the same key the picking/resolve code uses to
 * tie order items to product_locations). order_items.product_id is NOT used —
 * its semantics vary by writer (wms-sync stamps the variant id into it), so
 * matching on it could stamp the wrong variant's items.
 *
 * Best-effort by contract: never throws (logs and returns 0), so a bin
 * assignment can never fail because of this backfill. Runs on the module-level
 * `db` handle by default — deliberately NOT the caller's transaction, so a
 * backfill hiccup can't poison an assignment tx. (Worst case if the caller's
 * tx rolls back after we stamped: the gun shows a bin whose setup row didn't
 * commit — the picker's bin scan then auto-heals setup via resolve-allocation.)
 */
import { db, sql } from "../../storage/base";

type ExecutorLike = Pick<typeof db, "execute">;

export async function backfillOpenOrderItemBinAssignment(params: {
  sku?: string | null;
  locationCode: string | null | undefined;
  zone?: string | null;
}, tx: ExecutorLike = db): Promise<number> {
  try {
    const code = (params.locationCode || "").trim().toUpperCase();
    if (!code || code === "UNASSIGNED" || code === "U") return 0;
    const sku = params.sku ? params.sku.trim().toUpperCase() : null;
    if (!sku) return 0;
    const zone = (params.zone || code.split("-")[0] || "U").trim().toUpperCase();

    const result: any = await tx.execute(sql`
      UPDATE wms.order_items oi
      SET location = ${code}, zone = ${zone}
      FROM wms.orders o
      WHERE o.id = oi.order_id
        AND (oi.location IS NULL OR oi.location IN ('UNASSIGNED', 'U'))
        AND oi.picked_quantity < oi.quantity
        AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')
        AND UPPER(oi.sku) = ${sku}
    `);
    const updated = Number(result?.rowCount ?? 0);
    if (updated > 0) {
      console.log(
        `[BinAssignment] Backfilled ${updated} open order item(s) to bin ${code} for SKU ${sku}`,
      );
    }
    return updated;
  } catch (err: any) {
    console.warn(
      `[BinAssignment] open-order-item backfill failed (non-fatal): ${err?.message ?? err}`,
    );
    return 0;
  }
}
