import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { reconciliationDestinationSchema } from "./cost-reconciliation";

export const quantityCorrectionId = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const amount = z.number().int().safe();
export const quantityCorrectionInputSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    shippedPieces: quantityCorrectionId,
    receipts: z
      .array(
        z
          .object({
            receiptLineId: quantityCorrectionId,
            receivedPieces: quantityCorrectionId,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    historicalCostDestination: reconciliationDestinationSchema
      .nullable()
      .default(null),
    reason: z.string().trim().min(10).max(2000),
    evidenceConfirmed: z.literal(true),
  })
  .strict();
export const quantityCorrectionApprovalSchema = quantityCorrectionInputSchema
  .extend({ previewVersion: costFingerprintSchema })
  .strict();
export type QuantityCorrectionInput = z.infer<
  typeof quantityCorrectionInputSchema
>;
export const quantityCorrectionReceiptSchema = z
  .object({
    receiptId: quantityCorrectionId,
    receiptNumber: z.string(),
    receiptLineId: quantityCorrectionId,
    receivedUnits: quantityCorrectionId,
    receivedPieces: quantityCorrectionId,
    piecesPerUnit: quantityCorrectionId,
    unitWasRecorded: z.boolean(),
  })
  .strict();
export const quantityCorrectionSummarySchema = z
  .object({
    shipmentPieces: z.object({
      before: quantityCorrectionId,
      after: quantityCorrectionId,
    }),
    receipts: z.array(
      quantityCorrectionReceiptSchema.extend({
        afterPieces: quantityCorrectionId,
        afterPiecesPerUnit: quantityCorrectionId,
      }),
    ),
    poReceivedPieces: z.object({ before: quantity, after: quantity }),
    poRemainingPieces: z.object({ before: quantity, after: quantity }),
    shipmentChargeCents: z.object({ before: amount, after: amount }),
    allocatedChargeCents: z.object({ before: amount, after: amount }),
    chargePerPiece: z.object({ before: z.string(), after: z.string() }),
    landedCostCents: z.object({
      before: amount.nullable(),
      after: amount.nullable(),
    }),
    landedCostPerPiece: z.object({
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
    stockUnitChange: z.literal(0),
    costResults: z.array(
      z
        .object({
          component: z.enum(["product", "packaging", "landed"]),
          shipmentId: quantityCorrectionId.nullable(),
          status: z.enum(["applied", "review_required"]),
          lotsUpdated: quantity,
          orderCostsUpdated: quantity,
          orderCostDeltaCents: amount,
          issues: z.array(z.object({ code: z.string(), message: z.string() })),
        })
        .strict(),
    ),
    historicalCost: z
      .object({
        eligible: z.boolean(),
        requiresDecision: z.boolean(),
        blockedReason: z.string().nullable(),
        beforeMills: amount,
        afterMills: amount,
        destination: reconciliationDestinationSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type QuantityCorrectionSummary = z.infer<
  typeof quantityCorrectionSummarySchema
>;
export const quantityCorrectionPreviewSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    previewVersion: costFingerprintSchema,
    summary: quantityCorrectionSummarySchema,
  })
  .strict();
export type QuantityCorrectionPreview = z.infer<
  typeof quantityCorrectionPreviewSchema
>;
export const quantityCorrectionHistorySchema = z
  .object({
    id: z.number().int().positive().safe(),
    approvedBy: z.string(),
    approvedAt: z.string().datetime(),
    sourceVersion: costFingerprintSchema,
    reason: z.string(),
    summary: quantityCorrectionSummarySchema,
  })
  .strict();
export const quantityCorrectionContextSchema = z
  .object({
    shipmentLineId: quantityCorrectionId,
    shipmentId: quantityCorrectionId,
    shipmentNumber: z.string(),
    shipmentStatus: z.string(),
    sku: z.string(),
    productName: z.string(),
    purchaseOrderId: quantityCorrectionId,
    purchaseOrderNumber: z.string(),
    orderedPieces: quantityCorrectionId,
    shippedPieces: quantityCorrectionId,
    receipts: z.array(quantityCorrectionReceiptSchema),
    sourceVersion: costFingerprintSchema,
    canApprove: z.boolean(),
    blockedReason: z.string().nullable(),
    history: z.array(quantityCorrectionHistorySchema),
  })
  .strict();
export type QuantityCorrectionContext = z.infer<
  typeof quantityCorrectionContextSchema
>;
export const quantityCorrectionOptionsSchema = z.array(
  z
    .object({
      shipmentLineId: quantityCorrectionId,
      shipmentNumber: z.string(),
      sku: z.string(),
      shippedPieces: quantityCorrectionId,
    })
    .strict(),
);
