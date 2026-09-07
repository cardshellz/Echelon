import {
  createDropshipMarketplaceCredentialRepositoryFromEnv,
  type DropshipMarketplaceCredentialRepository,
  type DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import { DropshipEbayTokenOwner } from "./dropship-ebay-token-owner";

export { resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";

export interface DropshipEbayRegistrationCredentialProvider {
  /** Credential maintenance only; never publishes or mutates marketplace listings. */
  loadFreshForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    rejectedAccessTokenRef?: string;
    operation?: string;
  }): Promise<DropshipMarketplaceStoreCredentials>;
}

/** Compatibility adapter: every eBay consumer shares the same token lifecycle. */
export class RefreshingDropshipEbayRegistrationCredentialProvider
  implements DropshipEbayRegistrationCredentialProvider
{
  private readonly owner: DropshipEbayTokenOwner;

  constructor(
    credentials: DropshipMarketplaceCredentialRepository,
    oauthClient: { clientId: string | null; clientSecret: string | null },
    fetchFn: typeof fetch = fetch,
    clock: { now(): Date } = { now: () => new Date() },
  ) {
    this.owner = new DropshipEbayTokenOwner({ credentials, oauthClient, fetchFn, clock });
  }

  static fromEnv(
    credentials: DropshipMarketplaceCredentialRepository,
  ): RefreshingDropshipEbayRegistrationCredentialProvider {
    return new RefreshingDropshipEbayRegistrationCredentialProvider(credentials, {
      clientId: configuredEnv("DROPSHIP_EBAY_CLIENT_ID") ?? configuredEnv("EBAY_CLIENT_ID"),
      clientSecret: configuredEnv("DROPSHIP_EBAY_CLIENT_SECRET") ?? configuredEnv("EBAY_CLIENT_SECRET"),
    });
  }

  loadFreshForStoreConnection(
    input: Parameters<DropshipEbayRegistrationCredentialProvider["loadFreshForStoreConnection"]>[0],
  ): Promise<DropshipMarketplaceStoreCredentials> {
    return this.owner.loadFreshForStoreConnection({
      ...input,
      operation: input.operation ?? "registration-read",
    });
  }
}

export function createDropshipEbayRegistrationCredentialProviderFromEnv(): DropshipEbayRegistrationCredentialProvider {
  return RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(
    createDropshipMarketplaceCredentialRepositoryFromEnv(),
  );
}

function configuredEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}
