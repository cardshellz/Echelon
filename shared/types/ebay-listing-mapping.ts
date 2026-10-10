import { z } from "zod";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

const id = z.number().int().positive().max(2147483647);
const text = z.string().min(1).max(1000);
export const ebayListingMappingOfferSchema = z.object({
  sku: z.string().min(1).max(100).nullable(),
  offerId: z.string().min(1).max(255),
  status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
  listingId: z.string().min(1).max(255).nullable(),
  listingStatus: z.string().min(1).max(100).nullable(),
}).strict();
export const ebayListingMappingRowSchema = z.object({
  variantId: id,
  catalogSku: z.string().min(1).max(100),
  savedSku: z.string().min(1).max(100).nullable(),
  savedOfferId: z.string().min(1).max(255).nullable(),
  savedListingId: z.string().min(1).max(255).nullable(),
  observedOffers: z.array(ebayListingMappingOfferSchema).max(10000),
  problem: z.enum(["matches", "mapping_missing", "offer_changed", "listing_changed", "unpublished", "missing", "ambiguous", "read_failed", "invalid_response", "membership_changed"]),
  recommendation: text,
}).strict();
export const ebayListingMappingReviewSchema = z.object({
  productId: id,
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  observedAt: z.string().datetime(),
  title: text,
  explanation: text,
  diagnosticCode: z.string().min(1).max(150).nullable().default(null),
  rows: z.array(ebayListingMappingRowSchema).max(250),
  membership: z.object({
    expectedSkus: z.array(z.string().min(1).max(100)).max(250),
    observedSkus: z.array(z.string().min(1).max(100)).max(10000),
    missingSkus: z.array(z.string().min(1).max(100)).max(250),
    extraSkus: z.array(z.string().min(1).max(100)).max(10000),
    groupKey: z.string().min(1).max(255).nullable(),
  }).strict().nullable().default(null),
  effects: z.array(text).max(10),
  canApply: z.boolean(),
  allowedToApply: z.boolean().default(false),
  requiredPermission: z.string().nullable().default("channels:edit"),
  action: z.object({ kind: z.enum(["apply_fix", "resume_sync", "manual", "reconnect", "retry_read", "review_registered_listing"]), label: text }).strict(),
  manualSteps: z.array(z.object({ text, href: z.string().max(2000).optional() }).strict()).max(10),
}).strict();
export const ebayListingMappingApplySchema = z.object({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/), commandKey: z.string().uuid(),
}).strict();
export const ebayListingMappingResultSchema = z.object({
  repairStatus: z.literal("queued"),
  job: ebayListingSyncJobSchema,
  replayed: z.boolean(),
  receipt: z.object({ commandKey: z.string().uuid(), productId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), appliedAt: z.string().datetime() }).strict(),
}).strict();
export type EbayListingMappingReview = z.infer<typeof ebayListingMappingReviewSchema>;
export type EbayListingMappingRow = z.infer<typeof ebayListingMappingRowSchema>;
export type EbayListingMappingApply = z.infer<typeof ebayListingMappingApplySchema>;
export type EbayListingMappingResult = z.infer<typeof ebayListingMappingResultSchema>;

// These refusals may release a pending command only after the server records
// them under the same locks as a successful repair. Unknown outcomes, busy
// scopes and command conflicts must retain the original command for recovery.
const reviewAgainCodes = new Set<string>([
  "EBAY_MAPPING_REVIEW_STALE", "EBAY_MAPPING_REVIEW_CHANGED",
  "EBAY_MAPPING_REPAIR_UNSAFE", "EBAY_MAPPING_SOURCE_INVALID",
  "EBAY_MAPPING_SCOPE_INVALID", "EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE",
  "EBAY_MAPPING_CANONICAL_CONFLICT", "EBAY_MAPPING_OWNERSHIP_CONFLICT",
  "EBAY_SYNC_IDENTITY_CHANGED", "EBAY_SYNC_MEMBERSHIP_CHANGED",
]);

export function mappingRepairFailureDisposition(code: string): "review_again" | "retry_same_command" {
  return reviewAgainCodes.has(code) ? "review_again" : "retry_same_command";
}
