import { z } from "zod";

// Summed quantities and money cross the boundary as decimal strings. In
// particular, do not round bigint lot costs through JavaScript numbers.
const integerText = z.string().regex(/^-?\d+$/);
export const inventoryTrackingHistorySummarySchema = z.object({
  levelCount: z.number().int().nonnegative().safe(),
  lotCount: z.number().int().nonnegative().safe(),
  onHand: integerText, reserved: integerText, picked: integerText, packed: integerText, backorder: integerText,
  lotOnHand: integerText, lotReserved: integerText, lotPicked: integerText, lotPacked: integerText,
  recordedOnHandValueMills: integerText,
});
export type InventoryTrackingHistorySummary = z.infer<typeof inventoryTrackingHistorySummarySchema>;

export const inventoryTrackingHistoryReviewSchema = z.object({
  variantId: z.number().int().positive().safe(),
  sku: z.string().nullable(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: inventoryTrackingHistorySummarySchema,
});
export const inventoryTrackingHistoryListSchema = z.object({
  records: z.array(z.object({
    id: z.string().regex(/^\d+$/), variantId: z.number().int().positive().safe(),
    stoppedAt: z.string(), actor: z.string(), summary: inventoryTrackingHistorySummarySchema,
  })).max(20),
  hasMore: z.boolean(),
});

// Bound one interactive snapshot and the transaction that retains it.
export const MAX_TRACKING_HISTORY_RECORDS = 10000;
export class InventoryTrackingHistoryCapacityError extends Error {
  readonly code = "BULK_INVENTORY_HISTORY_TOO_LARGE";
  readonly statusCode = 409;
  constructor() { super("This selection has more than 10,000 stock and lot records. Review a smaller product selection."); }
}
