import type { OrderEditSnapshot } from "../application/order-edit-provider";
import { isOrderCancellationPaymentSettled } from "./order-edit-financials";
import { orderEditPlanInputSchema } from "@shared/order-edits/order-edit.contract";

/** The existing operation document records the purchased lines being cancelled.
 * Reuse its validation before offering confirmation, rather than discovering an
 * unsupported or malformed line set after the customer has approved it. */
export function orderCancellationLineEvidence(
  snapshot: OrderEditSnapshot,
): Array<{ lineItemId: string; quantity: 0 }> {
  return snapshot.lines
    .filter((line) => line.quantity > 0)
    .map((line) => ({ lineItemId: line.id, quantity: 0 }));
}

/** Customer self-service uses the existing pre-pick warehouse cutoff. Shopify
 * editability is not cancellation authority: cancellation does not replace lines
 * or reapply discounts. The confirmation command rechecks every condition. */
export function orderCancellationEligibilityReasons(input: {
  snapshot: OrderEditSnapshot;
  warehouseReasons: readonly string[];
  activeOperationId: string | null;
  activeOperationStatus?: string;
  enabled: boolean;
  allowSettledRefundBalance?: boolean;
}): string[] {
  const { snapshot } = input;
  const reasons: string[] = [];
  if (!input.enabled)
    reasons.push("Online order changes are unavailable. Contact us for help.");
  if (input.activeOperationId)
    reasons.push(
      input.activeOperationStatus === "review_required"
        ? "Your previous order update needs review before you can cancel this order online. Contact us for help."
        : "Finish or cancel the existing order update before cancelling this order.",
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
    !isOrderCancellationPaymentSettled(snapshot, input.allowSettledRefundBalance)
  )
    reasons.push(
      "A payment or refund needs to finish before this order can be cancelled online.",
    );
  if (
    !snapshot.customerId ||
    snapshot.evidence.countryCode !== "US" ||
    snapshot.lines.some((line) => line.quantity > 0 && line.unsupported) ||
    !orderEditPlanInputSchema.safeParse({
      changes: orderCancellationLineEvidence(snapshot),
      additions: [],
    }).success
  )
    reasons.push("Contact us to cancel this order.");
  return reasons;
}
