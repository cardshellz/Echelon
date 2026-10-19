import { poFinancialWorkflowSchema, type PoFinancialWorkflow } from "@shared/procurement/po-financial-workflow";

export const PO_FINANCIAL_WORKFLOW_LABELS: Record<PoFinancialWorkflow["state"], string> = {
  unbilled: "Not invoiced", review_required: "Review required", awaiting_approval: "Awaiting invoice approval",
  payment_due: "Payment due", settled: "Settled",
};

/** Cached invoice status cannot establish this purchase order's financial position. */
export function purchaseOrderFinancialDisplay(purchaseOrderId: number, raw: unknown): { label: string; state: PoFinancialWorkflow["state"] | null } {
  const parsed = poFinancialWorkflowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.purchaseOrderId !== purchaseOrderId) return { label: "Financial evidence unavailable", state: null };
  return { label: PO_FINANCIAL_WORKFLOW_LABELS[parsed.data.state], state: parsed.data.state };
}
