import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceListingPushProvider,
  DropshipMarketplaceListingPushRequest,
  DropshipMarketplaceListingPushResult,
} from "../application/dropship-marketplace-listing-push-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorDraft,
  type EbayListingLifecycleClient,
  type EbayListingRebuildPreview,
  type EbayListingRebuildResult,
} from "../../channels/listing-connectors/ebay-listing.connector";
import {
  EbayListingBuilder,
  type EbayListingConfig as SharedEbayListingConfig,
} from "../../channels/adapters/ebay/ebay-listing-builder";
import type {
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../../channels/adapters/ebay/ebay-types";
import type { ChannelListingPayload } from "../../channels/channel-adapter.interface";
import {
  ebayTokenRefreshErrorContext,
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
  recordEbayTokenRefreshFailure,
} from "./dropship-ebay-auth-failure";
import type {
  DropshipEbayFulfillmentPolicyGuard,
  DropshipEbayFulfillmentPolicyPreflight,
} from "../application/dropship-ebay-fulfillment-policy-guard";
import type {
  DropshipEbayManagedLocationProvider,
} from "../application/dropship-ebay-managed-location-service";

type FetchLike = typeof fetch;
interface Clock {
  now(): Date;
}

interface EbayListingConfig {
  marketplaceId: string;
  merchantLocationKey: string;
  businessPolicies: {
    paymentPolicyId: string;
    returnPolicyId: string;
    fulfillmentPolicyId: string;
  };
  environment: "sandbox" | "production";
}

interface EbayOfferResponse {
  offers?: Array<
    EbayOffer & {
      offerId?: string;
      listingId?: string;
      status?: string;
    }
  >;
}

export interface DropshipEbayListingLifecycleClient extends EbayListingLifecycleClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<(EbayInventoryItemGroup & { variantSKUs?: string[] }) | null>;
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
  withdrawOffer(offerId: string): Promise<void>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
}

export interface DropshipEbayReplacementSession {
  readonly marketplaceId: string;
  readonly client: DropshipEbayListingLifecycleClient;
}

export interface DropshipEbayListingRebuildRequest {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  readonly marketplaceConfig: Record<string, unknown>;
  readonly draft: EbayListingConnectorDraft;
}

interface EbayTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

const EBAY_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

const EBAY_TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;

const EBAY_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const EBAY_SELLING_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");

export class EbayDropshipListingPushProvider implements DropshipMarketplaceListingPushProvider {
  private readonly listingConnector = new EbayMarketplaceListingConnector();
  private readonly listingBuilder = new EbayListingBuilder();

  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly fulfillmentPolicyGuard?: DropshipEbayFulfillmentPolicyGuard,
    private readonly managedLocations?: DropshipEbayManagedLocationProvider,
  ) {}

  async pushListing(
    input: DropshipMarketplaceListingPushRequest,
  ): Promise<DropshipMarketplaceListingPushResult> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const config = parseEbayListingConfig(
      input.listingIntent.marketplaceConfig,
      credential.config,
    );
    credential = await this.ensureFreshAccessToken(credential, config);

    assertEbayReady(input, config);
    const preflight = await this.assertFulfillmentPolicyCompatible({ credential, config });
    await this.reconcileManagedLocation({ credential, config, preflight });
    const baseUrl = EBAY_BASE_URLS[config.environment];
    const draft = buildDropshipEbayListingDraft(
      input,
      config,
      this.listingBuilder,
    );
    const connectorResult = await this.listingConnector.pushListing({
      client: this.createConnectorClient({ credential, config, baseUrl }),
      draft: {
        productId: input.productVariantId,
        marketplaceId: config.marketplaceId,
        inventoryItems: draft.inventoryItems,
        offers: draft.offers,
        itemGroup: draft.itemGroup,
        publishMode:
          input.listingIntent.listingMode === "live" ? "publish" : "stage",
        hasExistingExternalIds: Boolean(
          input.existingExternalListingId || input.existingExternalOfferId,
        ),
        existingExternalProductId: input.existingExternalListingId,
        existingOfferIdsByVariantId: {
          [input.productVariantId]: input.existingExternalOfferId,
        },
        updateOfferAfterCreate: true,
      },
    });

    const offerId =
      connectorResult.externalOfferIds[input.productVariantId] ?? null;
    const listingId =
      connectorResult.externalProductId ?? input.existingExternalListingId;
    if (input.listingIntent.listingMode === "live" && !listingId) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_ID_REQUIRED",
        "eBay publish did not return a listing id.",
        { retryable: true },
      );
    }

    return {
      status: connectorResult.status,
      externalListingId: listingId ?? offerId!,
      externalOfferId: offerId,
      rawResult: {
        provider: "ebay",
        marketplaceId: config.marketplaceId,
        listingMode: input.listingIntent.listingMode,
        published: connectorResult.published,
      },
    };
  }

  async previewListingRebuild(
    input: DropshipEbayListingRebuildRequest & { readonly currentExternalListingId: string },
  ): Promise<EbayListingRebuildPreview> {
    const session = await this.createReplacementLifecycleClient(input);
    assertRebuildMarketplaceMatches(input.draft, session.marketplaceId);
    return this.listingConnector.previewListingRebuild({
      client: session.client,
      draft: input.draft,
      currentExternalListingId: input.currentExternalListingId,
    });
  }

  async executeListingRebuild(
    input: DropshipEbayListingRebuildRequest & { readonly preview: EbayListingRebuildPreview },
  ): Promise<EbayListingRebuildResult> {
    const session = await this.createReplacementLifecycleClient(input);
    assertRebuildMarketplaceMatches(input.draft, session.marketplaceId);
    return this.listingConnector.executeListingRebuild({
      client: session.client,
      draft: input.draft,
      preview: input.preview,
    });
  }
  async createReplacementLifecycleClient(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceConfig: Record<string, unknown>;
  }): Promise<DropshipEbayReplacementSession> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const config = parseEbayListingConfig(
      input.marketplaceConfig,
      credential.config,
    );
    credential = await this.ensureFreshAccessToken(credential, config);
    await this.assertFulfillmentPolicyCompatible({ credential, config });
    return {
      marketplaceId: config.marketplaceId,
      client: this.createConnectorClient({
        credential,
        config,
        baseUrl: EBAY_BASE_URLS[config.environment],
      }),
    };
  }
  private async assertFulfillmentPolicyCompatible(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight> {
    if (!this.fulfillmentPolicyGuard) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_GUARD_REQUIRED",
        "eBay listing push requires fulfillment policy compatibility validation.",
        { retryable: false },
      );
    }
    const preflight = await this.fulfillmentPolicyGuard.evaluateWithAccessToken({
      storeConnectionId: input.credential.storeConnectionId,
      marketplaceId: input.config.marketplaceId,
      fulfillmentPolicyId: input.config.businessPolicies.fulfillmentPolicyId,
      accessToken: input.credential.accessToken,
      environment: input.config.environment,
      fresh: true,
    });
    if (!preflight.compatible) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        "The selected eBay fulfillment policy exceeds current Card Shellz fulfillment capabilities.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          fulfillmentPolicyId: preflight.fulfillmentPolicyId,
          capabilityEvidenceHash: preflight.capabilityEvidenceHash,
          issues: preflight.issues,
          retryable: false,
        },
      );
    }
    return preflight;
  }
  private async reconcileManagedLocation(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    preflight: DropshipEbayFulfillmentPolicyPreflight;
  }): Promise<void> {
    if (!this.managedLocations) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_PROVIDER_REQUIRED",
        "eBay listing push requires the Card Shellz-managed inventory location provider.",
        { retryable: false },
      );
    }
    const originWarehouseId = input.preflight.originWarehouseId;
    if (!Number.isSafeInteger(originWarehouseId) || (originWarehouseId ?? 0) <= 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED",
        "eBay listing push requires a verified Card Shellz origin warehouse.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          originWarehouseId,
          retryable: false,
        },
      );
    }
    const location = await this.managedLocations.ensureWithAccessToken({
      accessToken: input.credential.accessToken,
      environment: input.config.environment,
      storeConnectionId: input.credential.storeConnectionId,
      originWarehouseId: originWarehouseId as number,
    });
    if (location.merchantLocationKey !== input.config.merchantLocationKey) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
        "Save eBay listing setup before pushing so it uses the Card Shellz-managed inventory location.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          originWarehouseId,
          retryable: false,
        },
      );
    }
  }
  private createConnectorClient(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    baseUrl: string;
  }): DropshipEbayListingLifecycleClient {
    return {
      getInventoryItemGroup: async (groupKey) => {
        try {
          return await this.requestEbay<
            EbayInventoryItemGroup & { variantSKUs?: string[] }
          >({
            credential: input.credential,
            config: input.config,
            method: "GET",
            path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
            baseUrl: input.baseUrl,
          });
        } catch (error: unknown) {
          if (error instanceof DropshipError && error.context?.status === 404)
            return null;
          throw error;
        }
      },
      getInventoryItem: async (sku) => {
        try {
          return await this.requestEbay<EbayInventoryItem>({
            credential: input.credential,
            config: input.config,
            method: "GET",
            path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
            baseUrl: input.baseUrl,
          });
        } catch (error: any) {
          if (String(error?.message ?? "").includes("404")) {
            return null;
          }
          throw error;
        }
      },
      createOrReplaceInventoryItem: async (sku, item) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "PUT",
          path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
          body: item,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      getOffers: async (sku, marketplaceId) => {
        const result = await this.requestEbay<EbayOfferResponse>({
          credential: input.credential,
          config: input.config,
          method: "GET",
          path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`,
          baseUrl: input.baseUrl,
        });
        return {
          offers: (result.offers ?? [])
            .filter(
              (
                offer,
              ): offer is EbayOffer & {
                offerId: string;
                listingId?: string;
                status?: string;
              } => Boolean(offer.offerId),
            )
            .map(
              (offer) =>
                offer as EbayOffer & { offerId: string; listingId?: string },
            ),
        };
      },
      createOffer: async (offer) => {
        const result = await this.requestEbay<{ offerId?: string }>({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: "/sell/inventory/v1/offer",
          body: offer,
          baseUrl: input.baseUrl,
        });
        if (!result.offerId) {
          throw new DropshipError(
            "DROPSHIP_EBAY_OFFER_ID_REQUIRED",
            "eBay create offer did not return an offer id.",
            { retryable: true },
          );
        }
        return result.offerId;
      },
      updateOffer: async (offerId, offer) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "PUT",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
          body: offer,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      createOrReplaceInventoryItemGroup: async (groupKey, group) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "PUT",
          path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
          body: { ...group, inventoryItemGroupKey: groupKey },
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      deleteInventoryItemGroup: async (groupKey) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "DELETE",
          path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      publishOffer: async (offerId) => {
        return await this.requestEbay<{ listingId?: string }>({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
          baseUrl: input.baseUrl,
        });
      },
      publishOfferByInventoryItemGroup: async (groupKey, marketplaceId) => {
        return await this.requestEbay<{ listingId?: string }>({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
          body: { inventoryItemGroupKey: groupKey, marketplaceId },
          baseUrl: input.baseUrl,
        });
      },
      bulkUpdatePriceQuantity: async (body: EbayBulkPriceQuantityRequest) => {
        return await this.requestEbay<EbayBulkPriceQuantityResponse>({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: "/sell/inventory/v1/bulk_update_price_quantity",
          body,
          baseUrl: input.baseUrl,
        });
      },
      withdrawOffer: async (offerId) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
          baseUrl: input.baseUrl,
        });
      },
      withdrawOfferByInventoryItemGroup: async (groupKey, marketplaceId) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          method: "POST",
          path: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
          body: { inventoryItemGroupKey: groupKey, marketplaceId },
          baseUrl: input.baseUrl,
        });
      },
    };
  }

  private async ensureFreshAccessToken(
    credential: DropshipMarketplaceStoreCredentials,
    config: EbayListingConfig,
  ): Promise<DropshipMarketplaceStoreCredentials> {
    if (
      credential.accessTokenExpiresAt &&
      credential.accessTokenExpiresAt.getTime() - this.clock.now().getTime() >
        EBAY_REFRESH_BUFFER_MS
    ) {
      return credential;
    }
    if (!credential.refreshToken) {
      await this.recordNeedsReauth(credential, {
        failureCode: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        message: "eBay refresh token is missing for dropship listing push.",
      });
      throw new DropshipError(
        "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        "eBay refresh token is required.",
        {
          storeConnectionId: credential.storeConnectionId,
          retryable: false,
        },
      );
    }
    const clientId =
      process.env.DROPSHIP_EBAY_CLIENT_ID ?? process.env.EBAY_CLIENT_ID;
    const clientSecret =
      process.env.DROPSHIP_EBAY_CLIENT_SECRET ?? process.env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new DropshipError(
        "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
        "eBay OAuth client credentials are missing.",
        {
          retryable: false,
        },
      );
    }

    const response = await this.fetchImpl(EBAY_TOKEN_URLS[config.environment], {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        scope: EBAY_SELLING_SCOPES,
      }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      const message = `eBay token refresh failed with HTTP ${response.status}.`;
      const classification = await recordEbayTokenRefreshFailure({
        credentials: this.credentials,
        credential,
        status: response.status,
        responseBody: text,
        failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        message,
        now: this.clock.now(),
      });
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        message,
        ebayTokenRefreshErrorContext({
          status: response.status,
          responseBody: text,
          classification,
        }),
      );
    }
    const token = parseEbayJson<EbayTokenResponse>({
      text,
      code: "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
      message: "eBay token refresh returned invalid JSON.",
    });
    if (
      !token.access_token ||
      typeof token.expires_in !== "number" ||
      token.expires_in <= 0
    ) {
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID",
        "eBay token refresh response was invalid.",
        {
          retryable: true,
        },
      );
    }
    const now = this.clock.now();
    return this.credentials.replaceTokens({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      accessTokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
      now,
    });
  }

  private async requestEbay<T = Record<string, unknown>>(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    expectNoContent?: boolean;
    baseUrl: string;
  }): Promise<T> {
    const response = await this.fetchImpl(`${input.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.credential.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": input.config.marketplaceId,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.text();
    if (response.status === 204 || input.expectNoContent) {
      if (response.ok) return undefined as T;
    }
    if (!response.ok) {
      const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential: input.credential,
          status: response.status,
          failureCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
          message: `eBay listing push failed with HTTP ${response.status}.`,
          now: this.clock.now(),
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        `eBay listing push failed with HTTP ${response.status}.`,
        {
          retryable: accessTokenRejected || response.status === 429 || response.status >= 500,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    return parseEbayJson<T>({
      text,
      code: "DROPSHIP_EBAY_LISTING_PUSH_INVALID_RESPONSE",
      message: "eBay listing push returned invalid JSON.",
    });
  }

  private async recordNeedsReauth(
    credential: DropshipMarketplaceStoreCredentials,
    input: {
      failureCode: string;
      message: string;
      statusCode?: number;
    },
  ): Promise<void> {
    await this.credentials.recordAuthFailure?.({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      status: "needs_reauth",
      failureCode: input.failureCode,
      message: input.message,
      retryable: false,
      statusCode: input.statusCode,
      now: this.clock.now(),
    });
  }
}

function assertRebuildMarketplaceMatches(
  draft: EbayListingConnectorDraft,
  configuredMarketplaceId: string,
): void {
  if (draft.marketplaceId !== configuredMarketplaceId) {
    throw new DropshipError(
      "DROPSHIP_EBAY_REBUILD_MARKETPLACE_MISMATCH",
      "The requested rebuild marketplace does not match the store connection.",
      {
        requestedMarketplaceId: draft.marketplaceId,
        configuredMarketplaceId,
        retryable: false,
      },
    );
  }
}
function parseEbayListingConfig(
  intentConfig: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): EbayListingConfig {
  const config = {
    ...connectionConfig,
    ...intentConfig,
  };
  const businessPolicies = recordFromConfig(config, "businessPolicies");
  const parsed = {
    marketplaceId: requiredConfigString(config, "marketplaceId"),
    merchantLocationKey: requiredConfigString(config, "merchantLocationKey"),
    businessPolicies: {
      paymentPolicyId: requiredConfigString(
        businessPolicies,
        "paymentPolicyId",
      ),
      returnPolicyId: requiredConfigString(businessPolicies, "returnPolicyId"),
      fulfillmentPolicyId: requiredConfigString(
        businessPolicies,
        "fulfillmentPolicyId",
      ),
    },
    environment:
      config.environment === "sandbox"
        ? ("sandbox" as const)
        : ("production" as const),
  };
  return parsed;
}

function assertEbayReady(
  input: DropshipMarketplaceListingPushRequest,
  config: EbayListingConfig,
): void {
  const intent = input.listingIntent;
  if (!intent.sku?.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_SKU_REQUIRED",
      "eBay listing push requires a SKU.",
      { retryable: false },
    );
  }
  if (intent.imageUrls.length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_IMAGE_REQUIRED",
      "eBay listing push requires at least one product image.",
      {
        retryable: false,
      },
    );
  }
  if (!Number.isInteger(intent.weightGrams) || (intent.weightGrams ?? 0) <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_PACKAGE_WEIGHT_REQUIRED",
      "eBay listing push requires a positive catalog variant weight.",
      { productVariantId: input.productVariantId, retryable: false },
    );
  }
  if (!intent.marketplaceCategoryId?.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_BROWSE_CATEGORY_REQUIRED",
      "eBay listing push requires the catalog product's eBay browse category.",
      {
        productVariantId: input.productVariantId,
        retryable: false,
      },
    );
  }
  if (!config.merchantLocationKey) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED",
      "eBay listing configuration is incomplete.",
      {
        retryable: false,
      },
    );
  }
}

function buildDropshipEbayListingDraft(
  input: DropshipMarketplaceListingPushRequest,
  config: EbayListingConfig,
  listingBuilder: EbayListingBuilder,
) {
  const intent = input.listingIntent;
  const marketplaceCategoryId = intent.marketplaceCategoryId?.trim();
  if (!marketplaceCategoryId) {
    throw new DropshipError(
      "DROPSHIP_EBAY_BROWSE_CATEGORY_REQUIRED",
      "eBay listing push requires the catalog product's eBay browse category.",
      { productVariantId: input.productVariantId, retryable: false },
    );
  }
  const sku = intent.sku?.trim();
  if (!sku) {
    throw new DropshipError(
      "DROPSHIP_EBAY_SKU_REQUIRED",
      "eBay listing push requires a SKU.",
      {
        retryable: false,
      },
    );
  }
  const listing: ChannelListingPayload = {
    productId: input.productVariantId,
    title: intent.title,
    description: intent.description ?? intent.title,
    category: intent.category,
    tags: null,
    status: "active",
    variants: [
      {
        variantId: input.productVariantId,
        sku,
        name: intent.title,
        barcode: null,
        gtin: intent.gtin,
        mpn: intent.mpn,
        weightGrams: intent.weightGrams,
        priceCents: intent.priceCents,
        compareAtPriceCents: null,
        isListed: true,
        externalVariantId: input.existingExternalOfferId,
        externalInventoryItemId: null,
      },
    ],
    images: intent.imageUrls.slice(0, 12).map((url, index) => ({
      url,
      altText: null,
      position: index + 1,
      variantSku: sku,
    })),
    metadata: {
      itemSpecifics: buildEbayAspects(input),
    },
  };
  const sharedConfig: SharedEbayListingConfig = {
    merchantLocationKey: config.merchantLocationKey,
    marketplaceId: config.marketplaceId,
    listingPolicies: config.businessPolicies,
  };
  const quantityByVariantId = new Map([
    [input.productVariantId, intent.quantity],
  ]);

  return listingBuilder.buildListingDraft(listing, sharedConfig, {
    availableQuantityByVariantId: quantityByVariantId,
    categoryIdOverride: marketplaceCategoryId,
    conditionOverride: mapEbayCondition(intent.condition),
    descriptionHtmlOverride: intent.description ?? intent.title,
    includeOfferTax: false,
    requirePackageWeight: true,
    storeCategoryNames: intent.storeCategoryNames,
  });
}

function buildEbayAspects(
  input: DropshipMarketplaceListingPushRequest,
): Record<string, string[]> {
  const raw = input.listingIntent.itemSpecifics ?? {};
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const values = value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
      if (values.length > 0) aspects[key] = values;
    } else if (typeof value === "string" && value.trim()) {
      aspects[key] = [value.trim()];
    }
  }
  if (input.listingIntent.brand && !aspects.Brand) {
    aspects.Brand = [input.listingIntent.brand];
  }
  return aspects;
}

function mapEbayCondition(
  condition: string | null,
): EbayInventoryItem["condition"] {
  const normalized = condition?.trim().toLowerCase();
  if (!normalized || normalized === "new") {
    return "NEW";
  }
  if (normalized === "used") {
    return "USED_GOOD";
  }
  const candidate = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return isEbayCondition(candidate) ? candidate : "NEW";
}

function isEbayCondition(
  value: string,
): value is EbayInventoryItem["condition"] {
  return [
    "NEW",
    "LIKE_NEW",
    "NEW_OTHER",
    "NEW_WITH_DEFECTS",
    "MANUFACTURER_REFURBISHED",
    "CERTIFIED_REFURBISHED",
    "EXCELLENT_REFURBISHED",
    "VERY_GOOD_REFURBISHED",
    "GOOD_REFURBISHED",
    "SELLER_REFURBISHED",
    "USED_EXCELLENT",
    "USED_VERY_GOOD",
    "USED_GOOD",
    "USED_ACCEPTABLE",
    "FOR_PARTS_OR_NOT_WORKING",
  ].includes(value);
}

function requiredConfigString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED",
      "eBay listing configuration is incomplete.",
      {
        missingKey: key,
        retryable: false,
      },
    );
  }
  return value.trim();
}

function recordFromConfig(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseEbayJson<T>(input: {
  text: string;
  code: string;
  message: string;
}): T {
  if (!input.text) return {} as T;
  try {
    return JSON.parse(input.text) as T;
  } catch {
    throw new DropshipError(input.code, input.message, { retryable: true });
  }
}
