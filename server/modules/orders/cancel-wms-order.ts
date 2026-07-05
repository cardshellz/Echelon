/**
 * Single entrypoint for cancelling a WMS order (P0.1c).
 *
 * Every WMS-order cancellation — webhook cascade, OMS→WMS sync, the hourly
 * OMS↔WMS reconcile, flow-reconciliation remediation — funnels through this
 * helper so a cancel can never leak inventory reservations again:
 *
 *   1. Guarded status transition (order-status-core matrix — never regresses
 *      a shipped order).
 *   2. Clear the picker assignment.
 *   3. Release the order's OPEN reservations (order-scoped + idempotent,
 *      P0.1b — releases only what this order's ledger still holds).
 *
 * If the transition does not fire (already cancelled / shipped / terminal),
 * NO release happens: a shipped order's reservations were consumed by its
 * picks, and an already-cancelled order was released by whoever cancelled it
 * first (and re-releasing would be a no-op anyway, by P0.1b's ledger math).
 *
 * Release failure does NOT roll back the cancel — the cancel is the
 * safety-critical half (stops picking/shipping), and release is idempotent
 * so the reservation reconciler / weekly drift check can finish the job.
 * Callers get `releaseFailed` to surface `requires_review` events.
 */
import { sql } from "drizzle-orm";
import { cancelOrder, completeOrder, type TransitionResult } from "./order-status-core";

export interface ReservationReleaser {
  releaseOrderReservation(
    orderId: number,
    reason: string,
    userId?: string,
  ): Promise<{
    released: number;
    failed: Array<{ sku: string; orderItemId: number; reason: string }>;
  }>;
}

export interface CancelWmsOrderOutcome extends TransitionResult {
  /** Item-level releases performed (0 when nothing was open). */
  releasedItems: number;
  /** True when the release step errored or partially failed — flag for review. */
  releaseFailed: boolean;
}

export async function cancelWmsOrderAndRelease(
  db: any,
  reservation: ReservationReleaser,
  orderId: number,
  reason: string,
  userId?: string,
): Promise<CancelWmsOrderOutcome> {
  const trans = await cancelOrder(db, orderId, reason);
  if (!trans.transitioned) {
    return { ...trans, releasedItems: 0, releaseFailed: false };
  }

  await db.execute(
    sql`UPDATE wms.orders SET assigned_picker_id = NULL WHERE id = ${orderId}`,
  );

  const release = await releaseOrderReservationBestEffort(
    reservation, orderId, reason, userId, "WMS Cancel",
  );
  return { ...trans, ...release };
}

/**
 * Terminal-complete twin of `cancelWmsOrderAndRelease` ('completed'-status
 * fix, 2026-07). `completed` means the warehouse work is DONE — every
 * shippable item is picked, short, or cancelled — so the order can never
 * consume its remaining reservations. Picked units already consumed theirs
 * at pick time; whatever the order-scoped ledger still holds is residue
 * from short/cancelled items and must be released on entry, or it leaks
 * forever (the #55xxx cluster held 200+ phantom units this way).
 *
 * Same discipline as cancel: no transition → no release; a release failure
 * never rolls back the completion.
 */
export async function completeWmsOrderAndRelease(
  db: any,
  reservation: ReservationReleaser,
  orderId: number,
  reason: string,
  userId?: string,
): Promise<CancelWmsOrderOutcome> {
  const trans = await completeOrder(db, orderId, reason);
  if (!trans.transitioned) {
    return { ...trans, releasedItems: 0, releaseFailed: false };
  }

  const release = await releaseOrderReservationBestEffort(
    reservation, orderId, reason, userId, "WMS Complete",
  );
  return { ...trans, ...release };
}

async function releaseOrderReservationBestEffort(
  reservation: ReservationReleaser,
  orderId: number,
  reason: string,
  userId: string | undefined,
  logTag: string,
): Promise<{ releasedItems: number; releaseFailed: boolean }> {
  let releasedItems = 0;
  let releaseFailed = false;
  try {
    const rel = await reservation.releaseOrderReservation(orderId, reason, userId);
    releasedItems = rel.released;
    releaseFailed = rel.failed.length > 0;
    if (releaseFailed) {
      console.error(
        `[${logTag}] Partial reservation release for order ${orderId} (${reason}): ` +
          rel.failed.map((f) => `${f.sku}: ${f.reason}`).join(", "),
      );
    }
  } catch (err: any) {
    releaseFailed = true;
    console.error(
      `[${logTag}] Reservation release failed for order ${orderId} (${reason}): ${err?.message ?? String(err)}`,
    );
  }
  return { releasedItems, releaseFailed };
}
