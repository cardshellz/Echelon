import { describe, expect, it } from "vitest";
import { canObserveOrderEditRefundReview } from "../../domain/order-edit-refund-recovery";

const recoverable = {
  status: "review_required",
  errorCode: "REFUND_UNCONFIRMED",
  cancellation: false,
  submitted: true,
  refundRequested: true,
};

describe("read-only refund review recovery admission", () => {
  it("observes an owned submitted refund after a legacy warehouse cutoff without rollout configuration", () => {
    expect(canObserveOrderEditRefundReview({ ...recoverable, errorCode: "ORDER_EDIT_PICKING_CUTOFF" })).toBe(true);
  });
  it("admits incomplete refund readback and its subsequent observation retry", () => {
    expect(canObserveOrderEditRefundReview(recoverable)).toBe(true);
    expect(
      canObserveOrderEditRefundReview({
        ...recoverable,
        errorCode: "ORDER_EDIT_REFUND_REVIEW_READBACK_PENDING",
      }),
    ).toBe(true);
  });
  it.each([
    { cancellation: true },
    { submitted: false },
    { refundRequested: false },
    { status: "completed" },
    { errorCode: null },
    { errorCode: "REFUND_FAILED" },
    { errorCode: "REFUND_AMBIGUOUS" },
    { errorCode: "REFUND_REVIEW_EVIDENCE_MISMATCH" },
    { errorCode: "ORDER_EDIT_NEWER_SOURCE_CONFLICT" },
  ])("preserves unrelated or unprovable review states: %j", (patch) => {
    expect(canObserveOrderEditRefundReview({ ...recoverable, ...patch })).toBe(
      false,
    );
  });
});
