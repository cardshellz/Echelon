import type { CustomerOrderActionSnapshot } from "@shared/customer-account/order-actions";

/** Only complete evidence with no customer action may wait for demand or an
 * invalidation. Cached evidence still expires and cannot authorize commands. */
export function canDeferClosedRefresh(snapshot: CustomerOrderActionSnapshot): boolean {
  const { order, returnOrder } = snapshot;
  if (snapshot.orderFailed || snapshot.returnFailed || order === null || returnOrder === null) return false;
  if (order.activeOperationId || order.activeOperationKind || order.activeOperationStatus) return false;
  if (order.eligibility.editable || order.addressEligibility?.editable !== false) return false;
  if (order.cancellation?.canReview !== false || order.cancellation.requestKey !== null) return false;
  return !returnOrder.order.lines.some(line => line.eligibleQuantity > 0);
}
