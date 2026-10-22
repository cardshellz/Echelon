import type { OrderEditSnapshot } from "../application/order-edit-provider";
import { orderEditHasUnresolvedPayment } from "../application/order-edit-identity";

/** Customer self-service uses the existing pre-pick warehouse cutoff. Shopify
 * editability is not cancellation authority: cancellation does not replace lines
 * or reapply discounts. The confirmation command rechecks every condition. */
export function orderCancellationEligibilityReasons(input: {
  snapshot: OrderEditSnapshot;
  warehouseReasons: readonly string[];
  activeOperationId: string | null;
  enabled: boolean;
}): string[] {
  const { snapshot } = input;
  const reasons: string[] = [];
  if (!input.enabled)
    reasons.push("Online order changes are unavailable. Contact us for help.");
  if (input.activeOperationId)
    reasons.push(
      "Finish or cancel the existing order update before cancelling this order.",
    );
  if (snapshot.cancelled || snapshot.closed)
    reasons.push("This order is already cancelled or closed.");
  if (
    input.warehouseReasons.length ||
    snapshot.lines.some((line) => line.quantity !== line.unfulfilledQuantity)
  )
    reasons.push(
      "This order can no longer be cancelled online. Contact us for help.",
    );
  if (
    !snapshot.fullyPaid ||
    snapshot.outstandingCents !== 0 ||
    snapshot.capturableCents !== 0 ||
    snapshot.netPaidCents !== snapshot.totalCents ||
    orderEditHasUnresolvedPayment(snapshot) ||
    snapshot.refunds.some((refund) =>
      refund.transactions.some(
        (transaction) =>
          !["SUCCESS", "FAILURE", "ERROR"].includes(transaction.status),
      ),
    )
  )
    reasons.push(
      "A payment or refund needs to finish before this order can be cancelled online.",
    );
  if (
    !snapshot.customerId ||
    snapshot.evidence.countryCode !== "US" ||
    snapshot.lines.some((line) => line.quantity > 0 && line.unsupported) ||
    !snapshot.lines.some((line) => line.quantity > 0)
  )
    reasons.push("Contact us to cancel this order.");
  return reasons;
}
