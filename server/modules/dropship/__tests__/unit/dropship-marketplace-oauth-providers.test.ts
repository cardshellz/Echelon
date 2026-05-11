import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  EbayDropshipOAuthProvider,
  ShopifyDropshipOAuthProvider,
} from "../../infrastructure/dropship-marketplace-oauth.providers";

const ORIGINAL_ENV = { ...process.env };

describe("EbayDropshipOAuthProvider", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("uses dropship-specific OAuth client aliases when building eBay consent URLs", () => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPSHIP_EBAY_CLIENT_ID: "dropship-ebay-client",
      DROPSHIP_EBAY_CLIENT_SECRET: "dropship-ebay-secret",
      EBAY_CLIENT_ID: undefined,
      EBAY_CLIENT_SECRET: undefined,
      EBAY_VENDOR_RUNAME: "Cardshellz_Cardshellz-dropship-oauth",
      EBAY_ENVIRONMENT: "sandbox",
    };

    const start = EbayDropshipOAuthProvider
      .fromEnv()
      .createAuthorizationUrl({ state: "state", shopDomain: null });
    const url = new URL(start.authorizationUrl);

    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.searchParams.get("client_id")).toBe("dropship-ebay-client");
    expect(url.searchParams.get("redirect_uri")).toBe("Cardshellz_Cardshellz-dropship-oauth");
    expect(url.searchParams.toString()).not.toContain("dropship-ebay-secret");
  });

  it("requires either dropship-specific or shared eBay OAuth client credentials", () => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPSHIP_EBAY_CLIENT_ID: undefined,
      DROPSHIP_EBAY_CLIENT_SECRET: undefined,
      EBAY_CLIENT_ID: undefined,
      EBAY_CLIENT_SECRET: undefined,
      EBAY_VENDOR_RUNAME: "Cardshellz_Cardshellz-dropship-oauth",
    };

    expect(() => EbayDropshipOAuthProvider.fromEnv()).toThrowError(DropshipError);
    expect(() => EbayDropshipOAuthProvider.fromEnv()).toThrowError("eBay OAuth environment variables are missing.");
  });
});

describe("ShopifyDropshipOAuthProvider", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("uses dropship-specific OAuth client aliases when building Shopify consent URLs", () => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPSHIP_SHOPIFY_API_KEY: "dropship-shopify-key",
      DROPSHIP_SHOPIFY_API_SECRET: "dropship-shopify-secret",
      SHOPIFY_API_KEY: undefined,
      SHOPIFY_API_SECRET: undefined,
      DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    };

    const start = ShopifyDropshipOAuthProvider
      .fromEnv()
      .createAuthorizationUrl({ state: "state", shopDomain: "vendor.myshopify.com" });
    const url = new URL(start.authorizationUrl);

    expect(url.origin).toBe("https://vendor.myshopify.com");
    expect(url.searchParams.get("client_id")).toBe("dropship-shopify-key");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    );
    expect(url.searchParams.toString()).not.toContain("dropship-shopify-secret");
  });

  it("requires either dropship-specific or shared Shopify OAuth client credentials", () => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPSHIP_SHOPIFY_API_KEY: undefined,
      DROPSHIP_SHOPIFY_API_SECRET: undefined,
      SHOPIFY_API_KEY: undefined,
      SHOPIFY_API_SECRET: undefined,
      DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    };

    expect(() => ShopifyDropshipOAuthProvider.fromEnv()).toThrowError(DropshipError);
    expect(() => ShopifyDropshipOAuthProvider.fromEnv()).toThrowError("Shopify OAuth environment variables are missing.");
  });

  it("rejects Shopify OAuth callbacks without an HMAC before exchanging tokens", async () => {
    const provider = new ShopifyDropshipOAuthProvider({
      apiKey: "shopify-key",
      apiSecret: "shopify-secret",
      redirectUri: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    });

    await expect(provider.exchangeCode({
      code: "auth-code",
      shopDomain: "vendor.myshopify.com",
      query: {
        code: "auth-code",
        shop: "vendor.myshopify.com",
        state: "signed-state",
      },
    })).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_HMAC_REQUIRED",
    });
  });

  it("rejects Shopify OAuth callbacks with an invalid HMAC before exchanging tokens", async () => {
    const provider = new ShopifyDropshipOAuthProvider({
      apiKey: "shopify-key",
      apiSecret: "shopify-secret",
      redirectUri: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    });

    await expect(provider.exchangeCode({
      code: "auth-code",
      shopDomain: "vendor.myshopify.com",
      query: {
        code: "auth-code",
        hmac: "bad-signature",
        shop: "vendor.myshopify.com",
        state: "signed-state",
      },
    })).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_HMAC_INVALID",
    });
  });

  it("accepts Shopify OAuth callbacks signed over the complete provider query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "shopify-access-token",
        scope: "read_orders,write_orders",
      }), { status: 200 }),
    );
    const provider = new ShopifyDropshipOAuthProvider({
      apiKey: "shopify-key",
      apiSecret: "shopify-secret",
      redirectUri: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
    });
    const signedQuery = {
      code: "auth-code",
      host: "admin.shopify.com/store/vendor",
      shop: "vendor.myshopify.com",
      state: "signed-state",
      timestamp: "1777982400",
    };
    const hmac = signShopifyOAuthQuery(signedQuery, "shopify-secret");

    const result = await provider.exchangeCode({
      code: "auth-code",
      shopDomain: "vendor.myshopify.com",
      query: {
        ...signedQuery,
        hmac,
      },
    });

    expect(result).toMatchObject({
      accessToken: "shopify-access-token",
      refreshToken: null,
      externalAccountId: "vendor.myshopify.com",
      externalDisplayName: "vendor.myshopify.com",
      tokenMetadata: {
        provider: "shopify",
        scope: "read_orders,write_orders",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://vendor.myshopify.com/admin/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

function signShopifyOAuthQuery(query: Record<string, string>, apiSecret: string): string {
  const message = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHmac("sha256", apiSecret).update(message).digest("hex");
}
