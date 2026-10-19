import { describe, expect, it } from "vitest";
import { purchaseOrderFinancialDisplay } from "../../po-financial-display";
import { financialWorkflowFixture } from "../../../../../test/fixtures/po-financial-workflow";
describe("canonical PO financial display", () => {
  it.each([["unbilled", "Not invoiced"], ["review_required", "Review required"], ["awaiting_approval", "Awaiting invoice approval"], ["payment_due", "Payment due"], ["settled", "Settled"]] as const)("shows %s from verified evidence", (state, label) => {
    expect(purchaseOrderFinancialDisplay(17, financialWorkflowFixture(17, state))).toEqual({ state, label });
  });
  it.each([undefined, {}, { state: "paid" }, financialWorkflowFixture(99, "settled"), { ...financialWorkflowFixture(17, "payment_due"), state: "settled" }])("does not fall back to cached paid for malformed evidence %j", raw => {
    expect(purchaseOrderFinancialDisplay(17, raw)).toEqual({ state: null, label: "Financial evidence unavailable" });
  });
});
