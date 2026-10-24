/** These review states permit observation of an existing refund, never a new
 * financial submission. Keep scheduler admission and application policy aligned. */
export const ORDER_EDIT_REFUND_REVIEW_CODES = [
  "REFUND_UNCONFIRMED",
  "ORDER_EDIT_REFUND_REVIEW_READBACK_PENDING",
] as const;

export function canObserveOrderEditRefundReview(input: {
  status: string;
  errorCode: string | null;
  cancellation: boolean;
  submitted: boolean;
  refundRequested: boolean;
}): boolean {
  return (
    input.status === "review_required" &&
    !input.cancellation &&
    input.submitted &&
    input.refundRequested &&
    ORDER_EDIT_REFUND_REVIEW_CODES.some((code) => code === input.errorCode)
  );
}
