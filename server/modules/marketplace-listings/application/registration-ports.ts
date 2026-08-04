import type {
  ListingRegistrationLocator,
  ListingRegistrationPlan,
  MarketplaceProviderAccountObservation,
} from "../domain/listing-registration-plan";
import type {
  ListingActor,
  ListingOwnerRef,
} from "../domain/listing-replacement-plan";
import type {
  ListingRegistrationReceipt,
  ListingRegistrationResult,
  ProviderAccountClaimResult,
} from "./registration-dtos";

export interface MarketplaceListingRegistrationClock {
  now(): Date;
}

/**
 * Read boundary owned by Channels or Dropship. It must return every local
 * product variant, including archived/inactive and zero-quantity variants.
 */
export interface MarketplaceListingRegistrationOwnerReader {
  loadRegistrationSnapshot(owner: ListingOwnerRef): Promise<unknown>;
}

export interface ObserveMarketplaceListingInput {
  readonly owner: ListingOwnerRef;
  readonly locator: ListingRegistrationLocator;
}

/** Read-only provider boundary. Preview and confirmation both use this port. */
export interface MarketplaceListingRegistrationObserver {
  observeExistingPublication(
    input: ObserveMarketplaceListingInput,
  ): Promise<unknown>;
}

export interface MarketplaceListingProviderAccountClaim {
  readonly owner: ListingOwnerRef;
  readonly providerAccount: MarketplaceProviderAccountObservation;
  readonly idempotencyKey: string;
  readonly observationHash: string;
  readonly observedAt: Date;
  readonly requestedBy: ListingActor;
  readonly correlationId: string | null;
}

/**
 * Owner-owned durable write boundary. Confirmation invokes it only after a
 * fresh provider observation matches the user-confirmed observation hash. The
 * claim is idempotent and may remain committed if marketplace persistence later
 * fails; preview and early registration replay never invoke it.
 */
export interface MarketplaceListingProviderAccountClaimer {
  claimStableProviderAccount(
    claim: MarketplaceListingProviderAccountClaim,
  ): Promise<unknown>;
}

export interface ListingRegistrationReplayLookup {
  readonly owner: ListingOwnerRef;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface PersistListingRegistrationInput {
  readonly plan: ListingRegistrationPlan;
  readonly registeredAt: Date;
  readonly accountClaim: ProviderAccountClaimResult;
}

export interface MarketplaceListingRegistrationRepository {
  findReplay(
    lookup: ListingRegistrationReplayLookup,
  ): Promise<ListingRegistrationReceipt | null>;

  registerOrReplay(
    input: PersistListingRegistrationInput,
  ): Promise<ListingRegistrationResult>;
}
