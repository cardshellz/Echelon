import { describe, expect, it } from "vitest";
import { orderCancellationEligibilityReasons } from "../../domain/order-cancellation-eligibility";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";
import { cancellationPaymentsSettled } from "../../../customer-account/application/order-cancellation.ports";

describe("customer cancellation boundary", () => {
  it("permits paid US physical pre-pick orders independently of replacement editability", () => {
    const snapshot = { ...serviceHarness().snapshot(), editable: false, editableErrors: ["Replacement edits unavailable"] };
    expect(orderCancellationEligibilityReasons({ snapshot, enabled: true, warehouseReasons: [], activeOperationId: null })).toEqual([]);
  });
  it.each(["cancelled", "closed", "picking", "fulfilled", "unsupported", "foreign", "guest", "disabled", "active", "unpaid", "outstanding", "capturable", "partially_refunded", "pending_payment", "pending_nested_refund"])("refuses unsupported cancellation: %s", kind => {
    const snapshot = structuredClone(serviceHarness().snapshot());
    if (kind === "cancelled") snapshot.cancelled = true;
    if (kind === "closed") snapshot.closed = true;
    if (kind === "fulfilled") snapshot.lines[0].unfulfilledQuantity = 0;
    if (kind === "unsupported") snapshot.lines[0].unsupported = true;
    if (kind === "foreign") snapshot.evidence.countryCode = "CA";
    if (kind === "guest") snapshot.customerId = null;
    if (kind === "unpaid") snapshot.fullyPaid = false;
    if (kind === "outstanding") snapshot.outstandingCents = 100;
    if (kind === "capturable") snapshot.capturableCents = 100;
    if (kind === "partially_refunded") snapshot.netPaidCents -= 1;
    const transaction = { id: "pending", parentId: null, kind: "REFUND", status: "PENDING", gateway: "manual", amountCents: 100, manual: true };
    if (kind === "pending_payment") snapshot.transactions = [transaction];
    if (kind === "pending_nested_refund") snapshot.refunds = [{ id: "refund", amountCents: 100, note: null, transactions: [transaction] }];
    expect(orderCancellationEligibilityReasons({ snapshot, enabled: kind !== "disabled", warehouseReasons: kind === "picking" ? ["Picking started"] : [], activeOperationId: kind === "active" ? "active" : null }).length).toBeGreaterThan(0);
  });
  it("does not finish on a pending refund carried only by the refund record", () => {
    const snapshot = { ...serviceHarness().snapshot(), cancelled: true, netPaidCents: 0 };
    expect(cancellationPaymentsSettled(snapshot)).toBe(true);
    snapshot.refunds = [{ id: "refund", amountCents: 0, note: null, transactions: [{ id: "pending", parentId: null, kind: "REFUND", status: "PENDING", gateway: "manual", amountCents: 0, manual: true }] }];
    expect(cancellationPaymentsSettled(snapshot)).toBe(false);
  });
});
