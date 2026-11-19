/**
 * Order-Status Core (C4) — the sole guarded writer of warehouse_status.
 *
 * Every status mutation must go through transitionOrderStatus(). Direct
 * UPDATEs to wms.orders.warehouse_status are forbidden outside this
 * module. The function enforces:
 *
 *   1. Terminal states — cancelled/shipped are non-reversible (except
 *      shipped can come from cancelled, because truth wins).
 *   2. Legal transitions — a matrix of allowed (from → to) pairs.
 *   3. Optimistic lock — the UPDATE's WHERE clause includes the
 *      expected current status, so concurrent writers don't clobber.
 *   4. Audit trail — every transition is logged with before/after.
 *
 * Callers that were previously doing raw UPDATEs migrate to:
 *   const result = await transitionOrderStatus(db, orderId, {
 *     from: ["ready", "picking"],
 *     to: "cancelled",
 *     reason: "oms_cancel_cascade",
 *   });
 *   if (!result.transitioned) { /* already terminal or wrong state * / }
 */

import { sql } from "drizzle-orm";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  executeGuardedWmsOrderStatusTransitionInWms,
  isTerminalWmsOrderStatus,
  isWmsOrderTransitionAllowed,
  restoreStoppedRefundEditWmsOrderInWms,
} from "../wms/wms-order-mutations.api";

/**
 * Narrow correction of empty, unstarted work stopped during an owned refund
 * edit. The caller proves native settlement and appends the immutable edit
 * audit in this transaction. This does not relax ordinary terminal transitions
 * or release either the dedicated edit hold or an independent manual hold.
 */
export async function restoreStoppedRefundEditOrder(
  client: Pick<PoolClient, "query">,
  input: { orderId: number; omsOrderId: number; operationId: string; now: Date },
): Promise<boolean> {
  z.object({ orderId: z.number().int().positive().safe(), omsOrderId: z.number().int().positive().safe(),
    operationId: z.string().uuid(), now: z.date() }).strict().parse(input);
  return restoreStoppedRefundEditWmsOrderInWms(client, input);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface TransitionRequest {
  from: WmsWarehouseStatus[];
  to: WmsWarehouseStatus;
  reason: string;
  setCompletedAt?: boolean;
  setCancelledAt?: boolean;
  /** Background cleanup must not close an order owned by an edit in progress. */
  requireNoOrderEdit?: boolean;
}

export interface TransitionResult {
  transitioned: boolean;
  previousStatus: WmsWarehouseStatus | null;
  newStatus: WmsWarehouseStatus;
  orderId: number;
  reason: string;
}

/**
 * Check whether a transition is allowed by the matrix without
 * touching the database. Used for validation and testing.
 */
export function isTransitionAllowed(
  from: WmsWarehouseStatus,
  to: WmsWarehouseStatus,
): boolean {
  return isWmsOrderTransitionAllowed(from, to);
}

/**
 * Check whether a status is terminal.
 */
export function isTerminalStatus(status: WmsWarehouseStatus): boolean {
  return isTerminalWmsOrderStatus(status);
}

/**
 * Attempt to transition an order's warehouse_status.
 *
 * The UPDATE uses a WHERE guard: it only fires when the current
 * status is one of the `from` states AND the transition is legal.
 * Returns { transitioned: false } when:
 *   - The order doesn't exist
 *   - The current status is not in the `from` list
 *   - The current status is terminal and `to` is not a legal exit
 *   - The transition is not in the matrix
 *
 * The caller decides what to do on transitioned=false (log, alert,
 * retry, no-op).
 */
export async function transitionOrderStatus(
  db: any,
  orderId: number,
  request: TransitionRequest,
  clock: () => Date = () => new Date(),
): Promise<TransitionResult> {
  const { from, to, reason, setCompletedAt, setCancelledAt, requireNoOrderEdit } = request;

  // Filter `from` states to only those with a legal transition to `to`
  const legalFrom = from.filter((f) => isTransitionAllowed(f, to));

  if (legalFrom.length === 0) {
    // Read current status for the result
    const current = await getCurrentStatus(db, orderId);
    return {
      transitioned: false,
      previousStatus: current,
      newStatus: current ?? to,
      orderId,
      reason: `no legal transition from [${from.join(",")}] to ${to}`,
    };
  }

  // Build the UPDATE with guarded WHERE and atomic prior-status capture
  const now = clock();
  const fromList = legalFrom.map((s) => `'${s}'`).join(", ");

  const result: any = await executeGuardedWmsOrderStatusTransitionInWms(db, {
    orderId,
    fromListRaw: fromList,
    to,
    now,
    setCompletedAt,
    setCancelledAt,
    requireNoOrderEdit,
  });

  const updated = result?.rows?.[0];
  if (!updated) {
    const current = await getCurrentStatus(db, orderId);
    return {
      transitioned: false,
      previousStatus: current,
      newStatus: current ?? to,
      orderId,
      reason: current
        ? `order is in '${current}', not in [${legalFrom.join(",")}]`
        : `order ${orderId} not found`,
    };
  }

  return {
    transitioned: true,
    previousStatus: (updated.previous_status as WmsWarehouseStatus | undefined) ?? legalFrom[0],
    newStatus: to,
    orderId,
    reason,
  };
}

/**
 * Convenience: transition to cancelled with standard guards.
 */
export async function cancelOrder(
  db: any,
  orderId: number,
  reason: string,
  guards?: Pick<TransitionRequest, "requireNoOrderEdit">,
): Promise<TransitionResult> {
  return transitionOrderStatus(db, orderId, {
    from: [
      "ready", "in_progress", "picking", "picked", "packing", "packed",
      "completed", "ready_to_ship", "partially_shipped",
      "on_hold", "exception", "awaiting_3pl",
    ],
    to: "cancelled",
    reason,
    setCancelledAt: true,
    ...guards,
  });
}

/**
 * Convenience: transition to shipped with standard guards.
 * Allows shipped from cancelled (truth wins).
 */
export async function markOrderShipped(
  db: any,
  orderId: number,
  reason: string,
): Promise<TransitionResult> {
  return transitionOrderStatus(db, orderId, {
    from: [
      "ready", "in_progress", "picking", "picked", "packing", "packed",
      "completed", "ready_to_ship", "partially_shipped",
      "on_hold", "exception", "awaiting_3pl",
      "cancelled", // truth wins
    ],
    to: "shipped",
    reason,
    setCompletedAt: true,
  });
}

/**
 * Convenience: transition to completed with standard guards.
 * Used by self-heal paths when all shippable items are done.
 */
export async function completeOrder(
  db: any,
  orderId: number,
  reason: string,
  guards?: Pick<TransitionRequest, "requireNoOrderEdit">,
): Promise<TransitionResult> {
  return transitionOrderStatus(db, orderId, {
    from: [
      "ready", "in_progress", "picking", "picked", "packing", "packed",
      "ready_to_ship", "partially_shipped",
      "on_hold", "exception", "awaiting_3pl",
    ],
    to: "completed",
    reason,
    setCompletedAt: true,
    ...guards,
  });
}

// ─── Internal helpers ───────────────────────────────────────────────

async function getCurrentStatus(
  db: any,
  orderId: number,
): Promise<WmsWarehouseStatus | null> {
  const row: any = await db.execute(sql`
    SELECT warehouse_status FROM wms.orders WHERE id = ${orderId} LIMIT 1
  `);
  return (row?.rows?.[0]?.warehouse_status as WmsWarehouseStatus) ?? null;
}
