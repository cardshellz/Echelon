import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";

const id = z.number().int().positive().max(2_147_483_647);
const qty = z.number().int().nonnegative().max(2_147_483_647);
const money = z.number().int().safe();
export const costLinkOperationSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["transfer", "conversion"]),
    occurredAt: z.string(),
    sourceLotId: id,
    sourceLotNumber: z.string(),
    sourceSku: z.string(),
    sourceUnits: id,
    sourcePiecesPerUnit: id,
    movementIds: z.array(id).min(1).max(100),
    description: z.string(),
    outputs: z
      .array(
        z
          .object({
            lotId: id,
            lotNumber: z.string(),
            sku: z.string(),
            units: id,
            piecesPerUnit: id,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type CostLinkOperation = z.infer<typeof costLinkOperationSchema>;

export const costLinkRepairSummarySchema = z
  .object({
    evidenceVersion: costFingerprintSchema,
    originsRestored: z.array(
      z
        .object({
          lotId: id,
          lotNumber: z.string(),
          receiptLineId: id,
          receivedUnits: id,
          piecesPerUnit: id,
        })
        .strict(),
    ),
    operations: z.array(costLinkOperationSchema).max(10000),
    lots: z
      .array(
        z
          .object({
            lotId: id,
            lotNumber: z.string(),
            sku: z.string(),
            onHandUnits: qty,
            productMills: z.object({ before: money, after: money }),
            packagingMills: z.object({ before: money, after: money }),
            shipmentMills: z.object({ before: money, after: money }),
            orderCostCents: z.object({ before: money, after: money }),
            linkedOrderRows: qty,
          })
          .strict(),
      )
      .max(10000),
    remainingIssues: z.array(z.string()).max(10000),
    stockUnitChange: z.literal(0),
    newExpensePostings: z.literal(0),
  })
  .strict();
export type CostLinkRepairSummary = z.infer<typeof costLinkRepairSummarySchema>;
