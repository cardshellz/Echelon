import { z } from "zod";
import { costFingerprintSchema, costIssueSchema } from "./cost-source-contracts";
import { invoiceCostImpactPreviewSchema } from "./invoice-cost-review";
import { poFinancialWorkflowSchema } from "./po-financial-workflow";

export const apInvoiceTransitionActionSchema = z.enum(["approve", "dispute", "void"]);
export type ApInvoiceTransitionAction = z.infer<typeof apInvoiceTransitionActionSchema>;
export const apInvoiceTransitionInputSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  previewVersion: costFingerprintSchema.optional(),
}).strict();
export type ApInvoiceTransitionInput = z.infer<typeof apInvoiceTransitionInputSchema>;
const document = z.object({
  status: z.string().min(1), currency: z.string().regex(/^[A-Z]{3}$/),
  amountCents: z.number().int().safe(), paidCents: z.number().int().safe(), balanceCents: z.number().int().safe(),
  approvedBy: z.string().nullable(), approvedAt: z.string().datetime().nullable(),
}).strict();
export const apInvoiceTransitionPreviewSchema = z.object({
  invoiceId: z.number().int().positive().max(2_147_483_647),
  action: apInvoiceTransitionActionSchema, reason: z.string().trim().min(1).max(2000),
  previewVersion: costFingerprintSchema,
  before: document, after: document,
  impact: invoiceCostImpactPreviewSchema.shape.impact,
  inventoryValues: invoiceCostImpactPreviewSchema.shape.inventoryValues.unwrap(),
  purchaseOrders: z.array(z.object({ purchaseOrderId: z.number().int().positive().safe(),
    before: poFinancialWorkflowSchema, after: poFinancialWorkflowSchema,
  }).strict().refine(row => row.before.purchaseOrderId === row.purchaseOrderId && row.after.purchaseOrderId === row.purchaseOrderId,
    "Purchase financial changes must identify the same purchase.")),
  costReviews: z.array(z.object({ purchaseOrderLineId: z.number().int().positive().safe(),
    state: z.string(), issues: z.array(costIssueSchema) }).strict()),
}).strict();
export type ApInvoiceTransitionPreview = z.infer<typeof apInvoiceTransitionPreviewSchema>;
export const apInvoiceTransitionReceiptSchema = z.object({
  preview: apInvoiceTransitionPreviewSchema, actorId: z.string().min(1), actorName: z.string().min(1),
  approvedAt: z.string().datetime(),
}).strict();
export type ApInvoiceTransitionReceipt = z.infer<typeof apInvoiceTransitionReceiptSchema>;
