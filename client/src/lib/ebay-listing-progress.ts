import { z } from "zod";
import { ebayListingIssueSchema } from "@shared/types/ebay-listing-issue";
import { ebayProductSyncResultSchema } from "@shared/types/ebay-listing-sync";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const productProgress = z.object({
  type: z.literal("progress"), product: z.string(), productId: z.number().int().positive(),
  error: z.string().nullish().transform((value) => value ?? undefined), issue: ebayListingIssueSchema.optional(),
  current: count, total: count,
});
const streamError = z.object({ type: z.literal("error"), error: z.string(), issue: ebayListingIssueSchema.optional() });

export const ebaySyncProgressEventSchema = z.discriminatedUnion("type", [
  productProgress.extend({ status: z.enum(["success", "error", "pending"]), changes: z.array(z.string()).optional(), jobId: z.string().uuid().optional() }),
  z.object({ type: z.literal("complete"), cancelled: z.boolean(), summary: z.object({
    synced: count, priceChanges: count, qtyChanges: count, policyChanges: count, errors: count, pending: count.optional(), total: count,
    details: ebayProductSyncResultSchema.shape.details.optional(),
  }) }),
  streamError,
]);

export type EbaySyncProgressEvent = z.infer<typeof ebaySyncProgressEventSchema>;
