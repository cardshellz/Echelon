import type { CustomerAccountOrderSummary } from "@shared/customer-account/customer-account-orders";
import type { CustomerOrderActions } from "@shared/customer-account/order-actions";
import { CANCELLATION_REFUND_PROGRESS_KEY_PREFIX } from "@shared/customer-account/order-progress";

export const ACCOUNT_SETTLEMENT_REFRESH_MS = 5_000;

/** Only visible orders with an unfinished cancellation are observed. Completion
 * stops reads even when the independent action cache still holds an older phase. */
export function needsCancellationSettlementRefresh(summary: Pick<CustomerAccountOrderSummary, "financialStatus" | "progress"> | null, actions?: CustomerOrderActions): boolean {
  const refunds = summary?.progress?.refunds.filter(item => item.key.startsWith(CANCELLATION_REFUND_PROGRESS_KEY_PREFIX)) ?? [];
  if (summary?.financialStatus.toLowerCase() === "refunded") return false;
  if (refunds.some(item => item.status.code === "processing")) return true;
  if (refunds.some(item => ["completed", "not_required", "failed"].includes(item.status.code))) return false;
  const operation = actions?.state === "ready" ? actions.snapshot?.order : null;
  return operation?.activeOperationKind === "cancel_order" && Boolean(operation.activeOperationId)
    && !["completed", "recovered", "failed", "expired", "review_required"].includes(operation.activeOperationStatus ?? "");
}
