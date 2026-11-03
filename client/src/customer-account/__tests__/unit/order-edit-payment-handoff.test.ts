import { describe, expect, it } from "vitest";
import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import { orderEditPaymentDestination } from "../../order-edit-payment-handoff";
import {
  orderEditHasEditableDraft,
  orderEditNeedsPreparation,
} from "@/lib/order-edit-confirmation";

const approved = "11111111-1111-4111-8111-111111111111";
const operation: OrderEditOperation = {
  operationId: approved,
  orderNumber: "#TEST",
  currency: "USD",
  canAbandon: false,
  previousTotalCents: 1005,
  updatedTotalCents: 1481,
  balanceDueCents: 476,
  refundDueCents: 0,
  lines: [],
  warnings: [],
  expiresAt: null,
  paymentDeadline: "2026-11-03T22:00:00Z",
  status: "awaiting_payment",
  paymentUrl: "https://shop.test/pay",
  error: null,
};

describe("payment handoff after explicit Apply", () => {
  it("does not mistake an interrupted committing record for an editable draft", () => {
    const draft = {
      ...operation,
      canAbandon: true,
      requestedPlan: { changes: [], additions: [] },
    };
    expect(orderEditHasEditableDraft({ ...draft, status: "ready" })).toBe(true);
    expect(orderEditHasEditableDraft({ ...draft, status: "committing" })).toBe(
      false,
    );
    expect(
      orderEditHasEditableDraft({
        ...draft,
        status: "ready",
        commandInProgress: true,
      }),
    ).toBe(false);
    expect(
      orderEditNeedsPreparation(
        { ...draft, status: "review_required", commandInProgress: true },
        0,
      ),
    ).toBe(false);
  });
  it("opens only the payment for this tab's approved operation", () => {
    expect(orderEditPaymentDestination(operation, approved)).toBe(
      "https://shop.test/pay",
    );
    expect(orderEditPaymentDestination(operation, null)).toBeNull();
    expect(
      orderEditPaymentDestination(
        operation,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toBeNull();
  });
  it.each([
    "ready",
    "committing",
    "completed",
    "refunding",
    "review_required",
    "recovering",
    "recovered",
    "failed",
    "expired",
  ] as const)(
    "does not navigate from %s even if a stale payment URL remains",
    (status) => {
      expect(
        orderEditPaymentDestination({ ...operation, status }, approved),
      ).toBeNull();
    },
  );
  it.each([
    { commandInProgress: true },
    { balanceDueCents: 0 },
    { paymentUrl: null },
    { paymentUrl: "javascript:alert(1)" },
    { paymentUrl: "https://user:pass@shop.test/pay" },
    { error: { code: "ORDER_EDIT_PAYMENT_PENDING", message: "Processing" } },
  ])("waits for verified payable evidence: %j", (patch) => {
    expect(
      orderEditPaymentDestination({ ...operation, ...patch }, approved),
    ).toBeNull();
  });
});
