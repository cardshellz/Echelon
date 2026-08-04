import { z } from "zod";

import {
  buildListingRegistrationPlan,
  buildListingRegistrationRequestHash,
  type ListingRegistrationPlan,
  type MarketplaceProviderAccountObservation,
} from "../domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../domain/registration-errors";
import type { ListingOwnerRef } from "../domain/listing-replacement-plan";
import {
  confirmListingRegistrationInputSchema,
  listingRegistrationOwnerSnapshotSchema,
  listingRegistrationReceiptSchema,
  listingRegistrationStatusSchema,
  listingRegistrationResultSchema,
  marketplaceObservedListingPublicationSchema,
  previewListingRegistrationInputSchema,
  providerAccountClaimResultSchema,
  type ConfirmListingRegistrationInput,
  type ListingRegistrationResult,
  type ListingRegistrationStatus,
  type PreviewListingRegistrationInput,
  type ProviderAccountClaimResult,
} from "./registration-dtos";
import { listingOwnerRefSchema } from "./dtos";
import type {
  MarketplaceListingProviderAccountClaimer,
  MarketplaceListingRegistrationClock,
  MarketplaceListingRegistrationObserver,
  MarketplaceListingRegistrationOwnerReader,
  MarketplaceListingRegistrationRepository,
} from "./registration-ports";

const MAX_REGISTRATION_STATUS_BATCH = 500;

export class MarketplaceListingRegistrationService {
  constructor(
    private readonly ownerReader: MarketplaceListingRegistrationOwnerReader,
    private readonly observer: MarketplaceListingRegistrationObserver,
    private readonly accountClaimer: MarketplaceListingProviderAccountClaimer,
    private readonly repository: MarketplaceListingRegistrationRepository,
    private readonly clock: MarketplaceListingRegistrationClock,
  ) {}

  async getCurrentRegistrationStatus(
    owner: ListingOwnerRef,
  ): Promise<ListingRegistrationStatus | null> {
    const parsedOwner = parseBoundary(
      listingOwnerRefSchema,
      owner,
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "Listing registration owner is invalid.",
    );
    try {
      const status = await this.repository.findCurrentRegistration(parsedOwner);
      if (status === null) return null;
      return listingRegistrationStatusSchema.parse(status);
    } catch (error) {
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_STATUS_LOOKUP_FAILED",
        "Current marketplace listing registration status could not be loaded.",
        {
          ownerKind: parsedOwner.kind,
          productId: parsedOwner.productId,
        },
      );
    }
  }

  async getCurrentRegistrationStatuses(
    owners: readonly ListingOwnerRef[],
  ): Promise<readonly ListingRegistrationStatus[]> {
    const parsedOwners = parseBoundary(
      z.array(listingOwnerRefSchema).max(MAX_REGISTRATION_STATUS_BATCH),
      owners,
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "Listing registration status batch is invalid.",
    );
    if (parsedOwners.length === 0) return [];
    assertOneOwnerStatusBatch(parsedOwners);
    try {
      const statuses = z
        .array(listingRegistrationStatusSchema)
        .max(MAX_REGISTRATION_STATUS_BATCH)
        .parse(
          await this.repository.findCurrentRegistrations(parsedOwners),
        );
      assertStatusBatchMatchesOwners(statuses, parsedOwners);
      return [...statuses].sort(
        (left, right) => left.productId - right.productId,
      );
    } catch (error) {
      const firstOwner = parsedOwners[0];
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_STATUS_LOOKUP_FAILED",
        "Current marketplace listing registration statuses could not be loaded.",
        {
          ownerKind: firstOwner.kind,
          ownerId: ownerIdentity(firstOwner),
          productCount: parsedOwners.length,
        },
      );
    }
  }

  async preview(
    input: PreviewListingRegistrationInput,
  ): Promise<ListingRegistrationPlan> {
    const command = parseBoundary(
      previewListingRegistrationInputSchema,
      input,
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "Listing registration preview request is invalid.",
    );
    return this.loadFreshPlan(command);
  }

  async confirm(
    input: ConfirmListingRegistrationInput,
  ): Promise<ListingRegistrationResult> {
    const command = parseBoundary(
      confirmListingRegistrationInputSchema,
      input,
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "Listing registration confirmation request is invalid.",
    );
    const requestHash = buildListingRegistrationRequestHash(command);

    // Replay must precede owner reads, provider calls, and durable owner claims.
    const earlyReplay = await this.findReplay({
      owner: command.owner,
      idempotencyKey: command.idempotencyKey,
      requestHash,
    });
    if (earlyReplay) return { kind: "replay", receipt: earlyReplay };

    const plan = await this.loadFreshPlan(command);
    if (plan.observationHash !== command.expectedObservationHash) {
      throw new MarketplaceListingRegistrationError(
        "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_CHANGED",
        "The marketplace listing changed after preview; review a fresh preview before confirming.",
        {
          expectedObservationHash: command.expectedObservationHash,
          actualObservationHash: plan.observationHash,
        },
      );
    }

    const accountClaim = await this.claimProviderAccount(plan);
    const registeredAt = this.clock.now();
    assertValidRegistrationTime(
      registeredAt,
      plan.observedAt,
      accountClaim.verifiedAt,
    );
    try {
      const result = listingRegistrationResultSchema.parse(
        await this.repository.registerOrReplay({
          plan,
          registeredAt,
          accountClaim,
        }),
      );
      assertResultMatchesPlan(result, plan);
      return result;
    } catch (error) {
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_PERSISTENCE_FAILED",
        "Marketplace listing registration could not be persisted after the owner account identity was claimed.",
        { ownerKind: plan.owner.kind, productId: plan.owner.productId },
      );
    }
  }

  private async loadFreshPlan(
    input: PreviewListingRegistrationInput,
  ): Promise<ListingRegistrationPlan> {
    try {
      const snapshotValue = await this.ownerReader.loadRegistrationSnapshot(
        input.owner,
      );
      const snapshot =
        listingRegistrationOwnerSnapshotSchema.parse(snapshotValue);
      const observationValue = await this.observer.observeExistingPublication({
        owner: input.owner,
        locator: input.locator,
        memberCandidates: snapshot.memberCandidates,
      });
      const observation =
        marketplaceObservedListingPublicationSchema.parse(observationValue);
      return buildListingRegistrationPlan({
        owner: input.owner,
        locator: input.locator,
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId ?? null,
        snapshot,
        observation,
      });
    } catch (error) {
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_FAILED",
        "The owner snapshot or marketplace publication could not be observed safely.",
        { ownerKind: input.owner.kind, productId: input.owner.productId },
      );
    }
  }

  private async findReplay(input: {
    readonly owner: ListingOwnerRef;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) {
    try {
      const replay = await this.repository.findReplay(input);
      if (replay === null) return null;
      const receipt = listingRegistrationReceiptSchema.parse(replay);
      if (
        receipt.requestHash !== input.requestHash ||
        receipt.idempotencyKey !== input.idempotencyKey
      ) {
        throw new MarketplaceListingRegistrationError(
          "MARKETPLACE_LISTING_REGISTRATION_REPLAY_CONTRACT_INVALID",
          "Registration repository replay does not match the idempotent request.",
        );
      }
      return receipt;
    } catch (error) {
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_REPLAY_LOOKUP_FAILED",
        "Marketplace listing registration replay lookup failed.",
        { ownerKind: input.owner.kind, productId: input.owner.productId },
      );
    }
  }

  private async claimProviderAccount(
    plan: ListingRegistrationPlan,
  ): Promise<ProviderAccountClaimResult> {
    try {
      const result = providerAccountClaimResultSchema.parse(
        await this.accountClaimer.claimStableProviderAccount({
          owner: plan.owner,
          providerAccount: plan.providerAccount,
          idempotencyKey: plan.idempotencyKey,
          observationHash: plan.observationHash,
          observedAt: plan.observedAt,
          requestedBy: plan.requestedBy,
          correlationId: plan.correlationId,
        }),
      );
      assertAccountClaimMatchesPlan(result, plan.owner, plan.providerAccount);
      return result;
    } catch (error) {
      throw classifyBoundaryError(
        error,
        "MARKETPLACE_LISTING_REGISTRATION_ACCOUNT_CLAIM_FAILED",
        "The owner module could not durably claim the observed stable provider account identity.",
        { ownerKind: plan.owner.kind, productId: plan.owner.productId },
      );
    }
  }
}

function assertOneOwnerStatusBatch(owners: readonly ListingOwnerRef[]): void {
  const firstOwner = owners[0];
  const ownerKey = statusBatchOwnerKey(firstOwner);
  const productIds = new Set<number>();
  for (const owner of owners) {
    if (statusBatchOwnerKey(owner) !== ownerKey) {
      throw new MarketplaceListingRegistrationError(
        "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
        "A registration status batch must contain products for exactly one marketplace owner.",
      );
    }
    if (productIds.has(owner.productId)) {
      throw new MarketplaceListingRegistrationError(
        "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
        "A registration status batch cannot contain duplicate product IDs.",
        { productId: owner.productId },
      );
    }
    productIds.add(owner.productId);
  }
}

function assertStatusBatchMatchesOwners(
  statuses: readonly ListingRegistrationStatus[],
  owners: readonly ListingOwnerRef[],
): void {
  const requestedProductIds = new Set(owners.map((owner) => owner.productId));
  const returnedProductIds = new Set<number>();
  for (const status of statuses) {
    if (
      !requestedProductIds.has(status.productId) ||
      returnedProductIds.has(status.productId)
    ) {
      throw new MarketplaceListingRegistrationError(
        "MARKETPLACE_LISTING_REGISTRATION_STATUS_CONTRACT_INVALID",
        "Registration repository status results do not match the requested products.",
        { productId: status.productId },
      );
    }
    returnedProductIds.add(status.productId);
  }
}

function statusBatchOwnerKey(owner: ListingOwnerRef): string {
  return [
    owner.kind,
    ownerIdentity(owner),
    owner.provider,
    owner.marketplaceId,
  ].join(":");
}

function ownerIdentity(owner: ListingOwnerRef): number {
  return owner.kind === "channel"
    ? owner.channelId
    : owner.storeConnectionId;
}

function assertAccountClaimMatchesPlan(
  claim: ProviderAccountClaimResult,
  owner: ListingOwnerRef,
  account: MarketplaceProviderAccountObservation,
): void {
  const ownerIdMatches =
    owner.kind === claim.owner.kind &&
    (owner.kind === "channel"
      ? claim.owner.kind === "channel" &&
        claim.owner.channelId === owner.channelId
      : claim.owner.kind === "dropship" &&
        claim.owner.storeConnectionId === owner.storeConnectionId);
  if (
    !ownerIdMatches ||
    claim.owner.productId !== owner.productId ||
    claim.owner.provider !== owner.provider ||
    claim.owner.marketplaceId !== owner.marketplaceId ||
    claim.provider !== account.provider ||
    claim.accountNamespace !== account.accountNamespace ||
    claim.externalAccountId !== account.externalAccountId ||
    claim.identityScheme !== account.identityScheme
  ) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_ACCOUNT_CLAIM_MISMATCH",
      "The owner account claim result does not match the observed provider account.",
    );
  }
}

function assertResultMatchesPlan(
  result: ListingRegistrationResult,
  plan: ListingRegistrationPlan,
): void {
  const receipt = result.receipt;
  if (
    receipt.idempotencyKey !== plan.idempotencyKey ||
    receipt.requestHash !== plan.requestHash ||
    receipt.observationHash !== plan.observationHash ||
    receipt.desiredStateHash !== plan.desiredStateHash
  ) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PERSISTENCE_CONTRACT_INVALID",
      "Registration repository result does not match the confirmed plan.",
    );
  }
}

function assertValidRegistrationTime(
  registeredAt: Date,
  observedAt: Date,
  accountVerifiedAt: Date,
): void {
  if (
    !(registeredAt instanceof Date) ||
    Number.isNaN(registeredAt.getTime()) ||
    !(accountVerifiedAt instanceof Date) ||
    Number.isNaN(accountVerifiedAt.getTime()) ||
    accountVerifiedAt.getTime() < observedAt.getTime() ||
    registeredAt.getTime() < accountVerifiedAt.getTime()
  ) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_CLOCK_INVALID",
      "Registration clock must return a valid time at or after the provider observation.",
    );
  }
}

function parseBoundary<Output>(
  schema: { parse(value: unknown): Output },
  value: unknown,
  code: string,
  message: string,
): Output {
  try {
    return schema.parse(value);
  } catch (error) {
    throw classifyBoundaryError(error, code, message);
  }
}

function classifyBoundaryError(
  error: unknown,
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  if (error instanceof MarketplaceListingRegistrationError) return error;
  return new MarketplaceListingRegistrationError(code, message, context, {
    cause: error,
  });
}
