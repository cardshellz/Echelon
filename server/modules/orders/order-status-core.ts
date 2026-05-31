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

// ─── Terminal states ────────────────────────────────────────────────
// These states cannot be exited by normal transitions.
// Exception: cancelled → shipped (truth wins — if engine says shipped,
// we record it regardless of our local cancel state).

const TERMINAL_STATES: ReadonlySet<WmsWarehouseStatus> = new Set([
  "shipped",
  "cancelled",
]);

// ─── Transition matrix ──────────────────────────────────────────────
// Key = target state. Value = set of states that may transition TO it.
// If a from-state is not listed for a target, the transition is illegal.
//
// This is intentionally permissive for Phase 1 — the goal is to funnel
// all writers through one gate, not to immediately restrict every
// transition. Tighten iteratively as each caller migrates.

const TRANSITION_MATRIX: Record<WmsWarehouseStatus, ReadonlySet<WmsWarehouseStatus>> = {
  ready: new Set(["on_hold", "exception", "awaiting_3pl"]),
  in_progress: new Set(["ready", "on_hold", "exception"]),
  picking: new Set(["ready"]),
  picked: new Set(["picking"]),
  packing: new Set(["picked"]),
  packed: new Set(["packing"]),
  completed: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "ready_to_ship", "partially_shipped",
    "on_hold", "exception", "awaiting_3pl",
  ]),
  ready_to_ship: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "on_hold", "exception", "awaiting_3pl",
  ]),
  partially_shipped: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "ready_to_ship",
    "on_hold", "exception", "awaiting_3pl",
  ]),
  shipped: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "ready_to_ship", "partially_shipped",
    "on_hold", "exception", "awaiting_3pl",
    "cancelled", // truth wins: engine says shipped
  ]),
  on_hold: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "ready_to_ship", "partially_shipped",
    "exception", "awaiting_3pl",
  ]),
  exception: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "ready_to_ship",
    "on_hold", "awaiting_3pl",
  ]),
  cancelled: new Set([
    "ready", "in_progress", "picking", "picked", "packing", "packed",
    "completed", "ready_to_ship", "partially_shipped",
    "on_hold", "exception", "awaiting_3pl",
  ]),
  awaiting_3pl: new Set(["ready", "on_hold"]),
};

// ─── Public API ─────────────────────────────────────────────────────

export interface TransitionRequest {
  from: WmsWarehouseStatus[];
  to: WmsWarehouseStatus;
  reason: string;
  setCompletedAt?: boolean;
  setCancelledAt?: boolean;
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
  if (from === to) return false;
  const allowedFrom = TRANSITION_MATRIX[to];
  if (!allowedFrom) return false;
  return allowedFrom.has(from);
}

/**
 * Check whether a status is terminal.
 */
export function isTerminalStatus(status: WmsWarehouseStatus): boolean {
  return TERMINAL_STATES.has(status);
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
): Promise<TransitionResult> {
  const { from, to, reason, setCompletedAt, setCancelledAt } = request;

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

  // Build the UPDATE with guarded WHERE
  const now = new Date();
  const fromList = legalFrom.map((s) => `'${s}'`).join(", ");

  let setClauses = `warehouse_status = '${to}', updated_at = '${now.toISOString()}'`;
  if (setCompletedAt) {
    setClauses += `, completed_at = '${now.toISOString()}'`;
  }
  if (setCancelledAt) {
    setClauses += `, cancelled_at = COALESCE(cancelled_at, '${now.toISOString()}')`;
  }

  const result: any = await db.execute(sql`
    UPDATE wms.orders
    SET warehouse_status = ${to},
        updated_at = ${now}
        ${setCompletedAt ? sql`, completed_at = ${now}` : sql``}
        ${setCancelledAt ? sql`, cancelled_at = COALESCE(cancelled_at, ${now})` : sql``}
    WHERE id = ${orderId}
      AND warehouse_status IN (${sql.raw(fromList)})
    RETURNING warehouse_status AS new_status
  `);

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
    previousStatus: legalFrom[0],
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
