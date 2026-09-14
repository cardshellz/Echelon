import { z } from "zod";

const positiveRevision = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const inventoryPublicationGlobalControlRequestSchema = z.object({
  globalEnabled: z.boolean().optional(),
  sweepIntervalMinutes: z.number().int().min(1).max(1_440).optional(),
  expectedRevision: positiveRevision,
  idempotencyKey: z.string().trim().min(1).max(120),
  changeReason: z.string().trim().min(1).max(1_000),
}).strict().superRefine((request, context) => {
  if (request.globalEnabled === undefined && request.sweepIntervalMinutes === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "At least one publication-control setting is required.",
    });
  }
});

export const inventoryPublicationGlobalControlResultSchema = z.object({
  globalEnabled: z.boolean(),
  sweepIntervalMinutes: z.number().int().min(1).max(1_440),
  revision: positiveRevision,
  changedBy: z.string().trim().min(1).max(100),
  changeReason: z.string().trim().min(1).max(1_000),
  changedAt: z.string().datetime({ offset: true }),
  alreadyApplied: z.boolean(),
}).strict();

export type InventoryPublicationGlobalControlRequest = z.infer<
  typeof inventoryPublicationGlobalControlRequestSchema
>;
export type InventoryPublicationGlobalControlResult = z.infer<
  typeof inventoryPublicationGlobalControlResultSchema
>;
