export const COMPLETED_AP_PAYMENT_STATUS = "completed";

/** Unknown historical states require review; they must never be reclassified as settlement. */
export function classifyApPaymentState(status: unknown): "settled" | "voided" | "review_required" {
  if (status === COMPLETED_AP_PAYMENT_STATUS) return "settled";
  if (status === "voided") return "voided";
  return "review_required";
}

export function isRecordableApPaymentStatus(status: unknown): boolean {
  return status === undefined || status === COMPLETED_AP_PAYMENT_STATUS;
}
