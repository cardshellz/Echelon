import { z } from "zod";
import { customerReturnCustomerLabelStatusSchema, customerReturnCustomerSubmitInputSchema } from "./customer-return-customer.contract";

export const customerReturnWorkflowPhaseSchema = z.enum([
  "queued", "preparing", "labels", "ready", "retryable_failure", "needs_input", "needs_help",
]);
export type CustomerReturnWorkflowPhase = z.infer<typeof customerReturnWorkflowPhaseSchema>;
export const customerReturnWorkflowReasonSchema = z.enum([
  "RETURN_DETAILS_CHANGED", "RETURN_SHIPPING_UNAVAILABLE", "RETURN_LABEL_RECONCILIATION_REQUIRED",
  "RETURN_WORKFLOW_TEMPORARY_FAILURE", "RETURN_WORKFLOW_NEEDS_HELP",
]);
export type CustomerReturnWorkflowReason = z.infer<typeof customerReturnWorkflowReasonSchema>;
export const customerReturnWorkflowStatusSchema = z.object({
  requestKey: z.string().uuid(),
  omsOrderId: z.number().int().positive().safe(),
  phase: customerReturnWorkflowPhaseSchema,
  reason: customerReturnWorkflowReasonSchema.nullable(),
  labels: customerReturnCustomerLabelStatusSchema.nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  const working = ["queued", "preparing", "labels"].includes(value.phase);
  if ((working || value.phase === "ready") && value.reason !== null)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Working/completed requests cannot report a failure." });
  if (!working && value.phase !== "ready" && value.reason === null)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Failed requests require a reason." });
  if ((value.phase === "labels" || value.phase === "ready") && value.labels === null)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["labels"], message: "Accepted requests require their original authorization." });
  if (value.phase === "ready" && value.labels?.parcels.some(parcel => parcel.status !== "ready" || parcel.downloadPath === null || parcel.trackingNumber === null))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["labels"], message: "Every label must be downloadable before completion." });
  if (value.phase === "needs_input" && value.labels !== null)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["labels"], message: "An accepted return cannot be replaced as a rejected request." });
});
export type CustomerReturnWorkflowStatus = z.infer<typeof customerReturnWorkflowStatusSchema>;
export const customerReturnWorkflowWorking = (phase: CustomerReturnWorkflowPhase): boolean =>
  phase === "queued" || phase === "preparing" || phase === "labels";

export function customerReturnWorkflowMessage(reason: CustomerReturnWorkflowReason): string {
  switch (reason) {
    case "RETURN_DETAILS_CHANGED": return "Your return details changed. Try again to review your items.";
    case "RETURN_SHIPPING_UNAVAILABLE": return "We couldn't get your label. Try again, or contact us for help.";
    case "RETURN_LABEL_RECONCILIATION_REQUIRED": return "We couldn't confirm your label. Your request is saved. Contact us with the return reference so we can finish it safely.";
    case "RETURN_WORKFLOW_TEMPORARY_FAILURE": return "We couldn't finish getting your label. Your selections are saved. Please try again.";
    case "RETURN_WORKFLOW_NEEDS_HELP": return "We couldn't finish getting your label. Contact us with the return reference for help.";
  }
}

/** Restores the customer's own immutable selections after browser storage loss. */
export const customerReturnWorkflowResumeSchema = z.object({
  workflow: customerReturnWorkflowStatusSchema,
  input: customerReturnCustomerSubmitInputSchema,
}).strict().superRefine((value, context) => {
  if (value.workflow.requestKey !== value.input.idempotencyKey)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "The saved request identity changed." });
});
