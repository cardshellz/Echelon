import {
  OrderEditProviderError,
  type OrderEditRefund,
  type OrderEditRefundIntent,
  type OrderEditRefundResult,
} from "../application/order-edit-provider";

function fail(
  code: string,
  message: string,
  outcome: "rejected" | "unknown" = "rejected",
  context: Record<string, unknown> = {},
): never {
  throw new OrderEditProviderError(code, message, outcome, context);
}
export function matchingRefund(
  refunds: readonly OrderEditRefund[],
  intent: OrderEditRefundIntent,
): OrderEditRefund | null {
  const matches = refunds.filter((entry) => entry.note === intent.note);
  if (matches.length > 1)
    fail(
      "REFUND_AMBIGUOUS",
      "Multiple refunds match this command. Manual reconciliation is required.",
      "unknown",
    );
  return matches[0] ?? null;
}

export function proveRefund(
  actual: OrderEditRefund,
  intent: OrderEditRefundIntent,
): OrderEditRefundResult {
  if (
    actual.note === intent.note &&
    actual.transactions.length === 0 &&
    actual.amountCents === 0
  )
    fail(
      "REFUND_READBACK_PENDING",
      "Waiting for Shopify to confirm the saved refund transaction.",
      "unknown",
    );
  if (actual.note !== intent.note || actual.transactions.length !== 1)
    fail(
      "REFUND_UNCONFIRMED",
      "The refund record does not match the saved request.",
      "unknown",
    );
  const entry = actual.transactions[0];
  if (
    entry.kind !== "REFUND" ||
    entry.parentId !== intent.parentTransactionId ||
    entry.gateway !== intent.gateway ||
    entry.amountCents !== intent.amountCents
  )
    fail(
      "REFUND_UNCONFIRMED",
      "The refund transaction does not match the saved payment evidence.",
      "unknown",
    );
  if (["FAILURE", "ERROR"].includes(entry.status))
    fail(
      "REFUND_FAILED",
      "Shopify recorded a failed refund. Manual reconciliation is required.",
      "unknown",
      { refundId: actual.id, transactionId: entry.id },
    );
  const pending = ["PENDING", "AWAITING_RESPONSE", "UNKNOWN"].includes(
    entry.status,
  );
  // Shopify can report zero in totalRefundedSet while the matching, full-value
  // transaction is pending. That aggregate measures settled money, not the
  // requested refund. Never resend it or report success before settlement.
  if (
    (entry.status !== "SUCCESS" && !pending) ||
    (entry.status === "SUCCESS" && actual.amountCents !== intent.amountCents) ||
    (pending &&
      actual.amountCents !== 0 &&
      actual.amountCents !== intent.amountCents)
  )
    fail(
      "REFUND_UNCONFIRMED",
      "The refund settlement does not match the saved payment evidence.",
      "unknown",
    );
  return {
    status: pending ? "pending" : "succeeded",
    refundId: actual.id,
    evidence: actual,
  };
}
