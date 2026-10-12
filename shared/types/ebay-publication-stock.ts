import { z } from "zod";
import { inventoryEbayPublicationReadinessSchema } from "./ebay-publication-readiness";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

const productId = z.number().int().positive().max(2_147_483_647);
const reviewHash = z.string().regex(/^[a-f0-9]{64}$/);
export const ebayPublicationStockReviewSchema = z.object({
  productId, productName: z.string(), observedAt: z.string().datetime(), reviewHash,
  inventory: inventoryEbayPublicationReadinessSchema,
  canApply: z.boolean(), allowedToApply: z.boolean(), requiredPermission: z.string().nullable(),
  effects: z.array(z.string()),
}).strict();
export const ebayPublicationStockApplySchema = z.object({
  commandKey: z.string().uuid(), expectedReviewHash: reviewHash,
}).strict();
export const ebayPublicationStockRefusalSchema = z.object({
  code: z.enum(["EBAY_PUBLICATION_STOCK_REVIEW_STALE", "EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED",
    "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED"]),
  error: z.string().min(1), definitiveRejected: z.literal(true),
}).passthrough();
export const ebayPublicationStockResultSchema = z.object({
  job: ebayListingSyncJobSchema,
  receipt: z.object({ commandKey: z.string().uuid(), productId, reviewHash, appliedAt: z.string().datetime() }).strict(),
  replayed: z.boolean(),
}).strict();
export type EbayPublicationStockReview = z.infer<typeof ebayPublicationStockReviewSchema>;
export type EbayPublicationStockApply = z.infer<typeof ebayPublicationStockApplySchema>;
export type EbayPublicationStockResult = z.infer<typeof ebayPublicationStockResultSchema>;
