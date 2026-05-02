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

type FetchLike = typeof fetch;
interface Clock {
  now(): Date;
}

interface EbayListingConfig {
  marketplaceId: string;
  categoryId: string;
  merchantLocationKey: string;
  businessPolicies: {
    paymentPolicyId: string;
    returnPolicyId: string;
    fulfillmentPolicyId: string;
  };
  environment: "sandbox" | "production";
}

interface EbayOfferResponse {
  offers?: Array<{
    offerId?: string;
    listingId?: string;
  }>;
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
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const config = parseEbayListingConfig(input.listingIntent.marketplaceConfig, credential.config);
    credential = await this.ensureFreshAccessToken(credential, config);

    assertEbayReady(input, config);
    const baseUrl = EBAY_BASE_URLS[config.environment];
    await this.requestEbay({
      credential,
      config,
      method: "PUT",
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.listingIntent.sku!)}`,
      body: buildInventoryItemPayload(input),
      expectNoContent: true,
      baseUrl,
    });

    let offerId = input.existingExternalOfferId ?? null;
    offerId ??= await this.findExistingOfferId({
        credential,
        config,
        sku: input.listingIntent.sku!,
        baseUrl,
      });
    offerId ??= await this.createOffer({
        credential,
        config,
        input,
        baseUrl,
      });

    if (input.existingExternalOfferId || offerId) {
      await this.requestEbay({
        credential,
        config,
        method: "PUT",
        path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        body: buildOfferPayload(input, config, offerId),
        expectNoContent: true,
        baseUrl,
      });
    }

    if (input.listingIntent.listingMode !== "live") {
      return {
        status: input.existingExternalListingId ? "updated" : "created",
        externalListingId: input.existingExternalListingId ?? offerId,
        externalOfferId: offerId,
        rawResult: {
          provider: "ebay",
          marketplaceId: config.marketplaceId,
          listingMode: input.listingIntent.listingMode,
          published: false,
        },
      };
    }

    const publishResult = await this.requestEbay<{ listingId?: string }>({
      credential,
      config,
      method: "POST",
      path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      baseUrl,
    });
    const listingId = publishResult.listingId ?? input.existingExternalListingId;
    if (!listingId) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_ID_REQUIRED",
        "eBay publish did not return a listing id.",
        { retryable: true },
      );
    }

    return {
      status: input.existingExternalListingId ? "updated" : "created",
      externalListingId: listingId,
      externalOfferId: offerId,
      rawResult: {
        provider: "ebay",
        marketplaceId: config.marketplaceId,
        listingMode: input.listingIntent.listingMode,
        published: true,
      },
    };
  }

  private async findExistingOfferId(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    sku: string;
    baseUrl: string;
  }): Promise<string | null> {
    const result = await this.requestEbay<EbayOfferResponse>({
      credential: input.credential,
      config: input.config,
      method: "GET",
      path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(input.sku)}&marketplace_id=${encodeURIComponent(input.config.marketplaceId)}`,
      baseUrl: input.baseUrl,
    });
    return result.offers?.[0]?.offerId ?? null;
  }

  private async createOffer(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    input: DropshipMarketplaceListingPushRequest;
    baseUrl: string;
  }): Promise<string> {
    const result = await this.requestEbay<{ offerId?: string }>({
      credential: input.credential,
      config: input.config,
      method: "POST",
      path: "/sell/inventory/v1/offer",
      body: buildOfferPayload(input.input, input.config, null),
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
  }

  private async ensureFreshAccessToken(
    credential: DropshipMarketplaceStoreCredentials,
    config: EbayListingConfig,
  ): Promise<DropshipMarketplaceStoreCredentials> {
    if (
      credential.accessTokenExpiresAt
      && credential.accessTokenExpiresAt.getTime() - this.clock.now().getTime() > EBAY_REFRESH_BUFFER_MS
    ) {
      return credential;
    }
    if (!credential.refreshToken) {
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED", "eBay refresh token is required.", {
        storeConnectionId: credential.storeConnectionId,
        retryable: false,
      });
    }
    const clientId = process.env.DROPSHIP_EBAY_CLIENT_ID ?? process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.DROPSHIP_EBAY_CLIENT_SECRET ?? process.env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new DropshipError("DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", "eBay OAuth client credentials are missing.", {
        retryable: false,
      });
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
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        `eBay token refresh failed with HTTP ${response.status}.`,
        {
          retryable: response.status >= 500 || response.status === 429,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    const token = parseEbayJson<EbayTokenResponse>({
      text,
      code: "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
      message: "eBay token refresh returned invalid JSON.",
    });
    if (!token.access_token || typeof token.expires_in !== "number" || token.expires_in <= 0) {
      throw new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_INVALID", "eBay token refresh response was invalid.", {
        retryable: true,
      });
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
    method: "GET" | "POST" | "PUT";
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
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        `eBay listing push failed with HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
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
    categoryId: requiredConfigString(config, "categoryId"),
    merchantLocationKey: requiredConfigString(config, "merchantLocationKey"),
    businessPolicies: {
      paymentPolicyId: requiredConfigString(businessPolicies, "paymentPolicyId"),
      returnPolicyId: requiredConfigString(businessPolicies, "returnPolicyId"),
      fulfillmentPolicyId: requiredConfigString(businessPolicies, "fulfillmentPolicyId"),
    },
    environment: config.environment === "sandbox" ? "sandbox" as const : "production" as const,
  };
  return parsed;
}

function assertEbayReady(input: DropshipMarketplaceListingPushRequest, config: EbayListingConfig): void {
  const intent = input.listingIntent;
  if (!intent.sku?.trim()) {
    throw new DropshipError("DROPSHIP_EBAY_SKU_REQUIRED", "eBay listing push requires a SKU.", { retryable: false });
  }
  if (intent.imageUrls.length === 0) {
    throw new DropshipError("DROPSHIP_EBAY_IMAGE_REQUIRED", "eBay listing push requires at least one product image.", {
      retryable: false,
    });
  }
  if (!config.categoryId || !config.merchantLocationKey) {
    throw new DropshipError("DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED", "eBay listing configuration is incomplete.", {
      retryable: false,
    });
  }
}

function buildInventoryItemPayload(input: DropshipMarketplaceListingPushRequest): Record<string, unknown> {
  const intent = input.listingIntent;
  return {
    product: {
      title: intent.title,
      description: intent.description ?? intent.title,
      aspects: buildEbayAspects(input),
      imageUrls: intent.imageUrls.slice(0, 12),
      ...(intent.brand ? { brand: intent.brand } : {}),
      ...(intent.mpn ? { mpn: intent.mpn } : {}),
      ...(intent.gtin ? { upc: [intent.gtin] } : {}),
    },
    condition: mapEbayCondition(intent.condition),
    availability: {
      shipToLocationAvailability: {
        quantity: intent.quantity,
      },
    },
  };
}

function buildOfferPayload(
  input: DropshipMarketplaceListingPushRequest,
  config: EbayListingConfig,
  offerId: string | null,
): Record<string, unknown> {
  return {
    ...(offerId ? { offerId } : {}),
    sku: input.listingIntent.sku,
    marketplaceId: config.marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: input.listingIntent.quantity,
    categoryId: config.categoryId,
    merchantLocationKey: config.merchantLocationKey,
    listingDescription: input.listingIntent.description ?? input.listingIntent.title,
    listingPolicies: config.businessPolicies,
    pricingSummary: {
      price: {
        value: centsToDecimalString(input.listingIntent.priceCents),
        currency: "USD",
      },
    },
  };
}

function buildEbayAspects(input: DropshipMarketplaceListingPushRequest): Record<string, string[]> {
  const raw = input.listingIntent.itemSpecifics ?? {};
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

function mapEbayCondition(condition: string | null): string {
  const normalized = condition?.trim().toLowerCase();
  if (!normalized || normalized === "new") {
    return "NEW";
  }
  if (normalized === "used") {
    return "USED_GOOD";
  }
  return normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function requiredConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new DropshipError("DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED", "eBay listing configuration is incomplete.", {
      missingKey: key,
      retryable: false,
    });
  }
  return value.trim();
}

function recordFromConfig(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function centsToDecimalString(cents: number): string {
  const normalized = Math.trunc(cents);
  const sign = normalized < 0 ? "-" : "";
  const absolute = Math.abs(normalized);
  const whole = Math.floor(absolute / 100);
  const fractional = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fractional}`;
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
