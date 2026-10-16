import { z } from "zod";
import {
  poFinancialEvidenceIdSchema,
  poFinancialEvidenceSchema,
} from "./po-financial-evidence";

export const poFinancialWorkflowStateSchema = z.enum([
  "unbilled",
  "review_required",
  "awaiting_approval",
  "payment_due",
  "settled",
]);

/** Current read-only workflow assessment; never authority for a financial write. */
export const poFinancialWorkflowSchema = z
  .object({
    purchaseOrderId: poFinancialEvidenceIdSchema,
    state: poFinancialWorkflowStateSchema,
    evidence: poFinancialEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.purchaseOrderId !== value.evidence.purchaseOrderId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchaseOrderId"],
        message:
          "Workflow and financial evidence must identify the same purchase order.",
      });
    }
    if (value.state === "review_required") return;
    const evidence = value.evidence;
    if (evidence.state !== "complete") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message:
          "A resolved financial workflow state requires complete evidence.",
      });
    }
    if (value.state === "unbilled") {
      if (
        evidence.invoiceCount !== 0 ||
        evidence.invoicedAmountCents !== 0 ||
        evidence.paidAmountCents !== 0 ||
        evidence.outstandingAmountCents !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message:
            "Unbilled requires no active invoices and exact zero amounts.",
        });
      }
    } else if (evidence.invoiceCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "This financial workflow state requires an active invoice.",
      });
    }
    if (value.state === "settled" && evidence.outstandingAmountCents !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Settled requires an exact zero outstanding amount.",
      });
    }
    if (
      value.state === "payment_due" &&
      (evidence.outstandingAmountCents === null ||
        evidence.outstandingAmountCents <= 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Payment due requires a known positive outstanding amount.",
      });
    }
  });

export type PoFinancialWorkflow = z.infer<typeof poFinancialWorkflowSchema>;
