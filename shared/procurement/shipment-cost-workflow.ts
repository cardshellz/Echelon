import { z } from "zod";
import { purchaseCostStatusSchema } from "./purchase-cost-status";
import { isCostReconciliationPosted, resolveCostPostingStatus } from "./cost-posting-status";
import { costIssueSchema } from "./cost-source-contracts";
import { shipmentCostPushResultSchema } from "./po-shipment-costs";
import { shipmentCostExceptionSchema } from "./shipment-cost-exception";
import { shipmentMeasurementApprovalSchema } from "./shipment-measurement-correction";

export const shipmentCostWorkflowIdSchema = z.number().int().positive().max(2_147_483_647);
export const shipmentCostUpdateInputSchema = z.object({ measurementCorrection: shipmentMeasurementApprovalSchema.optional() }).strict();
const count = z.number().int().nonnegative().safe();
export const shipmentCostUpdateResultSchema = shipmentCostPushResultSchema.extend({
  shipmentId: shipmentCostWorkflowIdSchema,
  finalizedLines: count,
  adjustments: count,
});
export type ShipmentCostUpdateResult = z.infer<typeof shipmentCostUpdateResultSchema>;

/** Recorded outcomes, not a claim that an old application matches today's split. */
export const shipmentCostReviewSchema = z.object({
  shipmentId: shipmentCostWorkflowIdSchema,
  supplierCosts: purchaseCostStatusSchema.optional(),
  lines: z.array(z.object({
    lineId: shipmentCostWorkflowIdSchema,
    sku: z.string().nullable(),
    sourceIssue: costIssueSchema.nullable(),
    exceptionReview: shipmentCostExceptionSchema.nullable().optional(),
    application: z.object({
      id: z.number().int().positive().safe(),
      recordedAt: z.string().datetime({ offset: true }),
      status: z.enum(["applied", "review_required"]),
      lotsUpdated: count,
      cogsRowsUpdated: count,
      issues: z.array(costIssueSchema),
    }).strict().nullable(),
  }).strict()),
}).strict();
export type ShipmentCostReview = z.infer<typeof shipmentCostReviewSchema>;

/** A historical application issue remains in the audit after its cost is posted.
 * A current source issue always takes precedence over that saved posting. */
export function isShipmentCostLinePosted(line: ShipmentCostReview["lines"][number]): boolean {
  const reconciled = isCostReconciliationPosted(line.application?.issues ?? [], line.exceptionReview);
  return resolveCostPostingStatus({
    sourceCurrent: line.sourceIssue === null,
    sourceIssue: line.sourceIssue !== null || (!reconciled && (line.exceptionReview != null || (line.application?.issues.length ?? 0) > 0)),
    applicationStatus: line.application?.status ?? null,
    reconciled,
  }) === "applied";
}
