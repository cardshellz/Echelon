import type {
  MarketplaceListingProviderAccountClaim,
  MarketplaceListingProviderAccountClaimer,
} from "../../marketplace-listings/application/registration-ports";
import type { ProviderAccountClaimResult } from "../../marketplace-listings/application/registration-dtos";
import { MARKETPLACE_PROVIDER_IDENTITY_SCHEME } from "../../marketplace-listings/domain/listing-registration-plan";
import { sha256Canonical } from "../../marketplace-listings/domain/canonical-hash";
import { MarketplaceListingRegistrationError } from "../../marketplace-listings/domain/registration-errors";
import type { DropshipStoreConnectionService } from "./dropship-store-connection-service";

export class DropshipMarketplaceRegistrationAccountClaimer
  implements MarketplaceListingProviderAccountClaimer
{
  constructor(
    private readonly storeConnections: Pick<
      DropshipStoreConnectionService,
      "claimObservedProviderAccount"
    >,
  ) {}

  async claimStableProviderAccount(
    claim: MarketplaceListingProviderAccountClaim,
  ): Promise<ProviderAccountClaimResult> {
    if (claim.owner.kind !== "dropship") {
      throw claimError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_OWNER_KIND_INVALID",
        "The Dropship provider-account claimer only accepts Dropship owners.",
        { ownerKind: claim.owner.kind },
      );
    }
    const provider = claim.providerAccount.provider.trim().toLowerCase();
    if (provider !== "ebay" || provider !== claim.owner.provider) {
      throw claimError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_ACCOUNT_PROVIDER_MISMATCH",
        "The observed seller account must be the eBay provider configured by the Dropship owner.",
        {
          ownerProvider: claim.owner.provider,
          observedProvider: provider,
        },
      );
    }
    if (
      claim.providerAccount.identityScheme !==
      MARKETPLACE_PROVIDER_IDENTITY_SCHEME
    ) {
      throw claimError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_ACCOUNT_IDENTITY_UNSTABLE",
        "Dropship registration requires the provider's stable provider_user_id identity.",
      );
    }
    const providerEnvironment = parseProviderEnvironment(
      claim.providerAccount.accountNamespace,
    );
    const expectedEvidenceHash = buildDropshipEbayProviderAccountEvidenceHash({
      providerEnvironment,
      externalAccountId: claim.providerAccount.externalAccountId,
    });
    if (claim.providerAccount.evidenceHash !== expectedEvidenceHash) {
      throw claimError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_ACCOUNT_EVIDENCE_INVALID",
        "The observed seller account evidence does not match the stable eBay identity.",
        {
          storeConnectionId: claim.owner.storeConnectionId,
          providerEnvironment,
        },
      );
    }
    const result = await this.storeConnections.claimObservedProviderAccount({
      storeConnectionId: claim.owner.storeConnectionId,
      platform: claim.owner.provider as Parameters<
        DropshipStoreConnectionService["claimObservedProviderAccount"]
      >[0]["platform"],
      providerEnvironment,
      externalAccountId: claim.providerAccount.externalAccountId,
      externalAccountIdentityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
      observedAt: claim.observedAt,
      idempotencyKey: claim.idempotencyKey,
      observationHash: claim.observationHash,
      correlationId: claim.correlationId,
      actor: {
        actorType: claim.requestedBy.type,
        actorId: claim.requestedBy.id,
      },
    });
    const verifiedAt = result.connection.externalAccountVerifiedAt;
    if (!verifiedAt) {
      throw claimError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_ACCOUNT_VERIFICATION_MISSING",
        "The durable Dropship seller identity claim did not record a verification timestamp.",
        { storeConnectionId: claim.owner.storeConnectionId },
      );
    }
    return {
      kind: result.claimed ? "claimed" : "replay",
      owner: { ...claim.owner },
      provider,
      accountNamespace: claim.providerAccount.accountNamespace,
      externalAccountId: result.connection.externalAccountId
        ?? claim.providerAccount.externalAccountId,
      identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
      verifiedAt,
    };
  }
}

export function buildDropshipEbayProviderAccountEvidenceHash(input: {
  providerEnvironment: string;
  externalAccountId: string;
}): string {
  return sha256Canonical({
    provider: "ebay",
    environment: input.providerEnvironment.trim().toLowerCase(),
    externalAccountId: input.externalAccountId.trim(),
    identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
  });
}

function parseProviderEnvironment(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "sandbox" && normalized !== "production") {
    throw claimError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_ACCOUNT_NAMESPACE_INVALID",
      "The observed seller account namespace must be the eBay provider environment.",
      { accountNamespace: value },
    );
  }
  return normalized;
}

function claimError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
