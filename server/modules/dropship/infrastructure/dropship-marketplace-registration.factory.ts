import { pool } from "../../../db";
import type {
  MarketplaceListingProviderAccountClaimer,
  MarketplaceListingRegistrationObserver,
  MarketplaceListingRegistrationOwnerReader,
} from "../../marketplace-listings/application/registration-ports";
import {
  EbayMarketplaceRegistrationObserver,
} from "../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import {
  FetchEbayRegistrationReadTransport,
  type EbayRegistrationCredentialProvider,
  type EbayRegistrationReadTransport,
} from "../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { createAuthorityAwareInventoryAtpService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { DropshipMarketplaceRegistrationAccountClaimer } from "../application/dropship-marketplace-registration-account-claimer";
import {
  DropshipMarketplaceRegistrationOwnerReader,
  type DropshipMarketplaceRegistrationOwnerRepository,
} from "../application/dropship-marketplace-registration-owner-reader";
import { InventoryServiceDropshipAtpProvider } from "./dropship-atp.provider";
import { DropshipEbayRegistrationCredentialAdapter } from "./dropship-ebay-registration-credential-adapter";
import {
  createDropshipEbayRegistrationCredentialProviderFromEnv,
  type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";
import { PgDropshipMarketplaceRegistrationOwnerRepository } from "./dropship-marketplace-registration-owner.repository";
import { createDropshipStoreConnectionServiceFromEnv } from "./dropship-store-connection.factory";

export interface DropshipMarketplaceRegistrationOwnerAdapters {
  readonly ownerReader: MarketplaceListingRegistrationOwnerReader;
  readonly observer: MarketplaceListingRegistrationObserver;
  readonly accountClaimer: MarketplaceListingProviderAccountClaimer;
  readonly credentials: EbayRegistrationCredentialProvider;
}

export interface CreateDropshipMarketplaceRegistrationAdaptersInput {
  readonly ownerRepository: DropshipMarketplaceRegistrationOwnerRepository;
  readonly accountClaimer: MarketplaceListingProviderAccountClaimer;
  readonly credentialProvider: DropshipEbayRegistrationCredentialProvider;
  readonly transport?: EbayRegistrationReadTransport;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** Testable composition boundary with no environment or global-route reads. */
export function createDropshipMarketplaceRegistrationAdapters(
  input: CreateDropshipMarketplaceRegistrationAdaptersInput,
): DropshipMarketplaceRegistrationOwnerAdapters {
  if (input.transport && input.fetch) {
    throw new Error(
      "Provide either an eBay registration read transport or fetch, not both.",
    );
  }
  const credentials = new DropshipEbayRegistrationCredentialAdapter(
    input.ownerRepository,
    input.credentialProvider,
  );
  const transport = input.transport
    ?? new FetchEbayRegistrationReadTransport(input.fetch);
  return {
    ownerReader: new DropshipMarketplaceRegistrationOwnerReader(
      input.ownerRepository,
    ),
    observer: new EbayMarketplaceRegistrationObserver(
      credentials,
      transport,
      { now: input.now },
    ),
    accountClaimer: input.accountClaimer,
    credentials,
  };
}

export interface CreateDropshipMarketplaceRegistrationOwnerAdaptersFromEnvOptions {
  readonly now?: () => Date;
}

/**
 * Production Dropship composition. Local ownership and credential loading stay
 * in Dropship; provider reads use the same shared observer as Channels.
 */
export function createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv(
  options: CreateDropshipMarketplaceRegistrationOwnerAdaptersFromEnvOptions = {},
): DropshipMarketplaceRegistrationOwnerAdapters {
  const atp = new InventoryServiceDropshipAtpProvider(
    createAuthorityAwareInventoryAtpService(pool),
  );
  const ownerRepository = new PgDropshipMarketplaceRegistrationOwnerRepository(
    atp,
  );
  return createDropshipMarketplaceRegistrationAdapters({
    ownerRepository,
    accountClaimer: new DropshipMarketplaceRegistrationAccountClaimer(
      createDropshipStoreConnectionServiceFromEnv(),
    ),
    credentialProvider:
      createDropshipEbayRegistrationCredentialProviderFromEnv(),
    now: options.now,
  });
}
