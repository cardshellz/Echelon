import { providerReadDiagnosticFromError, providerReadShouldRetry } from "@shared/channel-provider-read";
import { ChannelPricingResolutionError } from "./channel-pricing-resolver";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createHash } from "node:crypto";
import { ebayListingFailureDiagnostic } from "./ebay-listing-failure-diagnostic";
import {
  ebayProductSyncResultSchema,
  ebayListingSyncJobSchema,
} from "@shared/types/ebay-listing-sync";

const pgId = z.number().int().positive().max(2147483647);
export const ebayListingSyncIdentitySchema = z
  .object({
    channelId: pgId,
    connectionId: pgId,
    productId: pgId,
    accountId: z.string().trim().min(1).max(240),
    marketplaceId: z.string().trim().min(1).max(100),
    groupKey: z.string().trim().min(1).max(255).nullable(),
    // Archived members still present in the provider's group are topology only.
    // Maintenance preserves them; the shared lifecycle owns their removal.
    retainedGroupSkus: z.array(z.string().trim().min(1).max(100)).max(250).optional(),
    variants: z
      .array(
        z
          .object({
            variantId: pgId,
            sku: z.string().trim().min(1).max(100),
            catalogSku: z.string().trim().min(1).max(100).optional(),
            contentSyncEnabled: z.boolean().optional(),
            catalogArchived: z.boolean().optional(),
            mappingExists: z.boolean().optional(),
            externalSku: z.string().min(1).max(100).nullable(),
            offerId: z.string().min(1).max(255).nullable(),
            listingId: z.string().min(1).max(255).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.variants.map((v) => v.variantId)).size !==
        value.variants.length ||
      new Set(value.variants.map((v) => v.sku)).size !== value.variants.length
      || new Set(value.retainedGroupSkus).size !== (value.retainedGroupSkus?.length ?? 0)
      || value.retainedGroupSkus?.some(sku => value.variants.some(member => member.sku === sku))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Listing sync requires distinct exact variants and SKUs.",
      });
  });
export type EbayListingSyncIdentity = z.infer<
  typeof ebayListingSyncIdentitySchema
>;
export const syncIdentityHash = (identity: EbayListingSyncIdentity): string =>
  syncStageHash({
    ...identity,
    variants: [...identity.variants].sort((a, b) => a.variantId - b.variantId),
  });
export const syncStageHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const ebayPublicationAcceptedSchema = z.object({ listingId: z.string().trim().min(1).max(255),
  offerIds: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().trim().min(1).max(255)) }).strict();
export type EbayPublicationAccepted = z.infer<typeof ebayPublicationAcceptedSchema>;
export const storedEbayListingSyncJobSchema = ebayListingSyncJobSchema.extend({
  operation: z.enum(["sync", "publish", "withdraw"]).default("sync"),
  requestedBy: z.string().min(1).max(200).optional(),
  identity: ebayListingSyncIdentitySchema,
  providerIdentity: ebayListingSyncIdentitySchema.nullable().default(null),
  publicationTarget: ebayListingSyncIdentitySchema.nullable().default(null),
  publicationAccepted: ebayPublicationAcceptedSchema.nullable().default(null),
  publicationWriteCompleted: z.boolean().default(false),
  withdrawalWriteCompleted: z.boolean().default(false),
  withdrawalWriteStarted: z.boolean().default(false),
  publicationWriteStarted: z.boolean().default(false),
  publicationAcceptedRevision: z.string().regex(/^[1-9][0-9]*$/).nullable().default(null),
  publicationIntentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  revision: z.string().regex(/^[1-9][0-9]*$/),
  claimedRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  ownerToken: z.string().uuid().nullable(),
  attempts: z.number().int().nonnegative(),
  readFailureCount: z.number().int().nonnegative().optional(),
  result: ebayProductSyncResultSchema.nullable(),
  verificationIntentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  verificationRevision: z.string().regex(/^[1-9][0-9]*$/).nullable(),
});
export type StoredEbayListingSyncJob = z.infer<
  typeof storedEbayListingSyncJobSchema
>;
export const publicationRetryReviewHash = (job: StoredEbayListingSyncJob): string => syncStageHash({
  id: job.id, revision: job.revision, identity: job.identity, publicationTarget: job.publicationTarget,
  publicationWriteStarted: job.publicationWriteStarted, publicationWriteCompleted: job.publicationWriteCompleted,
  publicationAccepted: job.publicationAccepted, publicationIntentHash: job.publicationIntentHash,
  ...(job.operation === "withdraw" ? { operation: job.operation, providerIdentity: job.providerIdentity,
    withdrawalWriteStarted: job.withdrawalWriteStarted, withdrawalWriteCompleted: job.withdrawalWriteCompleted } : {}),
});
export interface EbayPublicationRetryAuthorization {
  jobId: string; channelId: number; expectedRevision: string; reviewHash: string; commandKey: string; actor: string;
}
export class EbayListingSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EbayListingSyncError";
  }
}
const WAIT_CODES = new Set([
  "EBAY_WITHDRAWAL_READBACK_PENDING",
  "EBAY_PUBLICATION_READBACK_PENDING",
  "EBAY_PROVIDER_RATE_LIMITED",
  "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED",
  "PUBLICATION_PROVIDER_COOLDOWN",
  "PUBLICATION_SCOPE_BUSY",
  "PUBLICATION_ADMISSION_CAPACITY_BUSY",
  // The canonical planner deliberately releases its transaction when another
  // publisher holds the target lock. Wait and rebuild the entire sync; this
  // contention must not exhaust retries or strand partially updated pictures.
  "INVENTORY_PUBLICATION_TARGET_BUSY",
  "QUANTITY_PUBLICATION_DRAIN_BUSY",
  "PUBLICATION_GLOBAL_STOP_ACTIVE",
  "PUBLICATION_GLOBAL_DISABLED",
  "QUANTITY_PUBLICATION_SUPPRESSED",
  "PUBLICATION_LEGACY_CHANNEL_NOT_LIVE",
]);
const RETRY_CODES = new Set([
  "EBAY_PUBLICATION_STOCK_REVIEW_STALE",
  "STOCK_MAPPING_PROVIDER_BUSY",
  "STOCK_MAPPING_CONCURRENT_CHANGE",
  "STOCK_MAPPING_CLEANUP_UNCERTAIN",
  "STOCK_MAPPING_REVIEW_STALE",
  "STOCK_MAPPING_TARGET_CHANGED",
  "EBAY_QUANTITY_REJECTED",
  "EBAY_QUANTITY_DAILY_LIMIT",
]);
export const SYNC_RETRY_LIMIT = 5;
// Known temporary failures retain their saved job with capped backoff. Exhausting
// a counter cannot repair a lost response or an outage; recovery owns those cases.
// Unclassified failures and business rejections still require a finite budget.
const AUTOMATIC_RECOVERY_CODES = new Set([
  "EBAY_POLICY_CATALOG_UNAVAILABLE",
  "EBAY_PUBLICATION_PREFLIGHT_RETRY",
  "EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT",
  "EBAY_SYNC_READBACK_PENDING", "EBAY_SYNC_PERSISTENCE_FAILED",
  "PUBLICATION_RESPONSE_RECOVERY_FAILED", "PUBLICATION_AUTOMATIC_RECOVERY_FAILED",
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EBAY_AUTH_UNAVAILABLE",
  "EBAY_AUTH_REFRESH_SUPERSEDED", "EBAY_REGISTRATION_READ_TIMEOUT", "EBAY_REGISTRATION_READ_FAILED",
]);
export function syncFailure(
  error: unknown,
  attempts: number,
  now: Date,
  readFailureCount = 0,
): {
  readRetry?: { failures: number; paused: boolean };
  state: "recovering" | "awaiting_evidence" | "needs_attention";
  code: string;
  message: string;
  nextAttemptAt: Date;
  resetAttempts: boolean;
} {
  const { code } = ebayListingFailureDiagnostic(error);
  const waiting = WAIT_CODES.has(code);
  const readFailure = providerReadDiagnosticFromError(error);
  const retrying = readFailure ? providerReadShouldRetry(readFailure, readFailureCount + 1) :
    waiting || AUTOMATIC_RECOVERY_CODES.has(code) ||
    ((RETRY_CODES.has(code) || code === "EBAY_LISTING_SYNC_FAILED" || code === "DATABASE_POOL_ACQUIRE_TIMEOUT") &&
      attempts < SYNC_RETRY_LIMIT);
  const retryAfter =
    error instanceof Error &&
    "context" in error &&
    error.context &&
    typeof error.context === "object" &&
    "retryNotBefore" in error.context
      ? Date.parse(String(error.context.retryNotBefore))
      : NaN;
  const minimum =
    now.getTime() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5));
  const message = code === "DATABASE_POOL_ACQUIRE_TIMEOUT"
    ? "The database connection queue timed out. The saved update retains its earlier write evidence and can be retried safely."
    : readFailure
    ? readFailure.kind === "refused" ? "The channel refused the listing read. Review the saved read diagnostic before retrying."
      : "Echelon could not read a complete, valid listing response. Existing write evidence remains protected."
    : code === "INVENTORY_PUBLICATION_TARGET_BUSY"
    ? "An inventory update is using this listing. The saved listing update will retry automatically."
    : code === "CANONICAL_PUBLICATION_MAPPING_MISSING"
      ? "Inventory setup stopped this listing update before its pictures could be confirmed. Retry Sync to prepare this listing's inventory connection."
    : error instanceof Error &&
    (error instanceof EbayListingSyncError || error instanceof ChannelPricingResolutionError ||
      (code !== "EBAY_LISTING_SYNC_FAILED" && /^(EBAY_|PUBLICATION_|QUANTITY_)/.test(code)))
      ? error.message.slice(0, 1000)
      : "The listing update could not finish. Inspect the saved sync job before retrying.";
  return {
    ...(readFailure ? { readRetry: { failures: readFailureCount + 1, paused: !retrying } } : {}),
    state:
      code === "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" || code === "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" || code === "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN"
        ? "awaiting_evidence"
        : retrying
          ? "recovering"
          : "needs_attention",
    code,
    message,
    resetAttempts: waiting || code === "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" || code === "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" || code === "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN",
    nextAttemptAt: new Date(
      Number.isFinite(retryAfter) ? Math.max(minimum, retryAfter) : minimum,
    ),
  };
}
