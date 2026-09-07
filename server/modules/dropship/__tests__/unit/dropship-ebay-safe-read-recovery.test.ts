import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { EbayDropshipListingSetupDirectory } from "../../infrastructure/dropship-ebay-listing-setup.directory";
import { EbayDropshipStoreCategoryDirectory } from "../../infrastructure/dropship-ebay-store-category.directory";
import { PgDropshipEbayManagedLocationProvider } from "../../infrastructure/dropship-ebay-managed-location.provider";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import { ebayResourceErrorIdentifiers } from "../../infrastructure/dropship-ebay-safe-read-recovery";

const identity = { vendorId: 10, storeConnectionId: 44 };

describe("eBay safe-read authorization recovery", () => {
  it.each([401, 403])("repairs a cached %s token once for a complete listing discovery pass", async (status) => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get("Authorization") === "Bearer old-access") {
        return response({ errors: [{ errorId: 1100, message: "private provider message" }] }, status);
      }
      return emptySetupResponse(String(url));
    });
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn as typeof fetch);
    await expect(directory.discoverForStoreConnection({ ...identity, marketplaceId: "EBAY_US" }))
      .resolves.toMatchObject({ marketplaceId: "EBAY_US", merchantLocations: [] });
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledTimes(2);
    expect(credentials.loadFreshForStoreConnection).toHaveBeenLastCalledWith({
      ...identity, operation: "listing_setup_discovery", rejectedAccessTokenRef: "old-access-ref",
    });
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it("stops after one failed repair and returns only bounded provider identifiers", async () => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn(async () => response({ errors: [
      { errorId: 1100, message: "secret-token", parameters: [{ value: "secret-token" }] },
      { errorId: "secret-token" },
    ], token: "secret-token" }, 403));
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn as typeof fetch);
    const failure = await directory.discoverForStoreConnection({ ...identity, marketplaceId: "EBAY_US" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED",
      context: { status: 403, providerErrorIds: ["1100"], retryable: false },
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it("requests consent only if the owner confirms the current refresh grant is invalid", async () => {
    const credentials = repairingCredentials();
    credentials.loadFreshForStoreConnection.mockReset()
      .mockResolvedValueOnce(credential("old"))
      .mockRejectedValueOnce(new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "Refresh failed", {
        authFailureStatus: "needs_reauth", providerErrorCode: "invalid_grant",
      }));
    const directory = new EbayDropshipListingSetupDirectory(credentials,
      vi.fn(async () => response({}, 403)) as typeof fetch);
    await expect(directory.discoverForStoreConnection({ ...identity, marketplaceId: "EBAY_US" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED" });
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledTimes(2);
  });

  it("preserves a temporary refresh outage without asking for consent", async () => {
    const temporary = new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "Temporary provider outage", {
      retryable: true, authFailureStatus: "refresh_failed",
    });
    const credentials = repairingCredentials();
    credentials.loadFreshForStoreConnection.mockReset()
      .mockResolvedValueOnce(credential("old")).mockRejectedValueOnce(temporary);
    const directory = new EbayDropshipStoreCategoryDirectory(credentials,
      vi.fn(async () => response({}, 401)) as typeof fetch);
    await expect(directory.listLeafCategories(identity)).rejects.toBe(temporary);
  });

  it("retries a selected fulfillment-policy GET once", async () => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn().mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({ fulfillmentPolicyId: "ground", shippingOptions: [] }));
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn);
    await expect(directory.getFulfillmentPolicyForStoreConnection({ ...identity, fulfillmentPolicyId: "ground" }))
      .resolves.toMatchObject({ id: "ground" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recovers the optional Stores read without starting customer authorization", async () => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn().mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({ storeCategories: [{ categoryId: "3", categoryName: "Supplies" }] }));
    const directory = new EbayDropshipStoreCategoryDirectory(credentials, fetchFn);
    await expect(directory.listLeafCategories(identity)).resolves.toMatchObject([{ categoryId: "3" }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(credentials.loadFreshForStoreConnection).toHaveBeenLastCalledWith({
      ...identity, operation: "store_categories_read", rejectedAccessTokenRef: "old-access-ref",
    });
  });

  it("repairs only the initial managed-location GET and uses the repaired token for subsequent writes", async () => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn().mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = managedProvider(credentials, fetchFn);
    await expect(provider.ensureForStoreConnection({ ...identity, originWarehouseId: 1 }))
      .resolves.toMatchObject({ action: "created" });
    expect(fetchFn.mock.calls.map((call) => call[1].method)).toEqual(["GET", "GET", "POST"]);
    expect(new Headers(fetchFn.mock.calls[2][1].headers).get("Authorization")).toBe("Bearer new-access");
  });

  it("does not refresh or replay a denied provisioning POST", async () => {
    const credentials = repairingCredentials();
    const fetchFn = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({}, 403));
    await expect(managedProvider(credentials, fetchFn).ensureForStoreConnection({ ...identity, originWarehouseId: 1 }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", context: { operation: "create" } });
    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls.map((call) => call[1].method)).toEqual(["GET", "POST"]);
  });

  it("bounds and validates provider IDs without echoing unknown values", () => {
    expect(ebayResourceErrorIdentifiers("not json")).toEqual({ providerErrorIds: [] });
    expect(ebayResourceErrorIdentifiers(" ".repeat(100_001))).toEqual({ providerErrorIds: [] });
    expect(ebayResourceErrorIdentifiers(JSON.stringify({ errors: Array.from({ length: 30 }, (_, i) => ({ errorId: i })) })))
      .toEqual({ providerErrorIds: Array.from({ length: 10 }, (_, i) => String(i)) });
    expect(ebayResourceErrorIdentifiers(JSON.stringify({ errors: [{ errorId: -1 }, { errorId: 1.5 }, { errorId: "1234567890123" }] })))
      .toEqual({ providerErrorIds: [] });
  });
});

function credential(prefix: string): DropshipMarketplaceStoreCredentials {
  return {
    ...identity, platform: "ebay", status: "connected", shopDomain: null,
    externalAccountId: "seller", providerEnvironment: "production",
    externalAccountIdentityScheme: "ebay_user_id", externalAccountVerifiedAt: null,
    externalDisplayName: "Store", config: {}, accessToken: `${prefix}-access`, accessTokenRef: `${prefix}-access-ref`,
    accessTokenExpiresAt: new Date("2026-09-07T12:00:00Z"), refreshToken: "refresh", refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
  };
}

function repairingCredentials() {
  return { loadFreshForStoreConnection: vi.fn().mockResolvedValueOnce(credential("old")).mockResolvedValue(credential("new")) };
}

function managedProvider(credentials: ReturnType<typeof repairingCredentials>, fetchFn: typeof fetch) {
  return new PgDropshipEbayManagedLocationProvider({
    credentials, fetchFn,
    dbPool: { connect: async () => ({
      query: async () => ({ rows: [{ id: 1, code: "HQ", name: "HQ", city: "Cranberry Township", state: "PA",
        postal_code: "16066", country: "US", is_active: 1 }] }),
      release: () => undefined,
    }) } as unknown as Pool,
  });
}

function emptySetupResponse(url: string): Response {
  if (url.includes("/location")) return response({ locations: [] });
  if (url.includes("fulfillment_policy")) return response({ fulfillmentPolicies: [] });
  if (url.includes("return_policy")) return response({ returnPolicies: [] });
  return response({ paymentPolicies: [] });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
