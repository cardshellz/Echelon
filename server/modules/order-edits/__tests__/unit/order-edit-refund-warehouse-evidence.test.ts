import { describe, expect, it } from "vitest";
import { proveStoppedRefundEditRecovery } from "../../infrastructure/order-edit-refund-warehouse-evidence";
import { settledRefundEditFixture } from "../fixtures/settled-refund-edit.fixture";

const OP = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const document = settledRefundEditFixture(
    OP,
    new Date("2026-10-24T12:00:00Z"),
  );
  return {
    operationId: OP,
    omsOrderId: 20,
    document,
    snapshot: document.lastSnapshot!,
  };
}
describe("stopped refund edit recovery evidence", () => {
  it("accepts the successful saved refund and exact unfulfilled replacement contents", () => {
    expect(proveStoppedRefundEditRecovery(fixture())).toMatchObject({
      connectionId: 4,
      actorId: "staff",
      refundId: "gid://shopify/Refund/1",
    });
  });
  it.each(["cancelled", "closed"] as const)(
    "rejects a channel order that is %s",
    (field) => {
      const input = fixture();
      input.snapshot[field] = true;
      expect(() => proveStoppedRefundEditRecovery(input)).toThrow();
    },
  );
  it.each(["PENDING", "FAILURE", "UNKNOWN"])(
    "does not reopen work for a %s refund",
    (status) => {
      const input = fixture();
      input.snapshot.refunds[0].transactions[0].status = status;
      expect(() => proveStoppedRefundEditRecovery(input)).toThrow();
    },
  );
  it("blocks an unrelated pending refund recorded only in the nested refund evidence", () => {
    const input = fixture();
    input.snapshot.refunds.push({
      id: "gid://shopify/Refund/3",
      amountCents: 1,
      note: "Other refund",
      transactions: [
        {
          ...input.snapshot.refunds[0].transactions[0],
          id: "gid://shopify/OrderTransaction/3",
          amountCents: 1,
          status: "PENDING",
        },
      ],
    });
    expect(() => proveStoppedRefundEditRecovery(input)).toThrow();
  });
  it.each([
    "amount",
    "parent",
    "gateway",
    "missing",
    "ambiguous",
    "quantity",
    "ownership",
    "unpaid",
  ])("rejects %s mismatch", (kind) => {
    const input = fixture();
    switch (kind) {
      case "amount":
        input.snapshot.refunds[0].amountCents++;
        break;
      case "parent":
        input.snapshot.refunds[0].transactions[0].parentId =
          "gid://shopify/OrderTransaction/3";
        break;
      case "gateway":
        input.snapshot.refunds[0].transactions[0].gateway = "other";
        break;
      case "missing":
        input.snapshot.refunds = [];
        break;
      case "ambiguous":
        input.snapshot.refunds.push({
          ...input.snapshot.refunds[0],
          id: "gid://shopify/Refund/2",
        });
        break;
      case "quantity":
        input.snapshot.lines[1].unfulfilledQuantity = 0;
        break;
      case "ownership":
        input.operationId = "00000000-0000-4000-8000-000000000002";
        break;
      case "unpaid":
        input.snapshot.outstandingCents = 1;
        input.snapshot.fullyPaid = false;
        break;
    }
    expect(() => proveStoppedRefundEditRecovery(input)).toThrow();
  });
});
