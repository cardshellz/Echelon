/**
 * WMS Order Status Core (P1.3) — canonical transition matrix and terminal
 * definitions for `wms.orders.warehouse_status` owned by `modules/wms` (D1).
 *
 * Terminal states (`shipped`, `cancelled`) cannot be exited by normal
 * transitions, with one exception: `cancelled -> shipped` ("truth wins" when a
 * carrier/provider proves physical dispatch).
 */

import {
  WMS_WAREHOUSE_STATUS_VALUES,
  type WmsWarehouseStatus,
} from "@shared/enums/order-status";

export const TERMINAL_WMS_WAREHOUSE_STATUSES: ReadonlySet<WmsWarehouseStatus> = new Set([
  "shipped",
  "cancelled",
]);

export const WMS_WAREHOUSE_STATUS_TRANSITION_MATRIX: Record<
  WmsWarehouseStatus,
  ReadonlySet<WmsWarehouseStatus>
> = {
  ready: new Set(["in_progress", "on_hold", "exception", "awaiting_3pl"]),
  in_progress: new Set(["ready", "partially_shipped", "ready_to_ship", "on_hold", "exception"]),
  picking: new Set(["ready", "in_progress", "on_hold", "exception"]),
  picked: new Set(["ready", "in_progress", "picking", "on_hold", "exception"]),
  packing: new Set(["ready", "in_progress", "picking", "picked", "ready_to_ship", "on_hold", "exception"]),
  packed: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "ready_to_ship",
    "on_hold",
    "exception",
  ]),
  completed: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "ready_to_ship",
    "partially_shipped",
    "on_hold",
    "exception",
    "awaiting_3pl",
  ]),
  ready_to_ship: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "on_hold",
    "exception",
    "awaiting_3pl",
  ]),
  partially_shipped: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "ready_to_ship",
    "on_hold",
    "exception",
    "awaiting_3pl",
  ]),
  shipped: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "ready_to_ship",
    "partially_shipped",
    "on_hold",
    "exception",
    "awaiting_3pl",
    "cancelled", // truth wins: physical carrier shipment supersedes local cancel
  ]),
  on_hold: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "ready_to_ship",
    "partially_shipped",
    "exception",
    "awaiting_3pl",
  ]),
  exception: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "ready_to_ship",
    "on_hold",
    "awaiting_3pl",
  ]),
  cancelled: new Set([
    "ready",
    "in_progress",
    "picking",
    "picked",
    "packing",
    "packed",
    "completed",
    "ready_to_ship",
    "partially_shipped",
    "on_hold",
    "exception",
    "awaiting_3pl",
  ]),
  awaiting_3pl: new Set(["ready", "on_hold"]),
};

export function isWmsOrderTransitionAllowed(
  from: WmsWarehouseStatus,
  to: WmsWarehouseStatus,
): boolean {
  if (from === to) return false;
  const allowedFrom = WMS_WAREHOUSE_STATUS_TRANSITION_MATRIX[to];
  if (!allowedFrom) return false;
  return allowedFrom.has(from);
}

export function isTerminalWmsOrderStatus(status: WmsWarehouseStatus): boolean {
  return TERMINAL_WMS_WAREHOUSE_STATUSES.has(status);
}

export function allowedWmsOrderFromStatuses(
  to: WmsWarehouseStatus,
): WmsWarehouseStatus[] {
  const allowed = WMS_WAREHOUSE_STATUS_TRANSITION_MATRIX[to];
  if (!allowed) return [];
  return WMS_WAREHOUSE_STATUS_VALUES.filter((s) => allowed.has(s));
}
