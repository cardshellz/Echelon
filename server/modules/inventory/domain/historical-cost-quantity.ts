import { z } from "zod";

const quantity = z.number().int().nonnegative().max(2_147_483_647);
export const historicalCostQuantitySnapshotSchema = z.object({
  originalQuantity: quantity.positive(),
  onHandQuantity: quantity,
  recordedOutflowQuantity: quantity,
  unresolvedQuantity: quantity.positive(),
}).strict().superRefine((snapshot, context) => {
  if (![snapshot.originalQuantity, snapshot.onHandQuantity, snapshot.recordedOutflowQuantity, snapshot.unresolvedQuantity].every(Number.isSafeInteger)) return;
  if (BigInt(snapshot.originalQuantity) !== BigInt(snapshot.onHandQuantity)
    + BigInt(snapshot.recordedOutflowQuantity) + BigInt(snapshot.unresolvedQuantity)) {
    context.addIssue({ code: "custom", message: "Historical quantity evidence does not reconcile" });
  }
});
export type HistoricalCostQuantitySnapshot = z.infer<typeof historicalCostQuantitySnapshotSchema>;

export class HistoricalCostQuantityError extends Error {
  readonly code = "COST_RECORDED_QUANTITY_EXCEEDS_ORIGINAL";
  constructor(readonly context: { originalQuantity: number; onHandQuantity: number; recordedOutflowQuantity: number }) {
    super("Recorded quantity exceeds the original lot quantity");
    this.name = "HistoricalCostQuantityError";
  }
}

/** This is an unexplained financial portion, never an inferred sale, loss or
 * physical stock correction. Retain it separately from both on-hand and COGS. */
export function historicalCostQuantityGap(input: {
  originalQuantity: number;
  onHandQuantity: number;
  recordedOutflowQuantity: number;
}): HistoricalCostQuantitySnapshot | null {
  const originalQuantity = quantity.positive().parse(input.originalQuantity);
  const onHandQuantity = quantity.parse(input.onHandQuantity);
  const recordedOutflowQuantity = quantity.parse(input.recordedOutflowQuantity);
  const gap = BigInt(originalQuantity) - BigInt(onHandQuantity) - BigInt(recordedOutflowQuantity);
  if (gap < BigInt(0)) throw new HistoricalCostQuantityError({ originalQuantity, onHandQuantity, recordedOutflowQuantity });
  return gap === BigInt(0) ? null : historicalCostQuantitySnapshotSchema.parse({
    originalQuantity, onHandQuantity, recordedOutflowQuantity, unresolvedQuantity: Number(gap),
  });
}
