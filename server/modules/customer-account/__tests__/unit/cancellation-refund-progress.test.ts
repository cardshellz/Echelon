import { describe, expect, it } from "vitest";
import { serviceHarness } from "../../../order-edits/__tests__/fixtures/order-edit-service.fixture";
import { presentCancellationRefundProgress } from "../../domain/cancellation-refund-progress";

function evidence() {
  const snapshot = serviceHarness().snapshot();
  const sale = { id: "sale-1", kind: "SALE", status: "SUCCESS", amountCents: snapshot.netPaidCents,
    parentId: null, gateway: "manual", manual: true };
  const baseline = { ...snapshot, transactions: [sale] };
  const refund = { ...sale, id: "refund-1", kind: "REFUND", parentId: sale.id, status: "PENDING" };
  const pending = { ...baseline, cancelled: true, fullyPaid: false, totalCents: 0, transactions: [sale, refund] };
  return { baseline, pending, amount: snapshot.netPaidCents };
}
describe("cancellation refund presentation retains financial evidence", () => {
  it("keeps a zero-total cancelled order processing while the original refund is pending", () => {
    const h = evidence();
    expect(presentCancellationRefundProgress(h.baseline,h.pending,h.amount).code).toBe("processing");
    expect(presentCancellationRefundProgress(h.baseline,{...h.pending,netPaidCents:0},h.amount).code).toBe("processing");
  });
  it("requires successful matched receipts, not operation or warehouse completion", () => {
    const h=evidence();
    const settled={...h.pending,netPaidCents:0,transactions:h.pending.transactions.map(t=>({...t,status:"SUCCESS"}))};
    expect(presentCancellationRefundProgress(h.baseline,settled,h.amount).code).toBe("completed");
    expect(presentCancellationRefundProgress(h.baseline,settled,h.amount-1).code).toBe("processing");
    expect(presentCancellationRefundProgress(h.baseline,{...settled,capturableCents:1},h.amount).code).toBe("processing");
  });
  it.each(["FAILURE","ERROR"])("shows an actual %s refund without blaming return or delivery",status=>{
    const h=evidence();
    expect(presentCancellationRefundProgress(h.baseline,{...h.pending,transactions:h.pending.transactions.map(t=>t.kind==="REFUND"?{...t,status}:t)},h.amount).code).toBe("failed");
  });
  it("does not fabricate a refund for a free order",()=>{const h=evidence();expect(presentCancellationRefundProgress(h.baseline,null,0).code).toBe("not_required");});
  it.each([-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid cents %s",amount=>{
    const h=evidence();expect(()=>presentCancellationRefundProgress(h.baseline,h.pending,amount)).toThrow();
  });
});
