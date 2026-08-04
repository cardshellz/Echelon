import type {
  MarketplaceListingProviderAccountClaim,
  MarketplaceListingProviderAccountClaimer,
} from "../../../marketplace-listings/application/registration-ports";
import type { ProviderAccountClaimResult } from "../../../marketplace-listings/application/registration-dtos";
import {
  buildEbayProviderAccountEvidenceHash,
  ebayProviderAccountNamespace,
  type EbayRegistrationCredentialProvider,
  type EbayRegistrationReadCredential,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import {
  MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
} from "../../../marketplace-listings/domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../../../marketplace-listings/domain/registration-errors";
import type { ListingOwnerRef } from "../../../marketplace-listings/domain/listing-replacement-plan";
import type {
  EbayAuthService,
  EbayObservedProviderAccount,
} from "./ebay-auth.service";

const EBAY_PROVIDER = "ebay" as const;

/** Channels credential adapter for the shared provider-owned observer. */
export class EbayChannelRegistrationCredentialProvider
  implements EbayRegistrationCredentialProvider
{
  constructor(private readonly authService: EbayAuthService) {}

  async loadFreshCredential(
    owner: ListingOwnerRef,
  ): Promise<EbayRegistrationReadCredential> {
    const channelOwner = assertEbayChannelOwner(owner);
    return {
      accessToken: await this.authService.getAccessToken(channelOwner.channelId),
      environment: this.authService.getEnvironment(),
    };
  }
}

export class EbayMarketplaceListingProviderAccountClaimer
  implements MarketplaceListingProviderAccountClaimer
{
  constructor(private readonly authService: EbayAuthService) {}

  async claimStableProviderAccount(
    claim: MarketplaceListingProviderAccountClaim,
  ): Promise<ProviderAccountClaimResult> {
    const owner = assertEbayChannelOwner(claim.owner);
    const environment = this.authService.getEnvironment();
    const expectedNamespace = ebayProviderAccountNamespace(environment);
    const expectedEvidenceHash = buildEbayProviderAccountEvidenceHash(
      environment,
      claim.providerAccount.externalAccountId,
    );
    if (
      claim.providerAccount.provider !== EBAY_PROVIDER
      || claim.providerAccount.accountNamespace !== expectedNamespace
      || claim.providerAccount.identityScheme
        !== MARKETPLACE_PROVIDER_IDENTITY_SCHEME
      || claim.providerAccount.evidenceHash !== expectedEvidenceHash
    ) {
      throw adapterError(
        "EBAY_REGISTRATION_ACCOUNT_CLAIM_INVALID",
        "The confirmed provider account observation is not valid for this eBay credential environment.",
        { channelId: owner.channelId, environment },
      );
    }

    const observedAccount: EbayObservedProviderAccount = {
      externalAccountId: claim.providerAccount.externalAccountId,
      externalAccountDisplayName:
        claim.providerAccount.externalDisplayNameSnapshot,
      externalAccountIdentityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
      externalAccountVerifiedAt: new Date(claim.observedAt.getTime()),
    };
    const outcome = await this.authService.claimObservedProviderAccount(
      owner.channelId,
      observedAccount,
      {
        idempotencyKey: claim.idempotencyKey,
        observationHash: claim.observationHash,
        requestedBy: claim.requestedBy,
        correlationId: claim.correlationId,
      },
    );
    return {
      kind: outcome.kind,
      owner: { ...owner },
      provider: EBAY_PROVIDER,
      accountNamespace: expectedNamespace,
      externalAccountId: outcome.account.externalAccountId,
      identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
      verifiedAt: new Date(outcome.account.externalAccountVerifiedAt.getTime()),
    };
  }
}

function assertEbayChannelOwner(
  owner: ListingOwnerRef,
): Extract<ListingOwnerRef, { kind: "channel" }> {
  if (
    owner.kind !== "channel"
    || owner.provider.trim().toLowerCase() !== EBAY_PROVIDER
  ) {
    throw adapterError(
      "EBAY_REGISTRATION_CHANNEL_OWNER_INVALID",
      "The eBay Channels registration adapter only accepts eBay channel owners.",
      { ownerKind: owner.kind, provider: owner.provider },
    );
  }
  if (!Number.isSafeInteger(owner.channelId) || owner.channelId <= 0) {
    throw adapterError(
      "EBAY_REGISTRATION_CHANNEL_ID_INVALID",
      "The eBay Channels registration owner has an invalid channel ID.",
      { channelId: owner.channelId },
    );
  }
  return owner;
}

function adapterError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
