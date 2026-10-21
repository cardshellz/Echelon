import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresDropshipEbayPushPublicationReader } from "../../infrastructure/dropship-ebay-push-publication.reader";
import type { DropshipMarketplaceListingPushRequest } from "../../application/dropship-marketplace-listing-push-provider";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import type { EbayDiscoveredPublishedListing, EbayListingConnectorDraft } from "../../../channels/listing-connectors/ebay-listing.connector";
import type { MarketplaceListingRegistrationObserver } from "../../../marketplace-listings/application/registration-ports";
import {
  MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
  type MarketplaceObservedListingPublication,
} from "../../../marketplace-listings/domain/listing-registration-plan";
import { buildEbayRegistrationIdentityNamespace } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { DropshipError } from "../../domain/errors";

/**
 * The adoption account check. Production stores the verified eBay user id with
 * scheme provider_user_id (the only non-NULL value migration 0609's CHECK admits);
 * the check used to require "ebay_user_id", which no writer stores, so it refused
 * every store whose SKU was already live on eBay.
 */
describe("Dropship eBay publication reader account check", () => {
  let query: ReturnType<typeof vi.fn>;
  let observe: ReturnType<typeof vi.fn>;
  let reader: PostgresDropshipEbayPushPublicationReader;

  beforeEach(() => {
    query = vi.fn(async () => ({ rows: [{ product_id: 20, product_variant_id: 101, is_active: true }] }));
    observe = vi.fn(async (input: Parameters<MarketplaceListingRegistrationObserver["observeExistingPublication"]>[0]) =>
      observation(input.locator.externalListingId!, input.memberCandidates.map((member) => member.sku)));
    reader = new PostgresDropshipEbayPushPublicationReader(
      { query } as unknown as Pick<Pool, "query">,
      { observeExistingPublication: observe } as unknown as MarketplaceListingRegistrationObserver,
    );
  });

  it("stores and checks the same scheme constant", () => {
    expect(MARKETPLACE_PROVIDER_IDENTITY_SCHEME).toBe("provider_user_id");
  });

  it("adopts with a verified provider_user_id account and passes that account id to the observer", async () => {
    await expect(reader.resolve(pushRequest(), credential(), discovered())).resolves.toMatchObject({
      providerAccount: { externalAccountId: "seller-1", identityScheme: "provider_user_id" },
      listingIdentity: { externalId: "listing-20" },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("checks the account for a rebuild the same way", async () => {
    query.mockResolvedValueOnce({ rows: [{ product_variant_id: 101, is_active: true }] });
    await expect(reader.resolveRebuild({ vendorId: 10, storeConnectionId: 22, draft: rebuildDraft() }, credential(), discovered()))
      .resolves.toMatchObject({ providerAccount: { externalAccountId: "seller-1" } });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("refuses an observation for a different seller than the verified account", async () => {
    observe.mockResolvedValueOnce({ ...observation("listing-20", ["SKU-101"]),
      providerAccount: { ...observation("listing-20", ["SKU-101"]).providerAccount, externalAccountId: "different-seller" } });
    await expect(reader.resolve(pushRequest(), credential(), discovered())).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
  });

  const unverified: ReadonlyArray<[string, Partial<Record<keyof DropshipMarketplaceStoreCredentials, unknown>>]> = [
    ["a NULL scheme (legacy username-only connection)", { externalAccountIdentityScheme: null }],
    // Not representable in the type any more; simulates a value from outside it.
    ["the scheme no writer stores", { externalAccountIdentityScheme: "ebay_user_id" }],
    ["a NULL verification time", { externalAccountVerifiedAt: null }],
    ["a NULL account id", { externalAccountId: null }],
    ["an empty account id", { externalAccountId: "" }],
    ["a blank account id", { externalAccountId: "   " }],
    ["another vendor's credential", { vendorId: 11 }],
    ["another store's credential", { storeConnectionId: 23 }],
    ["a non-eBay credential", { platform: "shopify" }],
  ];

  it.each(unverified)("refuses %s before any database query or observer call", async (_name, override) => {
    const error = await reader.resolve(pushRequest(), credential(override), discovered()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({
      code: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED",
      message: "The published offer cannot be adopted without this store's verified eBay account. Reconnect the intended store account.",
      context: { retryable: false },
    });
    expect(query).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(unverified)("refuses a rebuild with %s before any database query or observer call", async (_name, override) => {
    await expect(reader.resolveRebuild({ vendorId: 10, storeConnectionId: 22, draft: rebuildDraft() }, credential(override), discovered()))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED", context: { retryable: false } });
    expect(query).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});

function credential(
  override: Partial<Record<keyof DropshipMarketplaceStoreCredentials, unknown>> = {},
): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10, storeConnectionId: 22, platform: "ebay", status: "connected", shopDomain: null,
    externalAccountId: "seller-1", providerEnvironment: "production",
    externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: new Date("2026-10-01T00:00:00Z"),
    externalDisplayName: null, config: {}, accessToken: "test-token-not-sent", accessTokenRef: "access-ref",
    accessTokenExpiresAt: null, refreshToken: null, refreshTokenRef: null, refreshTokenExpiresAt: null,
    ...override,
  } as DropshipMarketplaceStoreCredentials;
}

function observation(listingId: string, skus: readonly string[]): MarketplaceObservedListingPublication {
  const namespace = (role: "listing" | "offer" | "inventory_item") =>
    buildEbayRegistrationIdentityNamespace({ environment: "production", marketplaceId: "EBAY_US", role });
  return {
    providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: "seller-1",
      identityScheme: "provider_user_id", externalDisplayNameSnapshot: null, evidenceHash: "a".repeat(64) },
    marketplaceId: "EBAY_US", publicationKeyIdentity: null,
    listingIdentity: { externalId: listingId, identityNamespace: namespace("listing") },
    externalUrl: null, isPublished: true, observedAt: new Date("2026-10-09T12:00:00Z"), evidence: {},
    members: skus.map((sku) => ({ sku, variantIdentity: null,
      offerIdentity: { externalId: "offer-101", identityNamespace: namespace("offer") },
      inventoryItemIdentity: { externalId: sku, identityNamespace: namespace("inventory_item") } })),
  };
}

function pushRequest(): DropshipMarketplaceListingPushRequest {
  return { vendorId: 10, storeConnectionId: 22, jobId: 30, jobItemId: 40, listingId: 50, productVariantId: 101, platform: "ebay",
    existingExternalListingId: null, existingExternalOfferId: null, idempotencyKey: "test-push-101",
    listingIntent: { platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
      productVariantId: 101, sku: "SKU-101", title: "Pack", description: null, category: null, marketplaceCategoryId: "123",
      marketplaceCategoryName: null, storeCategoryNames: [], brand: null, gtin: null, mpn: null, condition: "new",
      itemSpecifics: null, imageUrls: [], weightGrams: 100, priceCents: 999, quantity: 4,
      marketplaceConfig: { marketplaceId: "EBAY_US" } } };
}

function discovered(): EbayDiscoveredPublishedListing {
  return { listingId: "listing-20", members: [{ variantId: 101, sku: "SKU-101", offerId: "offer-101" }] };
}

function rebuildDraft(): EbayListingConnectorDraft {
  return { productId: 20, marketplaceId: "EBAY_US", publishMode: "publish", hasExistingExternalIds: true, inventoryItems: [],
    offers: [{ variantId: 101, sku: "SKU-101", payload: { sku: "SKU-101", marketplaceId: "EBAY_US", format: "FIXED_PRICE",
      availableQuantity: 4, categoryId: "123", merchantLocationKey: "HQ", pricingSummary: { price: { value: "9.99", currency: "USD" } },
      listingPolicies: { fulfillmentPolicyId: "fulfillment", paymentPolicyId: "payment", returnPolicyId: "return" } } }] };
}
