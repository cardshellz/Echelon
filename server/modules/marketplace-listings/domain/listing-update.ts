import { z } from "zod";
import {
  listingAccountSchema,
  listingIssueSchema,
} from "@shared/types/channel-listing-publication";
import {
  listingUpdateObservationSchema,
  listingUpdateViewSchema,
  listingUpdateVerificationSchema,
  reviewListingUpdateSchema,
  type ListingUpdateObservation,
  type ListingUpdateVerification,
} from "@shared/types/channel-listing-update";
import { ListingPublicationError, listingHash } from "./listing-publication";
import type { StoredListingUpdate } from "../application/listing-update-ports";

export const listingUpdateIntentSchema = z.object({
  account: listingAccountSchema,
  source: listingUpdateObservationSchema,
  command: reviewListingUpdateSchema,
  prepared: z.object({
    payload: z.record(z.unknown()),
    schemaHash: z.string().length(64),
    issues: z.array(listingIssueSchema),
  }),
});
export const storedListingUpdateSchema = z.object({
  view: listingUpdateViewSchema,
  intent: listingUpdateIntentSchema,
  version: z.number().int().positive(),
  leaseToken: z.string().uuid().nullable(),
  commandKey: z.string().uuid().nullable(),
});
export function assertUpdateSource(expected: unknown, current: unknown): void {
  if (listingHash(expected) !== listingHash(current)) {
    throw new ListingPublicationError(
      "LISTING_UPDATE_STALE",
      "The Walmart listing or connection changed. Reopen the listing and review your changes again.",
    );
  }
}
/** Feed acceptance and current catalog classification are separate evidence. */
export function verifyListingUpdateObservation(
  record: StoredListingUpdate,
  current: ListingUpdateObservation,
  checkedAt: Date,
): ListingUpdateVerification {
  const source = record.intent.source;
  if (
    current.sku !== source.sku ||
    current.externalProductId !== source.externalProductId ||
    current.identifier.type !== source.identifier.type ||
    current.identifier.value !== source.identifier.value
  ) {
    throw new ListingPublicationError(
      "LISTING_UPDATE_PRODUCT_CHANGED",
      "Walmart returned a different product or barcode. Reopen the listing before making changes.",
    );
  }
  return listingUpdateVerificationSchema.parse({
    updateId: record.view.id,
    requestedProductType: record.intent.command.productType,
    categoryMatches: current.productType === record.intent.command.productType,
    current,
    checkedAt: checkedAt.toISOString(),
  });
}

export function assertUpdateReview(
  record: StoredListingUpdate,
  now: Date,
): void {
  if (
    record.view.state !== "reviewed" ||
    new Date(record.view.expiresAt) <= now ||
    record.view.issues.length
  ) {
    throw new ListingPublicationError(
      "LISTING_UPDATE_REVIEW_INVALID",
      "Review these changes again before sending them to Walmart.",
    );
  }
}
