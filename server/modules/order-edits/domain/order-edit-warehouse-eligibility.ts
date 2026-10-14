import {
  isShipmentShipped,
  SHIPMENT_STATUS_VALUES,
} from "@shared/enums/order-status";

export interface OrderEditWarehouseOrderState {
  warehouse_status: string;
  cancelled: boolean;
  /** Missing timestamp evidence must remain blocked, as in the existing guard. */
  started_at?: unknown;
  assigned_picker_id: string | null;
  picked_count: number;
  has_pick_work: boolean;
  has_label: boolean;
  combined_group_id: number | null;
  order_edit_operation_id: string | null;
}

export interface OrderEditWarehouseShipmentState {
  status: string;
  requires_review: boolean;
  shipping_engine: string | null;
}

const editableOrderStatuses = ["pending", "ready", "on_hold"];
const editableShipmentStatuses = ["planned", "queued", "on_hold"];
const preparingOrderStatuses = [
  "in_progress",
  "picking",
  "picked",
  "packing",
  "packed",
  "completed",
  "ready_to_ship",
];
const shippedShipmentStatuses: readonly string[] =
  SHIPMENT_STATUS_VALUES.filter(isShipmentShipped);
const preparingMessage =
  "We're already preparing this order, so it can no longer be edited.";
const shippingPreparationMessage =
  "This order is being prepared for shipping and can no longer be edited.";
const unavailableMessage =
  "This order can't be edited online right now. Please contact us for help.";

function shippingCutoffMessage(
  orders: readonly OrderEditWarehouseOrderState[],
  shipments: readonly OrderEditWarehouseShipmentState[] = [],
): string | null {
  // A shipped partition or shipment proves shipping started, not that every
  // partition shipped. `completed` is also not proof of carrier shipment.
  if (
    orders.length > 0 &&
    orders.every((order) =>
      order.warehouse_status === "shipped" && !order.cancelled,
    )
  )
    return "This order has shipped and can no longer be edited.";
  if (
    orders.some((order) =>
      ["shipped", "partially_shipped"].includes(order.warehouse_status),
    ) ||
    shipments.some((shipment) =>
      shippedShipmentStatuses.includes(shipment.status),
    )
  )
    return "This order has already started shipping and can no longer be edited.";
  return null;
}

function orderCutoffMessage(order: OrderEditWarehouseOrderState): string | null {
  if (order.cancelled || order.warehouse_status === "cancelled")
    return "This order has been canceled and can no longer be edited.";
  if (order.started_at === undefined) return unavailableMessage;
  if (
    order.started_at !== null ||
    order.assigned_picker_id !== null ||
    order.picked_count !== 0 ||
    order.has_pick_work ||
    preparingOrderStatuses.includes(order.warehouse_status)
  )
    return preparingMessage;
  if (order.has_label) return shippingPreparationMessage;
  if (!editableOrderStatuses.includes(order.warehouse_status))
    return unavailableMessage;
  return null;
}

/** Uses the existing shipment cutoff; copy must not turn a label into proof of shipment. */
export function orderEditWarehouseShipmentBlocker(
  orders: readonly OrderEditWarehouseOrderState[],
  shipments: readonly OrderEditWarehouseShipmentState[],
): string | null {
  const blocked = shipments.some(
    (shipment) =>
      shipment.requires_review ||
      !editableShipmentStatuses.includes(shipment.status) ||
      (shipment.shipping_engine !== null &&
        shipment.shipping_engine !== "shipstation"),
  );
  if (!blocked) return null;
  return (
    shippingCutoffMessage(orders, shipments) ??
    orders.map(orderCutoffMessage).find((reason) => reason !== null) ??
    (shipments.some((shipment) => shipment.status === "labeled")
      ? shippingPreparationMessage
      : unavailableMessage)
  );
}

/** Pure pre-picking cutoff. A prior pick/unpick still has started_at and stays blocked. */
export function orderEditWarehouseBlockers(
  orders: readonly OrderEditWarehouseOrderState[],
  operationId?: string,
): string[] {
  const reasons = new Set<string>();
  if (!orders.length)
    reasons.add("This order isn't available to edit yet. Please try again later.");
  const shipping = shippingCutoffMessage(orders);
  if (shipping) reasons.add(shipping);
  for (const order of orders) {
    const cutoff = orderCutoffMessage(order);
    if (cutoff && !shipping) reasons.add(cutoff);
    if (order.combined_group_id !== null) reasons.add(unavailableMessage);
    if (
      order.order_edit_operation_id !== null &&
      order.order_edit_operation_id !== operationId
    )
      reasons.add(
        "This order already has an edit in progress. Finish or cancel that edit before making more changes.",
      );
  }
  return [...reasons];
}
