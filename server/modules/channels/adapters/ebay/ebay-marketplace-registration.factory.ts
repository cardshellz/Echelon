import type {
  MarketplaceListingProviderAccountClaimer,
  MarketplaceListingRegistrationObserver,
  MarketplaceListingRegistrationOwnerReader,
} from "../../../marketplace-listings/application/registration-ports";
import {
  EbayMarketplaceRegistrationObserver,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import {
  FetchEbayRegistrationReadTransport,
  type EbayRegistrationReadTransport,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import type { EbayAuthService } from "./ebay-auth.service";
import {
  EbayMarketplaceRegistrationOwnerReader,
  type EbayMarketplaceRegistrationOwnerRepository,
} from "./ebay-marketplace-registration-owner.reader";
import { PgEbayMarketplaceRegistrationOwnerRepository } from "./ebay-marketplace-registration-owner.pg-repository";
import {
  EbayChannelRegistrationCredentialProvider,
  EbayMarketplaceListingProviderAccountClaimer,
} from "./ebay-marketplace-registration.provider-adapters";

export interface EbayMarketplaceRegistrationAdapters {
  readonly ownerReader: MarketplaceListingRegistrationOwnerReader;
  readonly observer: MarketplaceListingRegistrationObserver;
  readonly accountClaimer: MarketplaceListingProviderAccountClaimer;
}

export interface CreateEbayMarketplaceRegistrationAdaptersInput {
  readonly authService: EbayAuthService;
  readonly ownerRepository?: EbayMarketplaceRegistrationOwnerRepository;
  readonly transport?: EbayRegistrationReadTransport;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Channel owns local catalog reads, credentials, and account claims. The eBay
 * publication observation algorithm itself is supplied by marketplace-listings
 * and is exactly the same implementation used for Dropship owners.
 */
export function createEbayMarketplaceRegistrationAdapters(
  input: CreateEbayMarketplaceRegistrationAdaptersInput,
): EbayMarketplaceRegistrationAdapters {
  if (input.transport && input.fetch) {
    throw new Error(
      "Provide either an eBay registration read transport or fetch, not both.",
    );
  }
  const transport = input.transport
    ?? new FetchEbayRegistrationReadTransport(input.fetch);
  const ownerRepository = input.ownerRepository
    ?? new PgEbayMarketplaceRegistrationOwnerRepository();
  const credentials = new EbayChannelRegistrationCredentialProvider(
    input.authService,
  );
  return {
    ownerReader: new EbayMarketplaceRegistrationOwnerReader(ownerRepository),
    observer: new EbayMarketplaceRegistrationObserver(
      credentials,
      transport,
      { now: input.now },
    ),
    accountClaimer: new EbayMarketplaceListingProviderAccountClaimer(
      input.authService,
    ),
  };
}
