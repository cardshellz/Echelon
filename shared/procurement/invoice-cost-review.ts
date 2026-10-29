import { z } from "zod";
import { costFingerprintSchema, costIssueSchema, costSourceRevisionSchema } from "./cost-source-contracts";

import { invoiceCostComponentEvidenceSchema, invoiceCostComponentFields, validateInvoiceCostPackaging } from "./invoice-cost-evidence";
import { poAmendmentImpactSchema } from "./po-amendment-impact";
export { invoiceCostComponentEvidenceSchema, type InvoiceCostComponentEvidence } from "./invoice-cost-evidence";

export const invoiceCostReviewSchema = z.object({
  expectedVersion: costFingerprintSchema,
  ...invoiceCostComponentFields,
  reason: z.string().trim().min(1).max(2000),
  previewVersion: costFingerprintSchema.optional(),
}).strict().superRefine(validateInvoiceCostPackaging);
export type InvoiceCostReview = z.infer<typeof invoiceCostReviewSchema>;

export const invoiceCostImpactPreviewSchema = z.object({
  lineId: z.number().int().positive().safe(),
  previewVersion: costFingerprintSchema,
  lineTotalCents: z.number().int().safe(),
  before: invoiceCostComponentEvidenceSchema.nullable(),
  after: invoiceCostComponentEvidenceSchema,
  impact: poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true }),
}).strict();
export type InvoiceCostImpactPreview = z.infer<typeof invoiceCostImpactPreviewSchema>;

const count = z.number().int().nonnegative().safe();
export const invoiceCostReviewApplicationSchema = z.object({
  costSources: z.array(z.object({ id: z.number().int().positive().safe(), contract: costSourceRevisionSchema }).strict()),
  lotsUpdated: count,
  cogsRowsUpdated: count,
  totalCogsDeltaCents: z.number().int().safe(),
  costApplications: z.array(z.object({
    applicationId: z.number().int().positive().safe(),
    status: z.enum(["applied", "review_required"]),
    lotsUpdated: count,
    cogsRowsUpdated: count,
    totalCogsDeltaCents: z.number().int().safe(),
    issues: z.array(costIssueSchema),
    replayed: z.boolean(),
  }).strict()),
}).strict();
export const invoiceCostReviewResultSchema = z.object({
  id: z.number().int().positive().max(2_147_483_647),
  costComponentEvidence: invoiceCostComponentEvidenceSchema,
  costReviewVersion: costFingerprintSchema,
  application: invoiceCostReviewApplicationSchema.nullable(),
  preview: invoiceCostImpactPreviewSchema.optional(),
}).strict();
export type InvoiceCostReviewResult = z.infer<typeof invoiceCostReviewResultSchema>;
