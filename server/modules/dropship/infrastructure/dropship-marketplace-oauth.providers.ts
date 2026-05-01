import { createHmac, timingSafeEqual } from "crypto";
import { DropshipError } from "../domain/errors";
import { normalizeShopifyShopDomain, type DropshipSupportedStorePlatform } from "../domain/store-connection";
import type {
  CompleteOAuthQuery,
  DropshipMarketplaceOAuthProvider,
  DropshipStoreConnectionOAuthStart,
  DropshipStoreConnectionTokenGrant,
} from "../application/dropship-store-connection-service";

const EBAY_TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;

const EBAY_CONSENT_URLS = {
  sandbox: "https://auth.sandbox.ebay.com/oauth2/authorize",
  production: "https://auth.ebay.com/oauth2/authorize",
} as const;

const EBAY_IDENTITY_URLS = {
  sandbox: "https://api.sandbox.ebay.com/commerce/identity/v1/user/",
  production: "https://api.ebay.com/commerce/identity/v1/user/",
} as const;

const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
] as const;

const SHOPIFY_SCOPES = [
  "read_orders",
  "write_products",
  "write_inventory",
  "read_locations",
  "write_fulfillments",
] as const;

export class EbayDropshipOAuthProvider implements DropshipMarketplaceOAuthProvider {
  readonly platform: DropshipSupportedStorePlatform = "ebay";

  constructor(private readonly config: {
    clientId: string;
    clientSecret: string;
    ruName: string;
    environment: "sandbox" | "production";
  }) {}

  static fromEnv(): EbayDropshipOAuthProvider {
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    const ruName = process.env.EBAY_VENDOR_RUNAME || process.env.EBAY_RUNAME;
    if (!clientId || !clientSecret || !ruName) {
      throw new DropshipError("DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", "eBay OAuth environment variables are missing.");
    }

    return new EbayDropshipOAuthProvider({
      clientId,
      clientSecret,
      ruName,
      environment: process.env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    });
  }

  createAuthorizationUrl(input: { state: string; shopDomain: string | null }): DropshipStoreConnectionOAuthStart {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.config.ruName,
      scope: EBAY_SCOPES.join(" "),
      state: input.state,
    });

    return {
      authorizationUrl: `${EBAY_CONSENT_URLS[this.config.environment]}?${params.toString()}`,
      platform: "ebay",
      shopDomain: null,
      expiresAt: stateExpiresAt(input.state),
      scopes: [...EBAY_SCOPES],
      environment: this.config.environment,
    };
  }

  async exchangeCode(input: {
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }): Promise<DropshipStoreConnectionTokenGrant> {
    const response = await fetch(EBAY_TOKEN_URLS[this.config.environment], {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: this.config.ruName,
      }).toString(),
    });

    const tokenData = await parseProviderJson(response, "DROPSHIP_EBAY_TOKEN_EXCHANGE_FAILED");
    const accessToken = requiredString(tokenData.access_token, "DROPSHIP_EBAY_TOKEN_EXCHANGE_FAILED", "access_token");
    const refreshToken = optionalString(tokenData.refresh_token);
    const accessTokenExpiresAt = typeof tokenData.expires_in === "number"
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;
    const identity = await this.fetchIdentity(accessToken);

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      externalAccountId: identity.accountId,
      externalDisplayName: identity.displayName,
      tokenMetadata: {
        environment: this.config.environment,
        provider: "ebay",
      },
    };
  }

  private async fetchIdentity(accessToken: string): Promise<{ accountId: string | null; displayName: string | null }> {
    const response = await fetch(EBAY_IDENTITY_URLS[this.config.environment], {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      return { accountId: null, displayName: null };
    }

    const identity = await response.json() as Record<string, unknown>;
    const username = optionalString(identity.username);
    const userId = optionalString(identity.userId);
    return {
      accountId: userId ?? username,
      displayName: username ?? userId,
    };
  }
}

export class ShopifyDropshipOAuthProvider implements DropshipMarketplaceOAuthProvider {
  readonly platform: DropshipSupportedStorePlatform = "shopify";

  constructor(private readonly config: {
    apiKey: string;
    apiSecret: string;
    redirectUri: string;
  }) {}

  static fromEnv(): ShopifyDropshipOAuthProvider {
    const apiKey = process.env.SHOPIFY_API_KEY;
    const apiSecret = process.env.SHOPIFY_API_SECRET;
    const redirectUri = process.env.DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI || process.env.SHOPIFY_OAUTH_REDIRECT_URI;
    if (!apiKey || !apiSecret || !redirectUri) {
      throw new DropshipError("DROPSHIP_SHOPIFY_OAUTH_NOT_CONFIGURED", "Shopify OAuth environment variables are missing.");
    }

    return new ShopifyDropshipOAuthProvider({ apiKey, apiSecret, redirectUri });
  }

  createAuthorizationUrl(input: { state: string; shopDomain: string | null }): DropshipStoreConnectionOAuthStart {
    if (!input.shopDomain) {
      throw new DropshipError("DROPSHIP_SHOP_DOMAIN_REQUIRED", "Shopify shop domain is required.");
    }

    const params = new URLSearchParams({
      client_id: this.config.apiKey,
      scope: SHOPIFY_SCOPES.join(","),
      redirect_uri: this.config.redirectUri,
      state: input.state,
    });

    return {
      authorizationUrl: `https://${input.shopDomain}/admin/oauth/authorize?${params.toString()}`,
      platform: "shopify",
      shopDomain: input.shopDomain,
      expiresAt: stateExpiresAt(input.state),
      scopes: [...SHOPIFY_SCOPES],
      environment: "production",
    };
  }

  async exchangeCode(input: {
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }): Promise<DropshipStoreConnectionTokenGrant> {
    const shopDomain = normalizeShopifyShopDomain(input.query.shop || input.shopDomain || "");
    if (input.shopDomain && shopDomain !== input.shopDomain) {
      throw new DropshipError("DROPSHIP_STORE_OAUTH_STATE_MISMATCH", "Shopify shop does not match authorization state.", {
        stateShopDomain: input.shopDomain,
        callbackShopDomain: shopDomain,
      });
    }
    if (input.query.hmac) {
      verifyShopifyHmac(input.query, this.config.apiSecret);
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.config.apiKey,
        client_secret: this.config.apiSecret,
        code: input.code,
      }),
    });

    const tokenData = await parseProviderJson(response, "DROPSHIP_SHOPIFY_TOKEN_EXCHANGE_FAILED");
    const accessToken = requiredString(tokenData.access_token, "DROPSHIP_SHOPIFY_TOKEN_EXCHANGE_FAILED", "access_token");

    return {
      accessToken,
      refreshToken: null,
      accessTokenExpiresAt: null,
      externalAccountId: shopDomain,
      externalDisplayName: shopDomain,
      tokenMetadata: {
        provider: "shopify",
        scope: optionalString(tokenData.scope),
      },
    };
  }
}

async function parseProviderJson(response: Response, errorCode: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new DropshipError(errorCode, "Store OAuth token exchange failed.", {
      status: response.status,
      body: text.slice(0, 500),
    });
  }

  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function requiredString(value: unknown, errorCode: string, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new DropshipError(errorCode, "Store OAuth provider response was missing a required token field.", { field });
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function verifyShopifyHmac(query: CompleteOAuthQuery, apiSecret: string): void {
  const hmac = query.hmac;
  if (!hmac) return;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "hmac" || key === "signature" || value === undefined) continue;
    params.append(key, String(value));
  }
  const message = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", apiSecret).update(message).digest("hex");
  if (!safeEqual(hmac, expected)) {
    throw new DropshipError("DROPSHIP_SHOPIFY_HMAC_INVALID", "Shopify OAuth callback signature is invalid.");
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stateExpiresAt(state: string): Date {
  const encodedPayload = state.split(".")[0];
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { expiresAt?: string };
    return payload.expiresAt ? new Date(payload.expiresAt) : new Date();
  } catch {
    return new Date();
  }
}
