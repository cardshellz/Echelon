import {
  DropshipStoreConnectionService,
  type DropshipMarketplaceOAuthProvider,
  type DropshipStoreConnectionOAuthStart,
  type DropshipStoreConnectionTokenGrant,
  type DropshipStoreTokenCipher,
  makeDropshipStoreConnectionLogger,
  systemDropshipStoreConnectionClock,
} from "../application/dropship-store-connection-service";
import type { DropshipSupportedStorePlatform } from "../domain/store-connection";
import { DropshipError } from "../domain/errors";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipStoreConnectionRepository } from "./dropship-store-connection.repository";
import { HmacDropshipOAuthStateSigner } from "./dropship-oauth-state-signer";
import {
  EbayDropshipOAuthProvider,
  ShopifyDropshipOAuthProvider,
} from "./dropship-marketplace-oauth.providers";
import { ShopifyDropshipWebhookSubscriptionProvider } from "./dropship-shopify-webhook-subscription.provider";
import { AesGcmDropshipStoreTokenCipher } from "./dropship-token-cipher";

export function createDropshipStoreConnectionServiceFromEnv(): DropshipStoreConnectionService {
  return new DropshipStoreConnectionService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipStoreConnectionRepository(),
    oauthProviders: {
      ebay: createProvider("ebay"),
      shopify: createProvider("shopify"),
    } satisfies Record<DropshipSupportedStorePlatform, DropshipMarketplaceOAuthProvider>,
    stateSigner: new HmacDropshipOAuthStateSigner(
      process.env.DROPSHIP_STORE_OAUTH_STATE_SECRET
        ?? process.env.DROPSHIP_AUTH_CHALLENGE_SECRET
        ?? process.env.SESSION_SECRET
        ?? "",
    ),
    tokenCipher: new LazyEnvDropshipStoreTokenCipher(),
    postConnectProvider: ShopifyDropshipWebhookSubscriptionProvider.fromEnv(),
    clock: systemDropshipStoreConnectionClock,
    logger: makeDropshipStoreConnectionLogger(),
    disconnectGraceHours: Number(process.env.DROPSHIP_STORE_DISCONNECT_GRACE_HOURS || 72),
  });
}

function createProvider(platform: DropshipSupportedStorePlatform): DropshipMarketplaceOAuthProvider {
  try {
    return platform === "ebay"
      ? EbayDropshipOAuthProvider.fromEnv()
      : ShopifyDropshipOAuthProvider.fromEnv();
  } catch (error) {
    return new UnconfiguredDropshipOAuthProvider(platform, error);
  }
}

class UnconfiguredDropshipOAuthProvider implements DropshipMarketplaceOAuthProvider {
  constructor(
    readonly platform: DropshipSupportedStorePlatform,
    private readonly cause: unknown,
  ) {}

  createAuthorizationUrl(): DropshipStoreConnectionOAuthStart {
    throw this.error();
  }

  async exchangeCode(): Promise<DropshipStoreConnectionTokenGrant> {
    throw this.error();
  }

  private error(): DropshipError {
    const code = this.platform === "ebay"
      ? "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED"
      : "DROPSHIP_SHOPIFY_OAUTH_NOT_CONFIGURED";
    return new DropshipError(code, "Dropship store OAuth provider is not configured.", {
      platform: this.platform,
      cause: this.cause instanceof Error ? this.cause.message : String(this.cause),
    });
  }
}

class LazyEnvDropshipStoreTokenCipher implements DropshipStoreTokenCipher {
  seal(input: Parameters<DropshipStoreTokenCipher["seal"]>[0]) {
    return AesGcmDropshipStoreTokenCipher.fromEnv().seal(input);
  }
}
