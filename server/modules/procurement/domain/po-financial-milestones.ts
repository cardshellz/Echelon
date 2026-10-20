import { z } from "zod";
import { poFinancialWorkflowSchema, type PoFinancialWorkflow } from "@shared/procurement/po-financial-workflow";

interface FinancialMilestones {
  firstInvoicedAt: unknown;
  firstPaidAt: unknown;
  fullyPaidAt: unknown;
}

/** Record only a newly observed, proven milestone. Historical stamps remain
 * immutable, and missing attribution never supplies a zero or a payment split.
 * The caller supplies the command time and reads the workflow under its locks. */
export function buildPoFinancialMilestonePatch(input: {
  workflow: PoFinancialWorkflow;
  existing: FinancialMilestones;
  now: Date;
}): Partial<Record<keyof FinancialMilestones, Date>> {
  const workflow = poFinancialWorkflowSchema.parse(input.workflow);
  const now = z.date().parse(input.now);
  const patch: Partial<Record<keyof FinancialMilestones, Date>> = {};
  const evidence = workflow.evidence;
  if (evidence.state !== "complete") return patch;
  if (evidence.invoiceCount > 0 && input.existing.firstInvoicedAt == null) {
    patch.firstInvoicedAt = new Date(now.getTime());
  }
  if (evidence.paidAmountCents !== null && evidence.paidAmountCents > 0 && input.existing.firstPaidAt == null) {
    patch.firstPaidAt = new Date(now.getTime());
  }
  if (workflow.state === "settled" && (workflow.evidence.creditedAmountCents ?? 0) === 0 && input.existing.fullyPaidAt == null) {
    patch.fullyPaidAt = new Date(now.getTime());
  }
  return patch;
}
