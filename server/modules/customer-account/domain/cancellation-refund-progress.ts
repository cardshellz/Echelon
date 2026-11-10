import {
  cancellationPaymentsSettled,
  matchesOrderCancellationSettlement,
  presentOrderEditSettlement,
  type OrderEditSnapshot,
} from "../../order-edits/customer-account.api";
import type { CustomerReturnRefundStatus } from "@shared/customer-account/order-progress";

/** Uses the cancellation owner's saved native payment evidence. Neither a zero
 * order total, a cancelled warehouse job nor rewards settlement proves a refund. */
export function presentCancellationRefundProgress(
  baseline: OrderEditSnapshot,
  observed: OrderEditSnapshot | null,
  refundCents: number,
): CustomerReturnRefundStatus {
  if (!Number.isSafeInteger(refundCents) || refundCents < 0) throw new Error("Invalid cancellation refund amount.");
  if (refundCents === 0) return { code: "not_required", label: "No refund required" };
  if (observed && cancellationPaymentsSettled(observed) && matchesOrderCancellationSettlement(baseline, observed, refundCents))
    return { code: "completed", label: "Refund issued" };
  const activity = observed ? presentOrderEditSettlement(observed).activity : [];
  if (activity.some(entry => entry.kind === "refund" && ["FAILURE", "ERROR"].includes(entry.status)))
    return { code: "failed", label: "Refund needs attention" };
  return { code: "processing", label: "Refund processing" };
}
