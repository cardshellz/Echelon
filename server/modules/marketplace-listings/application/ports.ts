import type {
  ListingOwnerRef,
  ListingReplacementPlan,
} from "../domain/listing-replacement-plan";
import type {
  CreateOrReplayListingReplacementResult,
  ListingReplacementOperation,
} from "./dtos";

export interface MarketplaceListingReplacementClock {
  now(): Date;
}

/**
 * Internal owner boundary. Implementations must call the owning Channels or
 * Dropship public API; they must not let this module write owner tables.
 */
export interface MarketplaceListingOwnerReader {
  loadSnapshot(owner: ListingOwnerRef): Promise<unknown>;
}

export interface ListingReplacementReplayLookup {
  readonly owner: ListingOwnerRef;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/**
 * Stage 1 persistence boundary. Listing scopes already exist and belong to the
 * Channels or Dropship owner. Implementations atomically create the target
 * publication, operation, steps, and initial audit event, or replay the existing
 * operation when the owner-scoped idempotency key and stable request hash match.
 */
export interface MarketplaceListingReplacementRepository {
  findReplay(
    lookup: ListingReplacementReplayLookup,
  ): Promise<ListingReplacementOperation | null>;

  createOrReplayPlan(
    plan: ListingReplacementPlan,
  ): Promise<CreateOrReplayListingReplacementResult>;
}
