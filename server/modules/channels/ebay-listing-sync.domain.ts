import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createHash } from "node:crypto";
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
    groupKey: z.string().trim().min(1).max(100),
    variants: z
      .array(
        z
          .object({
            variantId: pgId,
            sku: z.string().trim().min(1).max(100),
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
export const storedEbayListingSyncJobSchema = ebayListingSyncJobSchema.extend({
  identity: ebayListingSyncIdentitySchema,
  revision: z.string().regex(/^[1-9][0-9]*$/),
  claimedRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  ownerToken: z.string().uuid().nullable(),
  attempts: z.number().int().nonnegative(),
  result: ebayProductSyncResultSchema.nullable(),
});
export type StoredEbayListingSyncJob = z.infer<
  typeof storedEbayListingSyncJobSchema
>;
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
  "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED",
  "PUBLICATION_PROVIDER_COOLDOWN",
  "PUBLICATION_SCOPE_BUSY",
  "PUBLICATION_ADMISSION_CAPACITY_BUSY",
  "QUANTITY_PUBLICATION_DRAIN_BUSY",
  "PUBLICATION_GLOBAL_STOP_ACTIVE",
  "PUBLICATION_GLOBAL_DISABLED",
  "QUANTITY_PUBLICATION_SUPPRESSED",
  "PUBLICATION_LEGACY_CHANNEL_NOT_LIVE",
]);
const RETRY_CODES = new Set([
  "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
  "QUANTITY_PROVIDER_REQUEST_TIMEOUT",
  "EBAY_QUANTITY_REJECTED",
  "EBAY_QUANTITY_DAILY_LIMIT",
  "EBAY_SYNC_READBACK_PENDING",
  "EBAY_SYNC_PERSISTENCE_FAILED",
  "PUBLICATION_RESPONSE_RECOVERY_FAILED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);
export const SYNC_RETRY_LIMIT = 5;
export function syncFailure(
  error: unknown,
  attempts: number,
  now: Date,
): {
  state: "recovering" | "awaiting_evidence" | "needs_attention";
  code: string;
  message: string;
  nextAttemptAt: Date;
  resetAttempts: boolean;
} {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "EBAY_LISTING_SYNC_FAILED";
  const waiting = WAIT_CODES.has(code);
  const retrying =
    waiting ||
    ((RETRY_CODES.has(code) || code === "EBAY_LISTING_SYNC_FAILED") &&
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
  const message =
    error instanceof Error &&
    (error instanceof EbayListingSyncError ||
      /^(EBAY_|PUBLICATION_|QUANTITY_)/.test(code))
      ? error.message.slice(0, 1000)
      : "The listing update could not finish. Inspect the saved sync job before retrying.";
  return {
    state:
      code === "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED"
        ? "awaiting_evidence"
        : retrying
          ? "recovering"
          : "needs_attention",
    code,
    message,
    resetAttempts: waiting || code === "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
    nextAttemptAt: new Date(
      Number.isFinite(retryAfter) ? Math.max(minimum, retryAfter) : minimum,
    ),
  };
}
