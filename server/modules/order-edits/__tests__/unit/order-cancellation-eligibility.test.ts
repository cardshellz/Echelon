import { describe, expect, it } from "vitest";
import { orderCancellationEligibilityReasons } from "../../domain/order-cancellation-eligibility";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";
import { cancellationPaymentsSettled } from "../../../customer-account/application/order-cancellation.ports";
import { settledRefundEditFixture } from "../fixtures/settled-refund-edit.fixture";

describe("customer cancellation boundary", () => {
  function refundedSnapshot(refundCents: number) {
    const operation = settledRefundEditFixture("00000000-0000-4000-8000-000000000001", new Date("2026-10-24T12:00:00Z"));
    const snapshot = structuredClone(operation.lastSnapshot!);
    snapshot.customerId = "gid://shopify/Customer/8";
    snapshot.totalCents = 900;
    snapshot.fullyPaid = false;
    snapshot.netPaidCents = 1000 - refundCents;
    snapshot.refunds[0].amountCents = refundCents;
    snapshot.refunds[0].transactions[0].amountCents = refundCents;
    snapshot.transactions[1].amountCents = refundCents;
    return snapshot;
  }
  it.each([200,1000])("permits a separately requested cancellation after a verified settled %s-cent refund", refundCents => {
    expect(orderCancellationEligibilityReasons({ snapshot: refundedSnapshot(refundCents), enabled: true,
      warehouseReasons: [], activeOperationId: null, allowSettledRefundBalance: true })).toEqual([]);
    expect(orderCancellationEligibilityReasons({ snapshot: refundedSnapshot(refundCents), enabled: true,
      warehouseReasons: [], activeOperationId: null })).not.toEqual([]);
  });
  it.each(["pending", "unpaid", "mismatch", "outstanding", "capturable", "picking", "active", "missing_parent", "wrong_gateway", "over_refund"])(
    "keeps %s protection when cancelling a previously refunded order", kind => {
      const snapshot = refundedSnapshot(1000);
      if (kind === "pending") { snapshot.refunds[0].transactions[0].status = "PENDING"; snapshot.transactions[1].status = "PENDING"; }
      if (kind === "unpaid") { snapshot.totalCents = 2000; }
      if (kind === "mismatch") { snapshot.netPaidCents = 1; }
      if (kind === "outstanding") { snapshot.outstandingCents = 1; }
      if (kind === "capturable") { snapshot.capturableCents = 1; }
      if (kind === "missing_parent") { snapshot.refunds[0].transactions[0].parentId = null; snapshot.transactions[1].parentId = null; }
      if (kind === "wrong_gateway") { snapshot.refunds[0].transactions[0].gateway = "different"; snapshot.transactions[1].gateway = "different"; }
      if (kind === "over_refund") { snapshot.refunds[0].transactions[0].amountCents = 1001; snapshot.transactions[1].amountCents = 1001; }
      expect(orderCancellationEligibilityReasons({ snapshot, enabled: true, allowSettledRefundBalance: true,
        warehouseReasons: kind === "picking" ? ["Picking started"] : [], activeOperationId: kind === "active" ? "owned-edit" : null })).not.toEqual([]);
    });
  it("rejects contradictory refund-parent evidence through the existing settlement validator", () => {
    const snapshot = refundedSnapshot(1000);
    snapshot.transactions[1].parentId = "gid://shopify/OrderTransaction/99";
    expect(() => orderCancellationEligibilityReasons({ snapshot, enabled: true, allowSettledRefundBalance: true,
      warehouseReasons: [], activeOperationId: null })).toThrow(expect.objectContaining({ code: "ORDER_EDIT_PAYMENT_EVIDENCE_CONFLICT" }));
  });
  it("permits paid US physical pre-pick orders independently of replacement editability", () => {
    const snapshot = {
      ...serviceHarness().snapshot(),
      editable: false,
      editableErrors: ["Replacement edits unavailable"],
    };
    expect(
      orderCancellationEligibilityReasons({
        snapshot,
        enabled: true,
        warehouseReasons: [],
        activeOperationId: null,
      }),
    ).toEqual([]);
  });
  it.each([
    "cancelled",
    "closed",
    "picking",
    "fulfilled",
    "unsupported",
    "foreign",
    "guest",
    "disabled",
    "active",
    "unpaid",
    "outstanding",
    "capturable",
    "partially_refunded",
    "pending_payment",
    "pending_nested_refund",
  ])("refuses unsupported cancellation: %s", (kind) => {
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
    const transaction = {
      id: "pending",
      parentId: null,
      kind: "REFUND",
      status: "PENDING",
      gateway: "manual",
      amountCents: 100,
      manual: true,
    };
    if (kind === "pending_payment") snapshot.transactions = [transaction];
    if (kind === "pending_nested_refund")
      snapshot.refunds = [
        {
          id: "refund",
          amountCents: 100,
          note: null,
          transactions: [transaction],
        },
      ];
    expect(
      orderCancellationEligibilityReasons({
        snapshot,
        enabled: kind !== "disabled",
        warehouseReasons: kind === "picking" ? ["Picking started"] : [],
        activeOperationId: kind === "active" ? "active" : null,
      }).length,
    ).toBeGreaterThan(0);
  });
  it("does not finish on a pending refund carried only by the refund record", () => {
    const snapshot = {
      ...serviceHarness().snapshot(),
      cancelled: true,
      netPaidCents: 0,
    };
    expect(cancellationPaymentsSettled(snapshot)).toBe(true);
    snapshot.refunds = [
      {
        id: "refund",
        amountCents: 0,
        note: null,
        transactions: [
          {
            id: "pending",
            parentId: null,
            kind: "REFUND",
            status: "PENDING",
            gateway: "manual",
            amountCents: 0,
            manual: true,
          },
        ],
      },
    ];
    expect(cancellationPaymentsSettled(snapshot)).toBe(false);
  });
  it("validates the complete purchased-line set before offering cancellation", () => {
    const snapshot = structuredClone(serviceHarness().snapshot());
    const reasons = () =>
      orderCancellationEligibilityReasons({
        snapshot,
        enabled: true,
        warehouseReasons: [],
        activeOperationId: null,
      });
    snapshot.lines = Array.from({ length: 100 }, (_, index) => ({
      ...snapshot.lines[0],
      id: `gid://shopify/LineItem/${index + 1}`,
    }));
    expect(reasons()).toEqual([]);
    snapshot.lines.push({
      ...snapshot.lines[0],
      id: "gid://shopify/LineItem/101",
    });
    expect(reasons()).toContain("Contact us to cancel this order.");
    snapshot.lines = [snapshot.lines[0], snapshot.lines[0]];
    expect(reasons()).toContain("Contact us to cancel this order.");
    snapshot.lines = [];
    expect(reasons()).toContain("Contact us to cancel this order.");
  });
});
