import { z } from "zod";
import {
  listingAccountSchema,
  listingIssueSchema,
} from "@shared/types/channel-listing-publication";
import {
  listingUpdateObservationSchema,
  listingUpdateViewSchema,
  reviewListingUpdateSchema,
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
