import { z } from "zod";
import { ebayListingIssueSchema } from "./ebay-listing-issue";

const syncCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ebayListingSyncJobSchema = z.object({
  id: z.string().uuid(), productId: z.number().int().positive(),
  kind: z.enum(["sync", "admission"]).default("sync"),
  state: z.enum(["queued", "running", "recovering", "awaiting_evidence", "completed", "needs_attention"]),
  code: z.string().max(100).nullable(), message: z.string().max(1000).nullable(),
  nextAttemptAt: z.string().datetime(), updatedAt: z.string().datetime(),
  issue: ebayListingIssueSchema.optional(),
});
export type EbayListingSyncJob = z.infer<typeof ebayListingSyncJobSchema>;
/** A 200 response may contain per-product failures; clients must not translate it into success. */
export const ebayProductSyncResultSchema = z.object({
  synced: syncCount,
  priceChanges: syncCount,
  qtyChanges: syncCount,
  policyChanges: syncCount,
  errors: syncCount,
  pending: syncCount.default(0),
  jobs: z.array(ebayListingSyncJobSchema).default([]),
  details: z.array(z.object({ success: z.boolean(), error: z.string().optional(),
    code: z.string().max(100).optional(), issue: ebayListingIssueSchema.optional(),
    productId: z.number().int().positive().optional(), productName: z.string().optional(), variantSku: z.string().optional(),
    variantId: z.number().int().positive().optional(), lastSyncedPriceCents: syncCount.optional(),
    priceChanged: z.boolean().optional(), qtyChanged: z.boolean().optional(), policyChanged: z.boolean().optional(),
  }).passthrough()),
});
export type EbayProductSyncResult = z.infer<typeof ebayProductSyncResultSchema>;
