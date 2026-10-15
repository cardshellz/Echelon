import { z } from "zod";
import { costIssueSchema } from "./cost-source-contracts";
import { shipmentCostPushResultSchema } from "./po-shipment-costs";

export const shipmentCostWorkflowIdSchema = z.number().int().positive().max(2_147_483_647);
export const shipmentCostUpdateInputSchema = z.object({}).strict();
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
  lines: z.array(z.object({
    lineId: shipmentCostWorkflowIdSchema,
    sku: z.string().nullable(),
    sourceIssue: costIssueSchema.nullable(),
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
