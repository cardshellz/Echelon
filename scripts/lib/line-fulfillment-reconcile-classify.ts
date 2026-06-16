/**
 * Pure classification logic for the Phase 1 reconciliation dry-run
 * (scripts/reconcile-line-fulfillments-dryrun.ts).
 *
 * Extracted so the decision table can be unit-tested without a database and
 * reused by the eventual `deriveWmsFromLines` (Phase 3). No side effects, no
 * I/O — given per-order aggregate counts, it returns the new-model status, the
 * current-model status (via the REAL production fn), and a reconciliation
 * bucket. FULFILLMENT_STATE_DESIGN.md §2.1, §7.
 */

import {
  deriveWmsFromShipments,
  type ShipmentStatus,
} from "../../shared/enums/order-status";

/** Per-order aggregates the classifier needs (subset of the SQL row). */
export interface ReconcileInput {
  warehouse_status: string;
  // line rollup (shippable = requires_shipping<>0 AND status<>'cancelled' AND qty>0)
  n_shippable: number;
  n_fully: number; // shippable lines with shipped_qty >= ordered_qty
  n_any: number;   // shippable lines with shipped_qty > 0
  // shipment-row counts
  n_ship: number;
  n_shipped: number;    // shipped/returned/lost
  n_onhold: number;
  n_cancelled: number;
  n_open_other: number; // planned/queued/labeled/voided
}

export type NewModel = "shipped" | "partially_shipped" | "ready" | "no_ship";

export type Bucket =
  // informational
  | "no_ship_lines"
  | "match"
  | "match_no_ship"
  | "cancelled_overlay"
  | "hold_overlay"
  | "legacy_unfulfilled"
  // cutover-guard (regression risk, NOT a redesign win)
  | "legacy_preserve"
  // flagged (live order with shipments, stored disagrees with line truth)
  | "stale_partial"
  | "over_reported"
  | "missed_fulfillment"
  | "cancelled_but_shipped"
  | "hold_but_shipped"
  | "other_mismatch";

export const FLAGGED: ReadonlySet<Bucket> = new Set<Bucket>([
  "stale_partial", "over_reported", "missed_fulfillment",
  "cancelled_but_shipped", "hold_but_shipped", "other_mismatch",
]);

export const IN_WAREHOUSE: ReadonlySet<string> = new Set<string>([
  "ready", "in_progress", "picking", "picked", "packing", "packed",
  "completed", "ready_to_ship", "exception", "awaiting_3pl",
]);

const SHIPPED_ISH: ReadonlySet<string> = new Set<string>(["shipped", "partially_shipped"]);

/** New-model order status purely from per-line shipped-vs-ordered counts. */
export function deriveNewModel(r: ReconcileInput): NewModel {
  if (r.n_shippable === 0) return "no_ship"; // digital / all-cancelled / zero-qty lines
  if (r.n_fully === r.n_shippable) return "shipped";
  if (r.n_any > 0) return "partially_shipped";
  return "ready";
}

/**
 * Reconstruct a representative shipment-status multiset from the per-order
 * counts and run it through the REAL `deriveWmsFromShipments`, so the
 * "current model" matches production logic exactly (no re-implementation).
 * returned/lost fold into 'shipped' — `isShipmentShipped` classifies all
 * three identically, so the derived status is unchanged.
 */
export function deriveCurrentModel(r: ReconcileInput): string {
  const statuses: ShipmentStatus[] = [
    ...Array<ShipmentStatus>(r.n_shipped).fill("shipped"),
    ...Array<ShipmentStatus>(r.n_onhold).fill("on_hold"),
    ...Array<ShipmentStatus>(r.n_cancelled).fill("cancelled"),
    ...Array<ShipmentStatus>(r.n_open_other).fill("queued"),
  ];
  return deriveWmsFromShipments(statuses);
}

/**
 * Reconciliation bucket for one order. Two axes drive it:
 *   1. Does the order have shipment rows? (n_ship>0). No rows → legacy: the
 *      ledger is empty so new_model is 'ready'/'no_ship'. A stored shipped/
 *      partial here is a CUTOVER GUARD (must not downgrade), not a bug.
 *   2. With shipments, does line truth disagree with the stored status?
 */
export function classify(r: ReconcileInput, nm: NewModel): Bucket {
  if (nm === "no_ship") return "no_ship_lines";
  const stored = r.warehouse_status;
  const hasShipments = r.n_ship > 0;

  if (!hasShipments) {
    return SHIPPED_ISH.has(stored) ? "legacy_preserve" : "legacy_unfulfilled";
  }

  if (stored === "cancelled") {
    return SHIPPED_ISH.has(nm) ? "cancelled_but_shipped" : "cancelled_overlay";
  }
  if (stored === "on_hold") {
    return SHIPPED_ISH.has(nm) ? "hold_but_shipped" : "hold_overlay";
  }

  if (stored === nm) return "match";

  if (stored === "shipped" && (nm === "partially_shipped" || nm === "ready")) return "over_reported";
  if (stored === "partially_shipped" && nm === "ready") return "over_reported";
  if (stored === "partially_shipped" && nm === "shipped") return "stale_partial";
  if (IN_WAREHOUSE.has(stored) && SHIPPED_ISH.has(nm)) return "missed_fulfillment";
  if (IN_WAREHOUSE.has(stored) && nm === "ready") return "match_no_ship";

  return "other_mismatch";
}
