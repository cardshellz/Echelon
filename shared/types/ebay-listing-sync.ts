import { z } from "zod";

const syncCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A 200 response may contain per-product failures; clients must not translate it into success. */
export const ebayProductSyncResultSchema = z.object({
  synced: syncCount,
  priceChanges: syncCount,
  qtyChanges: syncCount,
  policyChanges: syncCount,
  errors: syncCount,
  details: z.array(z.object({ success: z.boolean(), error: z.string().optional() }).passthrough()),
});
export type EbayProductSyncResult = z.infer<typeof ebayProductSyncResultSchema>;
