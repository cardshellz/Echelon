/**
 * Shared order/shipment status enums and cross-domain derivations.
 *
 * Per refactor plan v2 §4.7 + invariant #4: WMS is the source of truth
 * for fulfillment state; OMS status is derived from WMS; WMS order-level
 * status is derived from its shipments. This file defines the three
 * domains and the deterministic functions that map between them.
 *
 * Rules:
 *   - No randomness, no system-time reads (coding-standards rule #2).
 *   - Pure functions; no side effects.
 *   - Exhaustive unions; `never`-guarded defaults in switches.
 */

// ─── OMS order status ────────────────────────────────────────────────

export const OMS_ORDER_STATUS_VALUES = [
  "pending",
  "paid",
  "processing",
  "partially_shipped",
  "shipped",
  "cancelled",
  "refunded",
] as const;

export type OmsOrderStatus = (typeof OMS_ORDER_STATUS_VALUES)[number];

// ─── WMS order-level warehouse status ────────────────────────────────

export const WMS_WAREHOUSE_STATUS_VALUES = [
  "ready",
  "picking",
  "picked",
  "packing",
  "packed",
  "ready_to_ship",
  "partially_shipped",
  "shipped",
  "on_hold",
  "exception",
  "cancelled",
  "awaiting_3pl",
] as const;

export type WmsWarehouseStatus = (typeof WMS_WAREHOUSE_STATUS_VALUES)[number];

// ─── Shipment status (per shipment, not per order) ───────────────────
//
// New enum; becomes a PG enum type via migration 060. See plan §4.3 +
// §2.4 state machine.

export const SHIPMENT_STATUS_VALUES = [
  "planned",
  "queued",
  "labeled",
  "shipped",
  "on_hold",
  "voided",
  "cancelled",
  "returned",
  "lost",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUS_VALUES)[number];

// Terminal shipment states — no outbound transition except via admin
// action (e.g. `returned` shipments can be `lost` manually).
export const TERMINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  "shipped",
  "cancelled",
  "returned",
  "lost",
];

/**
 * True when the shipment has "already shipped" semantics for roll-up
 * purposes. `returned` and `lost` both presuppose `shipped`, so they
 * count as shipped for order-level roll-up.
 */
export function isShipmentShipped(status: ShipmentStatus): boolean {
  return status === "shipped" || status === "returned" || status === "lost";
}

/**
 * True when the shipment is "still open" — not shipped, not cancelled.
 * Drives the "partially_shipped" roll-up logic.
 */
export function isShipmentOpen(status: ShipmentStatus): boolean {
  switch (status) {
    case "planned":
    case "queued":
    case "labeled":
    case "on_hold":
    case "voided":
      return true;
    case "shipped":
    case "cancelled":
    case "returned":
    case "lost":
      return false;
    default: {
      // Exhaustiveness guard — new enum values must be classified here.
      const _never: never = status;
      return _never;
    }
  }
}

// ─── WMS → OMS derivation ───────────────────────────────────────────
//
// Per invariant #7, OMS status updates are derived from WMS state.
// Fulfillment-only states (picking, packed, etc.) don't change OMS
// status — only shipped / partially_shipped / cancelled move the OMS
// needle.

/**
 * Derive the OMS status for an order given its WMS warehouse_status.
 *
 * Returns `null` when no OMS update is warranted (in-progress WMS
 * states like `picking` / `packed` have no OMS-visible effect). The
 * caller is responsible for preserving the existing OMS status when
 * the result is `null`.
 */
export function deriveOmsFromWms(
  wmsStatus: WmsWarehouseStatus,
): OmsOrderStatus | null {
  switch (wmsStatus) {
    case "shipped":
      return "shipped";
    case "partially_shipped":
      return "partially_shipped";
    case "cancelled":
      return "cancelled";
    case "ready":
    case "picking":
    case "picked":
    case "packing":
    case "packed":
    case "ready_to_ship":
    case "on_hold":
    case "exception":
    case "awaiting_3pl":
      return null;
    default: {
      const _never: never = wmsStatus;
      return _never;
    }
  }
}

// ─── Shipments → WMS order roll-up ──────────────────────────────────
//
// This is the ONLY path that writes `wms.orders.warehouse_status` once
// the plan lands (invariant #4). Keep this function pure; the caller
// (`recomputeOrderStatusFromShipments`) handles the UPDATE.
//
// Table per plan §2.4:
//   Any shipment on_hold            → `on_hold`
//   All shipments cancelled         → `cancelled`
//   All shipments shipped           → `shipped`
//   Some shipped + some open        → `partially_shipped`
//   Otherwise (all open, none shipped) → `ready_to_ship`
//   No shipments at all             → `ready`
//
// A shipment in `voided` counts as "open" (the label is gone, the
// shipment still needs to be re-labeled / re-pushed).

export function deriveWmsFromShipments(
  shipmentStatuses: readonly ShipmentStatus[],
): WmsWarehouseStatus {
  if (shipmentStatuses.length === 0) return "ready";

  // Any shipment on hold → whole order on hold (highest priority).
  if (shipmentStatuses.some((s) => s === "on_hold")) return "on_hold";

  // All cancelled (terminal, none shipped) → cancelled.
  if (shipmentStatuses.every((s) => s === "cancelled")) return "cancelled";

  const anyShipped = shipmentStatuses.some(isShipmentShipped);
  const anyOpen = shipmentStatuses.some(isShipmentOpen);

  if (anyShipped && anyOpen) return "partially_shipped";
  if (anyShipped && !anyOpen) return "shipped";

  // No shipments have shipped yet, none on hold, not all cancelled.
  // If mixed open + cancelled, treat as still open → ready_to_ship.
  return "ready_to_ship";
}
