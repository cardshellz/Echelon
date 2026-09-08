import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedEbayQuantityTestOwner } from "../../../channels/__tests__/fixtures/quantity-publication-admission";
import { EbayDropshipOrderIntakeProvider } from "../../infrastructure/dropship-ebay-order-intake.provider";
import { EbayDropshipReturnIntakeProvider } from "../../infrastructure/dropship-ebay-return-intake.provider";
import { EbayDropshipMarketplaceTrackingProvider } from "../../infrastructure/dropship-ebay-tracking.provider";
import { EbayDropshipOrderCancellationProvider } from "../../infrastructure/dropship-ebay-order-cancellation.provider";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import { RefreshingDropshipEbayRegistrationCredentialProvider } from "../../infrastructure/dropship-ebay-registration-credentials";
import { EbayDropshipListingSetupDirectory } from "../../infrastructure/dropship-ebay-listing-setup.directory";
import { EbayDropshipStoreCategoryDirectory } from "../../infrastructure/dropship-ebay-store-category.directory";
import type { DropshipMarketplaceListingPushRequest } from "../../application/dropship-marketplace-listing-push-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const clock = { now: () => new Date(NOW) };
const identity = { vendorId: 10, storeConnectionId: 22 };
const policyConfig = {
  marketplaceId: "EBAY_US",
  merchantLocationKey: "cardshellz-dropship-wh-1",
  // A job/config cannot change the environment bound to the seller grant.
  environment: "sandbox",
  businessPolicies: {
    fulfillmentPolicyId: "fulfillment-policy", returnPolicyId: "return-policy", paymentPolicyId: "payment-policy",
  },
};
const consumerNames = ["order intake", "return intake", "tracking", "cancellation", "listing push", "listing replacement"] as const;
type ConsumerName = typeof consumerNames[number];

describe("eBay provider consumers share a scope-preserving token owner", () => {
  beforeEach(() => {
    vi.stubEnv("DROPSHIP_EBAY_CLIENT_ID", "client");
    vi.stubEnv("DROPSHIP_EBAY_CLIENT_SECRET", "secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(consumerNames)("%s refreshes without narrowing scope and uses the persisted environment", async (name) => {
    const repo = new CoordinatedCredentialRepository();
    const fetchFn = makeFetch(repo);
    await runConsumer(name, repo, fetchFn);

    const refreshCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes("/identity/"));
    expect(refreshCalls).toHaveLength(1);
    expect(String(refreshCalls[0][0])).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    const body = new URLSearchParams(String(refreshCalls[0][1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("seller-refresh-grant");
    expect(body.has("scope")).toBe(false);
    expect(repo.lockCalls).toBe(1);
    expect(repo.replacements).toBe(1);
    expect(repo.current.refreshToken).toBe("seller-refresh-grant");
    expect(repo.current.refreshTokenRef).toBe("refresh-ref");
  });

  it("serializes different workers over repeated expirations without reauthorization or lost permissions", async () => {
    const repo = new CoordinatedCredentialRepository();
    const fetchFn = makeFetch(repo);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      repo.current = { ...repo.current, accessTokenExpiresAt: new Date(NOW.getTime() - 1) };
      await Promise.all(consumerNames.map((name) => runConsumer(name, repo, fetchFn)));
    }
    expect(repo.replacements).toBe(3);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("/identity/"))).toHaveLength(3);
    expect(repo.current.refreshToken).toBe("seller-refresh-grant");
    expect(repo.authFailureCount).toBe(0);
  });

  it("keeps Inventory, Account, and Stores access after the order worker refreshes the shared token", async () => {
    const repo = new CoordinatedCredentialRepository();
    const ebay = permissionAwareEbay();
    const directories = catalogDirectories(repo, ebay.fetchFn);

    await runConsumer("order intake", repo, ebay.fetchFn);
    const workerToken = repo.current.accessToken;
    await expectCatalogAccess(directories);

    expect(repo.current.accessToken).toBe(workerToken);
    expect(repo.replacements).toBe(1);
    expect(ebay.refreshCount()).toBe(1);
    expect(ebay.deniedReads()).toBe(0);
    expect(repo.authFailureCount).toBe(0);
    expect(repo.current.status).toBe("connected");
    expect(repo.current.refreshToken).toBe("seller-refresh-grant");
    expect(ebay.successfulProtectedTokens()).toEqual([workerToken, workerToken, workerToken, workerToken, workerToken]);
  });

  it("repairs one legacy narrowed token when setup and Store categories read concurrently without reauthorization", async () => {
    const repo = new CoordinatedCredentialRepository();
    repo.current = {
      ...repo.current, accessToken: "legacy-order-only-token", accessTokenRef: "legacy-order-only-ref",
      accessTokenExpiresAt: new Date(NOW.getTime() + 7_200_000),
    };
    const ebay = permissionAwareEbay();
    const directories = catalogDirectories(repo, ebay.fetchFn);

    await expectCatalogAccess(directories);
    expect(ebay.deniedReads()).toBe(5);
    expect(ebay.refreshCount()).toBe(1);
    expect(repo.replacements).toBe(1);
    expect(repo.authFailureCount).toBe(0);
    expect(repo.current.status).toBe("connected");
    expect(repo.current.refreshToken).toBe("seller-refresh-grant");

    // Later visits reuse the repaired token; they do not loop through denial/refresh.
    await expectCatalogAccess(directories);
    expect(ebay.deniedReads()).toBe(5);
    expect(ebay.refreshCount()).toBe(1);
    expect(ebay.successfulProtectedTokens()).toHaveLength(10);
    expect(new Set(ebay.successfulProtectedTokens())).toEqual(new Set([repo.current.accessToken]));
  });

  it.each(consumerNames)("%s fails closed when the grant's environment is missing", async (name) => {
    const repo = new CoordinatedCredentialRepository();
    repo.current = { ...repo.current, providerEnvironment: null };
    const fetchFn = makeFetch(repo);
    await expect(runConsumer(name, repo, fetchFn)).rejects.toMatchObject({
      code: "DROPSHIP_MARKETPLACE_REGISTRATION_ENVIRONMENT_REQUIRED",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(repo.replacements).toBe(0);
  });

  it.each(["tracking", "cancellation", "listing push"] as const)("%s does not automatically replay a rejected marketplace write", async (name) => {
    const repo = new CoordinatedCredentialRepository();
    repo.current = { ...repo.current, accessTokenExpiresAt: new Date(NOW.getTime() + 7_200_000) };
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ errors: [{ errorId: 1001 }] }, 401));
    await expect(runConsumer(name, repo, fetchFn)).rejects.toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(repo.replacements).toBe(0);
    expect(repo.authFailureCount).toBe(1);
  });
});

class CoordinatedCredentialRepository implements DropshipMarketplaceCredentialRepository {
  current: DropshipMarketplaceStoreCredentials = {
    ...identity, platform: "ebay", status: "connected", shopDomain: null,
    externalAccountId: "seller", externalDisplayName: "Seller",
    providerEnvironment: "production", externalAccountIdentityScheme: "ebay_user_id",
    externalAccountVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    config: { ...policyConfig, cancellation: { cancelReason: "BuyerCancelOrder", buyerPaid: false } },
    accessToken: "expired-token", accessTokenRef: "expired-ref",
    accessTokenExpiresAt: new Date(NOW.getTime() - 1),
    refreshToken: "seller-refresh-grant", refreshTokenRef: "refresh-ref", refreshTokenExpiresAt: null,
  };
  replacements = 0;
  lockCalls = 0;
  authFailureCount = 0;
  private lockTail: Promise<void> = Promise.resolve();

  async loadForStoreConnection(input: Parameters<DropshipMarketplaceCredentialRepository["loadForStoreConnection"]>[0]) {
    expect(input).toEqual({ ...identity, platform: "ebay" });
    return this.current;
  }

  async withEbayTokenRefreshLock<T>(
    input: { vendorId: number; storeConnectionId: number },
    operation: (scopedRepository: DropshipMarketplaceCredentialRepository) => Promise<T>,
  ): Promise<T> {
    expect(input).toEqual(identity);
    this.lockCalls += 1;
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(this); } finally { release(); }
  }

  async replaceTokens(input: Parameters<DropshipMarketplaceCredentialRepository["replaceTokens"]>[0]) {
    expect(input.expectedCredential).toEqual({
      accessTokenRef: this.current.accessTokenRef, refreshTokenRef: this.current.refreshTokenRef,
    });
    this.replacements += 1;
    this.current = {
      ...this.current, accessToken: input.accessToken, accessTokenRef: `fresh-ref-${this.replacements}`,
      refreshToken: input.refreshToken ?? this.current.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    };
    return this.current;
  }

  async recordAuthFailure(input: Parameters<NonNullable<DropshipMarketplaceCredentialRepository["recordAuthFailure"]>>[0]) {
    this.authFailureCount += 1;
    expect(input.expectedCredential).toEqual({
      accessTokenRef: this.current.accessTokenRef, refreshTokenRef: this.current.refreshTokenRef,
    });
    return { ...identity, platform: "ebay" as const, previousStatus: "connected", status: input.status, transitioned: true };
  }
}

function makeFetch(repo: CoordinatedCredentialRepository) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("https://api.ebay.com");
    if (parsed.pathname === "/identity/v1/oauth2/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.has("scope")).toBe(false);
      return jsonResponse({ access_token: `full-grant-token-${repo.replacements + 1}`, expires_in: 7200 });
    }
    const expectedAuthorization = parsed.pathname.startsWith("/post-order/") ? "IAF " : "Bearer ";
    expect(new Headers(init?.headers).get("Authorization")).toBe(expectedAuthorization + repo.current.accessToken);
    if (parsed.pathname === "/sell/fulfillment/v1/order") return jsonResponse({ orders: [], total: 0 });
    if (parsed.pathname === "/post-order/v2/return/search") return jsonResponse({ returns: [], total: 0 });
    if (parsed.pathname.endsWith("/shipping_fulfillment")) {
      return new Response(null, { status: 201, headers: { Location: "https://api.ebay.com/fulfillment/fulfillment-1" } });
    }
    if (parsed.pathname === "/post-order/v2/cancellation") return jsonResponse({ cancelId: "cancel-1" });
    if (parsed.pathname === "/sell/inventory/v1/offer" && init?.method === "GET") return jsonResponse({ offers: [] });
    if (parsed.pathname === "/sell/inventory/v1/offer" && init?.method === "POST") return jsonResponse({ offerId: "offer-1" }, 201);
    if (parsed.pathname.startsWith("/sell/inventory/v1/inventory_item/") && init?.method === "PUT") return new Response(null, { status: 204 });
    if (parsed.pathname === "/sell/inventory/v1/offer/offer-1" && init?.method === "PUT") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method} ${parsed.pathname}`);
  });
}

async function runConsumer(name: ConsumerName, repo: DropshipMarketplaceCredentialRepository, fetchFn: typeof fetch): Promise<unknown> {
  if (name === "order intake") {
    return new EbayDropshipOrderIntakeProvider(repo, fetchFn, clock).fetchOrders({
      connection: { ...identity, platform: "ebay", lastOrderSyncAt: null }, since: NOW, until: NOW,
    });
  }
  if (name === "return intake") {
    return new EbayDropshipReturnIntakeProvider(repo, fetchFn, clock).fetchReturns({
      connection: { ...identity, lastReturnSyncAt: null }, since: NOW, until: NOW,
    });
  }
  if (name === "tracking") {
    return new EbayDropshipMarketplaceTrackingProvider(repo, fetchFn, clock).pushTracking({
      ...identity, intakeId: 1, omsOrderId: 2, wmsShipmentId: null, platform: "ebay",
      externalOrderId: "order-1", externalOrderNumber: null, sourceOrderId: null,
      carrier: "USPS", trackingNumber: "94001111", shippedAt: NOW,
      lineItems: [{ externalLineItemId: "line-1", quantity: 1 }], idempotencyKey: "tracking-1",
    });
  }
  if (name === "cancellation") {
    return new EbayDropshipOrderCancellationProvider(repo, fetchFn, clock).cancelOrder({
      ...identity, intakeId: 1, platform: "ebay", externalOrderId: "order-1",
      externalOrderNumber: null, sourceOrderId: null, orderedAt: null,
      reason: "payment_hold_expired", idempotencyKey: "cancel-1",
    });
  }
  const preflight = { compatible: true, fulfillmentPolicyId: "fulfillment-policy", capabilityEvidenceHash: "hash", originWarehouseId: 1, issues: [] };
  const location = { merchantLocationKey: policyConfig.merchantLocationKey, name: "Card Shellz", originWarehouseId: 1, action: "unchanged" as const };
  const provider = new EbayDropshipListingPushProvider(repo, fetchFn, clock, {
    evaluateForStoreConnection: async () => preflight,
    evaluateWithAccessToken: async (input) => {
      expect(input.environment).toBe("production");
      return preflight;
    },
  }, {
    ensureForStoreConnection: async () => location,
    ensureWithAccessToken: async () => location,
  }, () => createAdmittedEbayQuantityTestOwner());
  if (name === "listing replacement") {
    return provider.createReplacementLifecycleClient({ ...identity, marketplaceConfig: policyConfig });
  }
  return provider.pushListing(listingRequest());
}

function listingRequest(): DropshipMarketplaceListingPushRequest {
  return {
    ...identity, jobId: 1, jobItemId: 2, listingId: 3, productVariantId: 101, platform: "ebay",
    existingExternalListingId: null, existingExternalOfferId: null, idempotencyKey: "listing-1",
    listingIntent: {
      platform: "ebay", listingMode: "draft_first", inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined", productVariantId: 101, sku: "SKU-101", title: "Toploader",
      description: "Rigid card protection.", category: "Protectors", marketplaceCategoryId: "183438",
      marketplaceCategoryName: "Card Toploaders", storeCategoryNames: [], brand: "Card Shellz",
      gtin: "000000000101", mpn: "TL35", condition: "new", itemSpecifics: { Size: ["35pt"] },
      imageUrls: ["https://cdn.example.test/toploader.jpg"], weightGrams: 100, priceCents: 1299,
      quantity: 4, marketplaceConfig: policyConfig,
    },
  };
}

function catalogDirectories(repo: DropshipMarketplaceCredentialRepository, fetchFn: typeof fetch) {
  const registration = new RefreshingDropshipEbayRegistrationCredentialProvider(
    repo, { clientId: "client", clientSecret: "secret" }, fetchFn, clock,
  );
  return {
    setup: new EbayDropshipListingSetupDirectory(registration, fetchFn),
    categories: new EbayDropshipStoreCategoryDirectory(registration, fetchFn),
  };
}

async function expectCatalogAccess(directories: ReturnType<typeof catalogDirectories>): Promise<void> {
  const [setup, categories] = await Promise.all([
    directories.setup.discoverForStoreConnection({ ...identity, marketplaceId: "EBAY_US" }),
    directories.categories.listLeafCategories(identity),
  ]);
  expect(setup).toMatchObject({
    merchantLocations: [{ id: "warehouse-1", name: "Card Shellz" }],
    fulfillmentPolicies: [{ id: "fulfillment-1", name: "Ground" }],
    returnPolicies: [{ id: "return-1", name: "Thirty days" }],
    paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
  });
  expect(categories).toEqual([{ categoryId: "30", categoryName: "Supplies", path: "Supplies", level: 1 }]);
}

function permissionAwareEbay() {
  let refreshes = 0;
  let denied = 0;
  const protectedTokens: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(new URL(String(url)).origin).toBe("https://api.ebay.com");
    if (path === "/identity/v1/oauth2/token") {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("refresh_token")).toBe("seller-refresh-grant");
      refreshes += 1;
      // Model the original defect, not just request syntax: requesting a worker
      // subset mints a token that Orders accepts but Inventory/Account/Stores reject.
      const prefix = form.has("scope") ? "order-only" : "full-grant";
      return jsonResponse({ access_token: `${prefix}-token-${refreshes}`, expires_in: 7200 });
    }
    const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (path === "/sell/fulfillment/v1/order") return jsonResponse({ orders: [], total: 0 });
    if (!token.startsWith("full-grant-token-")) {
      denied += 1;
      return jsonResponse({ errors: [{ errorId: 1100, message: "Insufficient permissions" }] }, 403);
    }
    protectedTokens.push(token);
    if (path === "/sell/inventory/v1/location") {
      return jsonResponse({ locations: [{ merchantLocationKey: "warehouse-1", name: "Card Shellz", merchantLocationStatus: "ENABLED" }] });
    }
    if (path === "/sell/account/v1/fulfillment_policy") {
      return jsonResponse({ fulfillmentPolicies: [{
        fulfillmentPolicyId: "fulfillment-1", name: "Ground", marketplaceId: "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        handlingTime: { value: 1, unit: "DAY" },
        shippingOptions: [{ optionType: "DOMESTIC", shippingServices: [{ shippingServiceCode: "USPSParcel" }] }],
        localPickup: false, freightShipping: false, pickupDropOff: false,
      }] });
    }
    if (path === "/sell/account/v1/return_policy") {
      return jsonResponse({ returnPolicies: [{ returnPolicyId: "return-1", name: "Thirty days", categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }] }] });
    }
    if (path === "/sell/account/v1/payment_policy") {
      return jsonResponse({ paymentPolicies: [{ paymentPolicyId: "payment-1", name: "Managed payments", categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }] }] });
    }
    if (path === "/sell/stores/v1/store/categories") {
      return jsonResponse({ storeCategories: [{ categoryId: "30", categoryName: "Supplies" }] });
    }
    throw new Error(`Unexpected permission-test URL: ${path}`);
  });
  return {
    fetchFn, refreshCount: () => refreshes, deniedReads: () => denied,
    successfulProtectedTokens: () => [...protectedTokens],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
