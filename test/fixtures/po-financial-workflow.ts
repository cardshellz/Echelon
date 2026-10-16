import type { PoFinancialWorkflow } from "../../shared/procurement/po-financial-workflow";

/** Fictional, internally consistent evidence for read-side workflow acceptance. */
export function financialWorkflowFixture(
  purchaseOrderId: number,
  state: PoFinancialWorkflow["state"],
): PoFinancialWorkflow {
  const unbilled = state === "unbilled";
  const review = state === "review_required";
  const settled = state === "settled";
  return {
    purchaseOrderId,
    state,
    evidence: {
      purchaseOrderId,
      currency: "USD",
      state: review ? "review_required" : "complete",
      invoiceCount: unbilled ? 0 : 1,
      invoicedAmountCents: unbilled ? 0 : 10000,
      paidAmountCents: review ? null : settled ? 10000 : 0,
      outstandingAmountCents: review ? null : unbilled || settled ? 0 : 10000,
      reviewReasons: review ? [{ code: "PO_SHARED_INVOICE_PARTIAL_PAYMENT", invoiceId: 71,
        message: "A shared invoice has a partial payment without a recorded PO split." }] : [],
    },
  };
}
