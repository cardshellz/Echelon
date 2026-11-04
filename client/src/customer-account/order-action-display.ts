import type { CustomerOrderActions } from "@shared/customer-account/order-actions";

/** Browser-only presentation memory. The current lookup remains separate so
 * refreshing work is still observed. Neither value authorizes a command. */
export function retainedOrderActions(
  current: CustomerOrderActions,
  previous?: CustomerOrderActions,
): CustomerOrderActions | undefined {
  if (current.state === "not_managed" || current.omsOrderId === null)
    return undefined;
  if (
    previous?.state !== "ready" ||
    current.externalOrderId !== previous.externalOrderId ||
    current.orderReference !== previous.orderReference ||
    current.omsOrderId !== previous.omsOrderId
  )
    return current.state === "ready" ? current : undefined;
  if (current.state === "ready") {
    const currentSnapshot = current.snapshot!;
    const previousSnapshot = previous.snapshot!;
    // An unavailable owner is not a verified policy denial. Preserve its last
    // display, but keep the new failure flag so the UI exposes a read retry.
    if (
      (currentSnapshot.orderFailed && previousSnapshot.order) ||
      (currentSnapshot.returnFailed && previousSnapshot.returnOrder)
    )
      return {
        ...current,
        snapshot: {
          ...currentSnapshot,
          order: currentSnapshot.orderFailed
            ? previousSnapshot.order
            : currentSnapshot.order,
          returnOrder: currentSnapshot.returnFailed
            ? previousSnapshot.returnOrder
            : currentSnapshot.returnOrder,
        },
      };
    return current;
  }
  return previous;
}
