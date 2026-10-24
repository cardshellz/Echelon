/** Money returned does not cancel the purchased merchandise. Only channel cancellation does. */
export function isMerchandiseOrderCancelled(order: {
  status: string | null | undefined;
  cancelledAt?: Date | string | null;
}): boolean {
  return String(order.status ?? "").toLowerCase() === "cancelled" || order.cancelledAt != null;
}

