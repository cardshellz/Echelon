import { z } from "zod";
import { ebayListingIssueSchema } from "./ebay-listing-issue";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ebayListingPushCommandSchema = z.object({
  productId: z.number().int().positive().max(2147483647), commandKey: z.string().uuid(),
}).strict();
export const ebayListingPushProductResultSchema = z.object({
  productId: z.number().int().positive(), productName: z.string(), variantCount: count,
  success: z.boolean(), status: z.enum(["success", "queued", "error", "skipped"]),
  listingId: z.string().min(1).optional(), error: z.string().optional(), code: z.string().optional(),
  issue: ebayListingIssueSchema.optional(), job: ebayListingSyncJobSchema.optional(),
  variantDetails: z.array(z.object({ sku: z.string(), success: z.boolean(), error: z.string().optional() })).optional(),
}).passthrough().superRefine((value, context) => {
  if (value.status === "queued" && (value.success || !value.job || value.job.productId !== value.productId))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A queued publication must identify its saved job and cannot claim completion." });
});
export const ebayListingPushResponseSchema = z.object({
  results: z.array(ebayListingPushProductResultSchema).max(500),
  summary: z.object({ succeeded: count, failed: count, skipped: count, queued: count.default(0), total: count }).strict(),
  cancelled: z.boolean(),
}).strict();
export type EbayListingPushCommand = z.infer<typeof ebayListingPushCommandSchema>;
export type EbayListingPushResponse = z.infer<typeof ebayListingPushResponseSchema>;
