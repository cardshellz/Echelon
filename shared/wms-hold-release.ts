/**
 * Hold-release policy, shared by the Orders page and the release endpoints.
 *
 * Two kinds of hold exist (LINE-ITEM-HOLD-DESIGN.md):
 *   - order-level: wms.orders.on_hold = 1. The whole order waits, and every
 *     pushed shipment of it is held in ShipStation.
 *   - line-level: wms.order_items.on_hold = true. One line sits in its own held
 *     shipment that is never pushed; the rest of the order ships.
 *
 * The server enforces these rules. The client calls the same functions only to
 * decide which release buttons to offer, so the two cannot disagree.
 */

/** Once an order shipped or was cancelled there is nothing left to release. */
export const WMS_TERMINAL_ORDER_STATUSES = ["shipped", "cancelled"] as const;

/**
 * A held line stops waiting once it can no longer ship. Same rule as the pick
 * queue's held-line check (orders.storage.ts getPickQueueOrders).
 */
export const WMS_CLOSED_LINE_STATUSES = ["cancelled", "completed", "short"] as const;

export const WMS_HOLD_RELEASE_ERROR_CODES = {
  invalidId: "WMS_HOLD_RELEASE_INVALID_ID",
  notFound: "WMS_HOLD_RELEASE_NOT_FOUND",
  orderTerminal: "WMS_HOLD_RELEASE_ORDER_TERMINAL",
  orderOnHold: "WMS_HOLD_RELEASE_ORDER_ON_HOLD",
  pushEnqueueFailed: "WMS_HOLD_RELEASE_PUSH_ENQUEUE_FAILED",
  sortRankFailed: "WMS_HOLD_RELEASE_SORT_RANK_FAILED",
} as const;

export type WmsHoldReleaseErrorCode =
  (typeof WMS_HOLD_RELEASE_ERROR_CODES)[keyof typeof WMS_HOLD_RELEASE_ERROR_CODES];

export interface HoldOrderState {
  onHold?: number | boolean | null;
  warehouseStatus?: string | null;
}

export interface HoldLineState {
  onHold?: boolean | null;
  status?: string | null;
  quantity?: number | null;
}

const TERMINAL_ORDER_STATUSES = new Set<string>(WMS_TERMINAL_ORDER_STATUSES);
const CLOSED_LINE_STATUSES = new Set<string>(WMS_CLOSED_LINE_STATUSES);

/** wms.orders.id and wms.order_items.id are Postgres `integer` columns. */
const MAX_WMS_RECORD_ID = 2_147_483_647;

/**
 * Strict id from a route parameter: plain decimal digits within the integer
 * column range. Anything else ("1e3", "-1", "12abc", "0") is rejected so it
 * becomes a 400, never a database error.
 */
export function parseWmsRecordId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_WMS_RECORD_ID ? parsed : null;
}

export function normalizeWmsStatus(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

/** The order-level flag is set. This is the only thing release-hold clears. */
export function hasOrderHoldFlag(order: HoldOrderState): boolean {
  return order.onHold === true || Number(order.onHold ?? 0) === 1;
}

/**
 * The whole order is held: the flag, or the legacy 'on_hold' warehouse status.
 * Nothing writes that status any more, but readers (claim dispatch, listing)
 * still treat it as held, so this does too.
 */
export function isOrderLevelHold(order: HoldOrderState): boolean {
  return hasOrderHoldFlag(order) || normalizeWmsStatus(order.warehouseStatus) === "on_hold";
}

export function isTerminalOrder(order: HoldOrderState): boolean {
  return TERMINAL_ORDER_STATUSES.has(normalizeWmsStatus(order.warehouseStatus));
}

/** A held line that is still waiting to ship. */
export function isOpenHeldLine(line: HoldLineState): boolean {
  return line.onHold === true
    && Number(line.quantity ?? 0) > 0
    && !CLOSED_LINE_STATUSES.has(normalizeWmsStatus(line.status));
}

export type OrderHoldReleaseDecision = "release" | "not_held" | "order_terminal" | "not_found";

/**
 * Releasing an order that is not held is a no-op, so a double click or a
 * second operator never re-runs the ShipStation release, re-reservation and
 * push. A held order that already shipped or was cancelled is refused: the
 * release side effects would reserve or push work for an order that is over.
 */
export function decideOrderHoldRelease(
  order: HoldOrderState | null | undefined,
): OrderHoldReleaseDecision {
  if (!order) return "not_found";
  if (!hasOrderHoldFlag(order)) return "not_held";
  if (isTerminalOrder(order)) return "order_terminal";
  return "release";
}

export type LineHoldReleaseDecision =
  | "release"
  | "not_held"
  | "order_on_hold"
  | "order_terminal"
  | "not_found";

export interface LineHoldReleaseInput {
  wmsOrderId: number;
  order: (HoldOrderState & { id: number }) | null | undefined;
  line: (HoldLineState & { orderId: number }) | null | undefined;
}

/**
 * Releasing a line pushes its held shipment to ShipStation as a normal,
 * shippable order. While the whole order is still held that push would let the
 * line ship anyway — the push path does not read the order-level flag — so the
 * order hold must be released first.
 */
export function decideLineHoldRelease(input: LineHoldReleaseInput): LineHoldReleaseDecision {
  const { order, line, wmsOrderId } = input;
  if (!order || !line || order.id !== wmsOrderId || line.orderId !== wmsOrderId) return "not_found";
  if (line.onHold !== true) return "not_held";
  if (isTerminalOrder(order)) return "order_terminal";
  if (isOrderLevelHold(order)) return "order_on_hold";
  return "release";
}

/** Operator-facing reason for a refused release. */
export function holdReleaseRefusalMessage(
  decision: Exclude<OrderHoldReleaseDecision | LineHoldReleaseDecision, "release" | "not_held">,
  orderStatus?: string | null,
): string {
  switch (decision) {
    case "not_found":
      return "Order or line not found";
    case "order_terminal":
      return `This order is ${normalizeWmsStatus(orderStatus) || "closed"}; there is nothing left to release`;
    case "order_on_hold":
      return "The whole order is on hold. Release the order hold first, then release this line";
  }
}
