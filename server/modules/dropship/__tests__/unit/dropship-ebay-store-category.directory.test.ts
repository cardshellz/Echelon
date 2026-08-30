import { describe, expect, it, vi } from "vitest";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import type { DropshipEbayRegistrationCredentialProvider } from "../../infrastructure/dropship-ebay-registration-credentials";
import {
  EbayDropshipStoreCategoryDirectory,
  parseEbayStoreCategories,
} from "../../infrastructure/dropship-ebay-store-category.directory";

describe("eBay Store category directory", () => {
  it("returns only leaf categories with the full eBay Store path", () => {
    const categories = parseEbayStoreCategories(JSON.stringify({
      storeCategories: [
        {
          categoryId: "20",
          categoryName: "Supplies",
          level: 1,
          childrenCategories: [
            {
              categoryId: "22",
              categoryName: "Toploaders",
              level: 2,
              childrenCategories: [],
            },
            {
              categoryId: "21",
              categoryName: "Envelopes",
              level: 2,
            },
          ],
        },
        {
          categoryId: "30",
          categoryName: "Clearance",
          level: 1,
        },
      ],
    }), 44);

    expect(categories).toEqual([
      {
        categoryId: "30",
        categoryName: "Clearance",
        path: "Clearance",
        level: 1,
      },
      {
        categoryId: "21",
        categoryName: "Envelopes",
        path: "Supplies:Envelopes",
        level: 2,
      },
      {
        categoryId: "22",
        categoryName: "Toploaders",
        path: "Supplies:Toploaders",
        level: 2,
      },
    ]);
  });

  it("rejects malformed and duplicate provider category data", () => {
    expect(() => parseEbayStoreCategories("not-json", 44)).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE" }),
    );
    expect(() => parseEbayStoreCategories(JSON.stringify({
      storeCategories: [
        { categoryId: "20", categoryName: "First" },
        { categoryId: "20", categoryName: "Second" },
      ],
    }), 44)).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE" }),
    );
  });

  it("loads the connected seller hierarchy from the exact Stores API endpoint", async () => {
    const credentials = {
      loadFreshForStoreConnection: vi.fn(async () => credential()),
    } as DropshipEbayRegistrationCredentialProvider;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      storeCategories: [{ categoryId: "30", categoryName: "Clearance" }],
    }), { status: 200 }));
    const directory = new EbayDropshipStoreCategoryDirectory(
      credentials,
      fetchFn as unknown as typeof fetch,
    );

    await expect(directory.listLeafCategories({ vendorId: 10, storeConnectionId: 44 }))
      .resolves.toMatchObject([{ categoryId: "30", path: "Clearance" }]);
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 10,
      storeConnectionId: 44,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.ebay.com/sell/stores/v1/store/categories",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("classifies missing Stores API permission as a reconnect requirement", async () => {
    const directory = new EbayDropshipStoreCategoryDirectory(
      {
        loadFreshForStoreConnection: vi.fn(async () => credential()),
      },
      vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
    );

    await expect(directory.listLeafCategories({ vendorId: 10, storeConnectionId: 44 }))
      .rejects.toMatchObject({
        code: "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
        context: expect.objectContaining({ status: 403, retryable: false }),
      });
  });
});

function credential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 44,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    providerEnvironment: "production",
    externalAccountIdentityScheme: "ebay_user_id",
    externalAccountVerifiedAt: new Date("2026-08-29T12:00:00.000Z"),
    externalDisplayName: "marz_cards",
    config: {},
    accessToken: "access-token",
    accessTokenRef: "vault://access",
    accessTokenExpiresAt: new Date("2026-08-29T14:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "vault://refresh",
    refreshTokenExpiresAt: null,
  };
}
