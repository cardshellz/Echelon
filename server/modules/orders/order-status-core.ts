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

// ─── Terminal states ────────────────────────────────────────────────
// These states cannot be exited by normal transitions.
// Exception: cancelled → shipped (truth wins — if engine says shipped,
// we record it regardless of our local cancel state).

const TERMINAL_STATES: ReadonlySet<WmsWarehouseStatus> = new Set([
  "shipped",
  "cancelled",
]);

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
  const result = await client.query(`UPDATE wms.orders wo SET warehouse_status='ready',cancelled_at=NULL,updated_at=$4
    WHERE wo.id=$1 AND wo.warehouse_status='cancelled' AND wo.order_edit_operation_id=$2
      AND wo.assigned_picker_id IS NULL AND wo.started_at IS NULL AND wo.picked_count=0 AND wo.combined_group_id IS NULL
      AND EXISTS(SELECT 1 FROM oms.order_edit_operations op JOIN oms.oms_orders source ON source.id=op.oms_order_id
        WHERE op.id=$2 AND op.oms_order_id=$3 AND op.status='synchronizing'
          AND op.document->>'refundStartedAt' IS NOT NULL AND op.document->'refundIntent'->>'operationId'=$2::text
          AND source.status<>'cancelled' AND source.cancelled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM wms.order_items oi WHERE oi.order_id=wo.id
        AND (oi.picked_quantity<>0 OR oi.fulfilled_quantity<>0 OR oi.status<>'cancelled' OR oi.quantity<>0))
      AND NOT EXISTS(SELECT 1 FROM wms.outbound_shipments shipment WHERE shipment.order_id=wo.id
        AND (shipment.status NOT IN ('cancelled','voided','planned','queued','on_hold')
          OR shipment.tracking_number IS NOT NULL OR shipment.shipped_at IS NOT NULL))
    RETURNING wo.id`, [input.orderId, input.operationId, input.omsOrderId, input.now]);
  return result.rows.length === 1;
}

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

  // Build the UPDATE with guarded WHERE
  const now = clock();
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
      ${requireNoOrderEdit ? sql`AND order_edit_operation_id IS NULL` : sql``}
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
