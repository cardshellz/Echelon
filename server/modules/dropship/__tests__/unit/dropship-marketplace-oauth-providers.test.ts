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
      .createAuthorizationUrl({ state: "state", shopDomain: null, intent: "connect" });
    const url = new URL(start.authorizationUrl);

    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.searchParams.get("client_id")).toBe("dropship-ebay-client");
    expect(url.searchParams.get("redirect_uri")).toBe("Cardshellz_Cardshellz-dropship-oauth");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("scope")).toContain("https://api.ebay.com/oauth/api_scope/sell.stores");
    expect(url.searchParams.toString()).not.toContain("dropship-ebay-secret");
  });

  it("forces eBay login when changing stores but keeps refresh on the current session", () => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPSHIP_EBAY_CLIENT_ID: "dropship-ebay-client",
      DROPSHIP_EBAY_CLIENT_SECRET: "dropship-ebay-secret",
      EBAY_VENDOR_RUNAME: "Cardshellz_Cardshellz-dropship-oauth",
      EBAY_ENVIRONMENT: "sandbox",
    };
    const provider = EbayDropshipOAuthProvider.fromEnv();

    const changeStoreUrl = new URL(provider.createAuthorizationUrl({
      state: "state",
      shopDomain: null,
      intent: "change_store",
    }).authorizationUrl);
    const refreshUrl = new URL(provider.createAuthorizationUrl({
      state: "state",
      shopDomain: null,
      intent: "refresh_connection",
    }).authorizationUrl);

    expect(changeStoreUrl.searchParams.get("prompt")).toBe("login");
    expect(refreshUrl.searchParams.has("prompt")).toBe(false);
  });

  it("uses the eBay Store name as the connected store display name when available", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "ebay-access-token",
        refresh_token: "ebay-refresh-token",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: "seller-account-123",
        username: "seller-login",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "marzcards",
        url: "https://www.ebay.com/str/marzcards",
        urlPath: "marzcards",
      }), { status: 200 }));
    const provider = new EbayDropshipOAuthProvider({
      clientId: "ebay-key",
      clientSecret: "ebay-secret",
      ruName: "Cardshellz_Cardshellz-dropship-oauth",
      environment: "sandbox",
    });

    const result = await provider.exchangeCode({
      code: "auth-code",
      shopDomain: null,
      query: {
        code: "auth-code",
        state: "signed-state",
      },
    });

    expect(result).toMatchObject({
      accessToken: "ebay-access-token",
      refreshToken: "ebay-refresh-token",
      externalAccountId: "seller-account-123",
      externalDisplayName: "marzcards",
      tokenMetadata: {
        environment: "sandbox",
        identityAccountId: "seller-account-123",
        identityDisplayName: "seller-login",
        provider: "ebay",
        storeName: "marzcards",
        storeUrl: "https://www.ebay.com/str/marzcards",
        storeUrlPath: "marzcards",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sandbox.ebay.com/sell/stores/v1/store",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ebay-access-token",
        }),
      }),
    );
  });

  it("falls back to the eBay identity display name when no Store profile is available", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "ebay-access-token",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: "seller-account-123",
        username: "seller-login",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ errorId: 225002, message: "Store not found." }],
      }), { status: 404 }));
    const provider = new EbayDropshipOAuthProvider({
      clientId: "ebay-key",
      clientSecret: "ebay-secret",
      ruName: "Cardshellz_Cardshellz-dropship-oauth",
      environment: "sandbox",
    });

    const result = await provider.exchangeCode({
      code: "auth-code",
      shopDomain: null,
      query: {
        code: "auth-code",
        state: "signed-state",
      },
    });

    expect(result).toMatchObject({
      externalAccountId: "seller-account-123",
      externalDisplayName: "seller-login",
      tokenMetadata: {
        provider: "ebay",
        storeName: null,
        storeUrl: null,
        storeUrlPath: null,
      },
    });
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
      .createAuthorizationUrl({ state: "state", shopDomain: "vendor.myshopify.com", intent: "connect" });
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
