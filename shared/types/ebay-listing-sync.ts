import { z } from "zod";
import { ebayListingIssueSchema } from "./ebay-listing-issue";

const syncCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ebayListingSyncPhaseSchema = z.enum([
  "prepare_listing", "recover_prior_requests", "inspect_content", "prepare_inventory",
  "update_offer", "update_item", "update_group", "publish", "publication_readback", "verify", "withdraw",
]);
export const ebayListingSyncProgressSchema = z.object({
  phase: ebayListingSyncPhaseSchema.nullable(),
  phaseState: z.enum(["started", "completed"]).nullable(),
  requestedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  lastWorkerActivityAt: z.string().datetime().nullable(),
  // Earlier eligible candidates in the durable queue, not a completion estimate.
  queuedAhead: syncCount.nullable(),
}).strict().refine(progress => (progress.phase === null) === (progress.phaseState === null), {
  message: "A recorded phase must include its recorded state.",
});
export type EbayListingSyncPhase = z.infer<typeof ebayListingSyncPhaseSchema>;
export type EbayListingSyncProgress = z.infer<typeof ebayListingSyncProgressSchema>;
export const ebayInventoryReconciliationSchema = z.object({
  state: z.enum(["pending", "verified", "needs_attention", "unavailable", "inactive"]),
  checkedAt: z.string().datetime().nullable(),
  nextCheckAt: z.string().datetime().nullable(),
  code: z.string().max(100).nullable(),
  message: z.string().max(1000).nullable(),
}).strict().refine(status => status.state !== "verified" || status.checkedAt !== null, {
  message: "Verified stock must identify its actual provider observation time.",
});
export type EbayInventoryReconciliation = z.infer<typeof ebayInventoryReconciliationSchema>;
export const ebayListingSyncJobSchema = z.object({
  id: z.string().uuid(), productId: z.number().int().positive(),
  kind: z.enum(["sync", "admission"]).default("sync"),
  operation: z.enum(["sync", "publish", "withdraw"]).default("sync"),
  state: z.enum(["queued", "running", "recovering", "awaiting_evidence", "completed", "needs_attention"]),
  code: z.string().max(100).nullable(), message: z.string().max(1000).nullable(),
  nextAttemptAt: z.string().datetime(), updatedAt: z.string().datetime(),
  issue: ebayListingIssueSchema.optional(),
  // Older saved responses remain readable while the server adds event evidence.
  progress: ebayListingSyncProgressSchema.optional(),
  // Inventory's owner supplies current readback evidence independently of
  // listing-content completion. Older saved responses have no stock evidence.
  inventoryReconciliation: ebayInventoryReconciliationSchema.optional(),
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
