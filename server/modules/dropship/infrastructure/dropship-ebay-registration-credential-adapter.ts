import type {
  EbayRegistrationCredentialProvider,
  EbayRegistrationReadCredential,
} from "../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { MarketplaceListingRegistrationError } from "../../marketplace-listings/domain/registration-errors";
import type { ListingOwnerRef } from "../../marketplace-listings/domain/listing-replacement-plan";
import type { DropshipMarketplaceRegistrationOwnerRepository } from "../application/dropship-marketplace-registration-owner-reader";
import {
  resolveDropshipEbayProviderEnvironment,
  type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";

const EBAY_PROVIDER = "ebay" as const;

/**
 * Tenant-scoped credential bridge from Dropship ownership to the one shared
 * eBay registration observer. It revalidates the store before loading secrets
 * so an arbitrary owner reference cannot cross a vendor/store boundary.
 */
export class DropshipEbayRegistrationCredentialAdapter
  implements EbayRegistrationCredentialProvider
{
  constructor(
    private readonly owners: Pick<
      DropshipMarketplaceRegistrationOwnerRepository,
      "loadStoreConnection"
    >,
    private readonly credentials: Pick<
      DropshipEbayRegistrationCredentialProvider,
      "loadFreshForStoreConnection"
    >,
  ) {}

  async loadFreshCredential(
    owner: ListingOwnerRef,
  ): Promise<EbayRegistrationReadCredential> {
    const dropshipOwner = assertEbayDropshipOwner(owner);
    const store = await this.owners.loadStoreConnection(
      dropshipOwner.storeConnectionId,
    );
    if (
      !store
      || store.id !== dropshipOwner.storeConnectionId
      || store.platform.trim().toLowerCase() !== EBAY_PROVIDER
    ) {
      throw adapterError(
        "DROPSHIP_EBAY_REGISTRATION_STORE_NOT_FOUND",
        "The requested eBay Dropship store connection does not exist.",
        { storeConnectionId: dropshipOwner.storeConnectionId },
      );
    }
    if (store.status !== "connected") {
      throw adapterError(
        "DROPSHIP_EBAY_REGISTRATION_STORE_NOT_CONNECTED",
        "The eBay Dropship store connection must be connected before registration.",
        { storeConnectionId: store.id, status: store.status },
      );
    }
    const marketplaceIds = new Set(
      store.marketplaceIds.map((value) => value.trim()).filter(Boolean),
    );
    if (!marketplaceIds.has(dropshipOwner.marketplaceId)) {
      throw adapterError(
        "DROPSHIP_EBAY_REGISTRATION_MARKETPLACE_MISMATCH",
        "The requested marketplace is not configured for this Dropship store connection.",
        {
          storeConnectionId: store.id,
          marketplaceId: dropshipOwner.marketplaceId,
        },
      );
    }
    if (!Number.isSafeInteger(store.vendorId) || store.vendorId <= 0) {
      throw adapterError(
        "DROPSHIP_EBAY_REGISTRATION_VENDOR_INVALID",
        "The eBay Dropship store connection has an invalid vendor owner.",
        { storeConnectionId: store.id, vendorId: store.vendorId },
      );
    }

    const credential = await this.credentials.loadFreshForStoreConnection({
      vendorId: store.vendorId,
      storeConnectionId: store.id,
    });
    if (
      credential.vendorId !== store.vendorId
      || credential.storeConnectionId !== store.id
      || credential.platform.trim().toLowerCase() !== EBAY_PROVIDER
    ) {
      throw adapterError(
        "DROPSHIP_EBAY_REGISTRATION_CREDENTIAL_OWNER_MISMATCH",
        "The refreshed eBay credential does not belong to the requested Dropship store.",
        { storeConnectionId: store.id, vendorId: store.vendorId },
      );
    }
    return {
      accessToken: credential.accessToken,
      environment: resolveDropshipEbayProviderEnvironment(credential),
    };
  }
}

function assertEbayDropshipOwner(
  owner: ListingOwnerRef,
): Extract<ListingOwnerRef, { kind: "dropship" }> {
  if (
    owner.kind !== "dropship"
    || owner.provider.trim().toLowerCase() !== EBAY_PROVIDER
  ) {
    throw adapterError(
      "DROPSHIP_EBAY_REGISTRATION_OWNER_INVALID",
      "The Dropship eBay credential adapter only accepts eBay Dropship owners.",
      { ownerKind: owner.kind, provider: owner.provider },
    );
  }
  if (
    !Number.isSafeInteger(owner.storeConnectionId)
    || owner.storeConnectionId <= 0
  ) {
    throw adapterError(
      "DROPSHIP_EBAY_REGISTRATION_STORE_ID_INVALID",
      "The Dropship eBay registration owner has an invalid store connection ID.",
      { storeConnectionId: owner.storeConnectionId },
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
