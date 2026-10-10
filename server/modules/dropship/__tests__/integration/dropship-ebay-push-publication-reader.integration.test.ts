import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresDropshipEbayPushPublicationReader } from "../../infrastructure/dropship-ebay-push-publication.reader";
import type { DropshipMarketplaceListingPushRequest } from "../../application/dropship-marketplace-listing-push-provider";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import type { EbayListingConnectorDraft, EbayDiscoveredPublishedListing } from "../../../channels/listing-connectors/ebay-listing.connector";
import type { MarketplaceListingRegistrationObserver } from "../../../marketplace-listings/application/registration-ports";
import type { MarketplaceObservedListingPublication } from "../../../marketplace-listings/domain/listing-registration-plan";
import { buildEbayRegistrationIdentityNamespace } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";

const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(configured ? describe : describe.skip).sequential("Dropship eBay publication identity SQL ownership", () => {
  let database: InventoryCutoverTestDatabase;
  let reader: PostgresDropshipEbayPushPublicationReader;
  const observe = vi.fn(async (input: Parameters<MarketplaceListingRegistrationObserver["observeExistingPublication"]>[0]): Promise<MarketplaceObservedListingPublication> => {
    const namespace = (role: "listing" | "offer" | "inventory_item") => buildEbayRegistrationIdentityNamespace({ environment:"production",marketplaceId:"EBAY_US",role });
    return {
      providerAccount:{ provider:"ebay",accountNamespace:"production",externalAccountId:"seller-1",identityScheme:"provider_user_id",externalDisplayNameSnapshot:null,evidenceHash:"a".repeat(64) },
      marketplaceId:"EBAY_US",publicationKeyIdentity:null,listingIdentity:{ externalId:input.locator.externalListingId!,identityNamespace:namespace("listing") },
      externalUrl:null,isPublished:true,observedAt:new Date("2026-10-09T12:00:00Z"),evidence:{},
      members:input.memberCandidates.map(member => ({ sku:member.sku,variantIdentity:null,
        offerIdentity:{ externalId:`offer-${member.productVariantId}`,identityNamespace:namespace("offer") },
        inventoryItemIdentity:{ externalId:member.sku,identityNamespace:namespace("inventory_item") } })),
    };
  });
  beforeAll(async () => {
    // Reduced real named-schema fixture proves these owner queries and joins;
    // it does not claim a full production migration installation.
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL,true,`
      CREATE SCHEMA catalog; CREATE SCHEMA dropship;
      CREATE TABLE catalog.products(id integer PRIMARY KEY);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products,sku text,is_active boolean NOT NULL);
      CREATE TABLE dropship.dropship_vendor_listings(id integer PRIMARY KEY,vendor_id integer NOT NULL,store_connection_id integer NOT NULL,
        product_variant_id integer NOT NULL REFERENCES catalog.product_variants);
      INSERT INTO catalog.products VALUES(20),(21);
      INSERT INTO catalog.product_variants VALUES(101,20,'SKU-101',true),(102,20,'SKU-102',false),(103,21,'SKU-103',true);
      INSERT INTO dropship.dropship_vendor_listings VALUES(50,10,22,101),(51,11,22,102),(52,10,23,101),(53,10,22,102),(54,10,22,103);
    `);
    reader = new PostgresDropshipEbayPushPublicationReader(database.pool,{ observeExistingPublication:observe });
  },60000);
  beforeEach(() => { observe.mockClear(); });
  afterAll(async () => { await database?.close(); });

  it("binds the exact vendor/store/listing/variant to its real parent product", async () => {
    const request = pushRequest();
    await expect(reader.resolve(request,credential(),discovered([101]))).resolves.toMatchObject({ listingIdentity:{ externalId:"listing-20" } });
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      owner:{ kind:"dropship",storeConnectionId:22,productId:20,provider:"ebay",marketplaceId:"EBAY_US" },
      locator:{ providerPublicationKey:null,externalListingId:"listing-20" },
      memberCandidates:[{ productVariantId:101,sku:"SKU-101",isActive:true,availableQuantity:4 }],
    });
  });

  it.each([
    { name:"vendor",request:{ vendorId:11 },credential:{ vendorId:11 } },
    { name:"store",request:{ storeConnectionId:23 },credential:{ storeConnectionId:23 } },
    { name:"listing",request:{ listingId:51 },credential:{} },
    { name:"variant",request:{ productVariantId:102 },credential:{} },
    { name:"missing listing",request:{ listingId:999 },credential:{} },
  ])("refuses wrong $name ownership before calling the provider observer", async input => {
    const request = { ...pushRequest(),...input.request };
    await expect(reader.resolve(request,{ ...credential(),...input.credential },discovered([request.productVariantId])))
      .rejects.toMatchObject({ code:"DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("includes every requested owned rebuild member with the actual inactive flag and supplied quantities", async () => {
    await reader.resolveRebuild({ vendorId:10,storeConnectionId:22,draft:rebuildDraft([101,102]) },credential(),discovered([101,102]));
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      owner:{ kind:"dropship",storeConnectionId:22,productId:20,provider:"ebay",marketplaceId:"EBAY_US" },
      locator:{ providerPublicationKey:null,externalListingId:"listing-20" },
      memberCandidates:[{ productVariantId:101,sku:"SKU-101",isActive:true,availableQuantity:4 },
        { productVariantId:102,sku:"SKU-102",isActive:false,availableQuantity:0 }],
    });
  });

  it.each([
    { name:"member in another product",ids:[101,103],vendorId:10,storeConnectionId:22 },
    { name:"member owned only at another store",ids:[101,102],vendorId:10,storeConnectionId:23 },
    { name:"member owned only by another vendor",ids:[101,102],vendorId:11,storeConnectionId:22 },
    { name:"duplicate local member",ids:[101,101],vendorId:10,storeConnectionId:22 },
    { name:"missing member",ids:[101,999],vendorId:10,storeConnectionId:22 },
  ])("refuses a rebuild with $name before provider observation", async input => {
    await expect(reader.resolveRebuild({ vendorId:input.vendorId,storeConnectionId:input.storeConnectionId,draft:rebuildDraft(input.ids) },
      { ...credential(),vendorId:input.vendorId,storeConnectionId:input.storeConnectionId },discovered(input.ids)))
      .rejects.toMatchObject({ code:"DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses a provider discovery missing a requested owned rebuild member", async () => {
    await expect(reader.resolveRebuild({ vendorId:10,storeConnectionId:22,draft:rebuildDraft([101,102]) },credential(),discovered([101])))
      .rejects.toMatchObject({ code:"DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED" });
    expect(observe).not.toHaveBeenCalled();
  });
});

function credential(): DropshipMarketplaceStoreCredentials {
  return { vendorId:10,storeConnectionId:22,platform:"ebay",status:"connected",shopDomain:null,externalAccountId:"seller-1",
    providerEnvironment:"production",externalAccountIdentityScheme:"ebay_user_id",externalAccountVerifiedAt:new Date("2026-10-01T00:00:00Z"),
    externalDisplayName:null,config:{},accessToken:"test-token-not-sent",accessTokenRef:"access-ref",accessTokenExpiresAt:null,
    refreshToken:null,refreshTokenRef:null,refreshTokenExpiresAt:null };
}
function pushRequest(): DropshipMarketplaceListingPushRequest {
  return { vendorId:10,storeConnectionId:22,jobId:30,jobItemId:40,listingId:50,productVariantId:101,platform:"ebay",
    existingExternalListingId:null,existingExternalOfferId:null,idempotencyKey:"test-push-101",
    listingIntent:{ platform:"ebay",listingMode:"live",inventoryMode:"managed_quantity_sync",priceMode:"vendor_defined",productVariantId:101,
      sku:"SKU-101",title:"Pack",description:null,category:null,marketplaceCategoryId:"123",marketplaceCategoryName:null,
      storeCategoryNames:[],brand:null,gtin:null,mpn:null,condition:"new",itemSpecifics:null,imageUrls:[],weightGrams:100,
      priceCents:999,quantity:4,marketplaceConfig:{ marketplaceId:"EBAY_US" } } };
}
function discovered(ids: readonly number[]): EbayDiscoveredPublishedListing {
  return { listingId:"listing-20",members:ids.map(variantId => ({ variantId,sku:`SKU-${variantId}`,offerId:`offer-${variantId}` })) };
}
function rebuildDraft(ids: readonly number[]): EbayListingConnectorDraft {
  return { productId:20,marketplaceId:"EBAY_US",publishMode:"publish",hasExistingExternalIds:true,inventoryItems:[],
    offers:ids.map(variantId => ({ variantId,sku:`SKU-${variantId}`,payload:{ sku:`SKU-${variantId}`,marketplaceId:"EBAY_US",format:"FIXED_PRICE",
      availableQuantity:variantId===102 ? 0 : 4,categoryId:"123",merchantLocationKey:"HQ",pricingSummary:{ price:{ value:"9.99",currency:"USD" } },
      listingPolicies:{ fulfillmentPolicyId:"fulfillment",paymentPolicyId:"payment",returnPolicyId:"return" } } })) };
}
