import {
  poFinancialWorkflowSchema,
  type PoFinancialWorkflow,
} from "@shared/procurement/po-financial-workflow";
import {
  buildPoFinancialEvidence,
  type PoFinancialEvidenceInput,
} from "./po-financial-evidence";

/** Invoice approval/dispute state supplements exact amounts. Neither a legacy
 * cache nor an exact zero balance proves that an invoice has been closed out. */
export function buildPoFinancialWorkflow(
  input: PoFinancialEvidenceInput,
): PoFinancialWorkflow {
  const evidence = buildPoFinancialEvidence(input);
  let state: PoFinancialWorkflow["state"] = "review_required";

  // Complete evidence has already validated every active invoice. Incomplete
  // evidence may contain malformed records; never inspect them as typed invoices.
  if (evidence.state === "complete") {
    const active = input.invoices.filter(
      (invoice) => invoice.status !== "voided",
    );
    if (active.length === 0) state = "unbilled";
    else if (active.some((invoice) => invoice.status === "disputed")) {
      state = "review_required";
    } else if (active.some((invoice) => invoice.status === "received")) {
      state = "awaiting_approval";
    } else if (
      evidence.outstandingAmountCents === 0 &&
      active.every((invoice) => invoice.status === "paid")
    ) {
      state = "settled";
    } else if (
      evidence.outstandingAmountCents !== null &&
      evidence.outstandingAmountCents > 0 &&
      active.every((invoice) =>
        ["approved", "partially_paid", "paid"].includes(invoice.status),
      )
    ) {
      state = "payment_due";
    }
    // Approved zero-value documents and zero-value shares of open invoices still
    // need an explicit invoice closeout. No payment split or status is invented.
  }

  return poFinancialWorkflowSchema.parse({
    purchaseOrderId: evidence.purchaseOrderId,
    state,
    evidence,
  });
}
