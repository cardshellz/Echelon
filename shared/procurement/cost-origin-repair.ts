import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { reconciliationDestinationSchema } from "./cost-reconciliation";

export const originRepairId = z.number().int().positive().max(2_147_483_647);
const amount = z.number().int().nonnegative().safe();
export const originRepairChoicesSchema = z
  .object({
    unitsPerCase: originRepairId,
    productMills: amount,
    packagingMills: amount,
    destination: reconciliationDestinationSchema,
    reason: z.string().trim().min(10).max(2000),
    evidenceConfirmed: z.literal(true),
  })
  .strict();
export const originRepairPreviewRequestSchema = originRepairChoicesSchema
  .extend({ sourceVersion: costFingerprintSchema })
  .strict();
export const originRepairRequestSchema = originRepairPreviewRequestSchema
  .extend({ previewVersion: costFingerprintSchema })
  .strict();
export type OriginRepairChoices = z.infer<typeof originRepairChoicesSchema>;
export const originRepairSummarySchema = z
  .object({
    receivedUnits: originRepairId,
    basePieces: originRepairId,
    components: z
      .array(
        z
          .object({
            component: z.enum(["product", "packaging", "landed"]),
            lotBeforeMills: amount,
            lotAfterMills: amount,
            historicalBeforeMills: amount,
            historicalAfterMills: amount,
            orderCostDeltaCents: z.number().int().safe(),
            lotsUpdated: amount,
          })
          .strict(),
      )
      .length(3),
    stockQuantityChange: z.literal(0),
  })
  .strict();
export type OriginRepairSummary = z.infer<typeof originRepairSummarySchema>;
export const originRepairApprovalSchema = z
  .object({
    id: amount,
    actorName: z.string(),
    reason: z.string(),
    recordedAt: z.string().datetime(),
    destination: reconciliationDestinationSchema,
    summary: originRepairSummarySchema,
  })
  .strict();
export const originRepairContextSchema = z
  .object({
    lotId: originRepairId,
    lotNumber: z.string(),
    sku: z.string(),
    purchaseOrderId: originRepairId,
    purchaseOrderLineId: originRepairId,
    receiptId: originRepairId,
    receiptNumber: z.string(),
    receiptLineId: originRepairId.nullable(),
    receivedUnits: originRepairId,
    onHandUnits: amount,
    sourceVersion: costFingerprintSchema,
    invoice: z
      .object({
        id: originRepairId,
        lineId: originRepairId,
        amountMills: amount,
      })
      .nullable(),
    suggested: z.object({
      unitsPerCase: originRepairId.nullable(),
      productMills: amount,
      packagingMills: amount,
    }),
    canApprove: z.boolean(),
    blockedReason: z.string().nullable(),
    approval: originRepairApprovalSchema.nullable(),
  })
  .strict();
export const originRepairPreviewSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    previewVersion: costFingerprintSchema,
    summary: originRepairSummarySchema,
  })
  .strict();
export type OriginRepairContext = z.infer<typeof originRepairContextSchema>;
