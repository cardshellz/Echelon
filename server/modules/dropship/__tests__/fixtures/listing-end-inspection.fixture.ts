import type { EbayListingInspection, EbayListingInspectedOffer } from "../../../marketplace-listings/domain/ebay-listing-inspection";
import type { MarketplaceObservedListingPublication } from "../../../marketplace-listings/domain/listing-registration-plan";

/**
 * Inspections as the shared registration observer answers them (inspectExistingPublication), for the listing end
 * worker's unit and DI tests (PLAN-C v4.1 §5.5 step 4). eBay is never called: every case builds its own answer.
 */
export const INSPECTION_ACCOUNT = "seller-22";
export const INSPECTION_SKU = "CS-TOP-101";
export const INSPECTION_OFFER = "OFFER-101";
export const INSPECTION_LISTING = "110000000101";
export const INSPECTION_MARKET = "EBAY_US";
const AT = new Date("2026-10-26T09:00:00.000Z");

export function inspectedOffer(overrides: Partial<EbayListingInspectedOffer> = {}): EbayListingInspectedOffer {
  return { sku: INSPECTION_SKU, offerId: INSPECTION_OFFER, status: "PUBLISHED", listingId: INSPECTION_LISTING, listingStatus: "ACTIVE",
    ...overrides };
}

export function observedPublication(overrides: Partial<{ listingId: string; marketplaceId: string; sku: string; offerId: string;
  isPublished: boolean; members: number }> = {}): MarketplaceObservedListingPublication {
  const sku = overrides.sku ?? INSPECTION_SKU;
  const member = { sku, variantIdentity: null, offerIdentity: { externalId: overrides.offerId ?? INSPECTION_OFFER, identityNamespace: "ebay:offer" },
    inventoryItemIdentity: { externalId: sku, identityNamespace: "ebay:inventory_item" } };
  return {
    providerAccount: providerAccount(),
    marketplaceId: overrides.marketplaceId ?? INSPECTION_MARKET,
    publicationKeyIdentity: null,
    listingIdentity: { externalId: overrides.listingId ?? INSPECTION_LISTING, identityNamespace: "ebay:listing" },
    externalUrl: null,
    isPublished: overrides.isPublished ?? true,
    members: Array.from({ length: overrides.members ?? 1 }, (_, index) => index === 0 ? member : { ...member, sku: `${sku}-${index}` }),
    evidence: {},
    observedAt: AT,
  };
}

function providerAccount(accountId = INSPECTION_ACCOUNT) {
  return { provider: "ebay", accountNamespace: "ebay:production", externalAccountId: accountId, identityScheme: "provider_user_id" as const,
    externalDisplayNameSnapshot: null, evidenceHash: "hash" };
}

/** A published single-SKU listing: our offer, PUBLISHED, with its verified publication. */
export function publishedInspection(overrides: Partial<EbayListingInspection> = {}): EbayListingInspection {
  return { providerAccount: providerAccount(), observedAt: AT,
    skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true, offers: [inspectedOffer()], issue: null }],
    publication: observedPublication(), publicationIssue: null, groupKey: null, groupSkus: null, unpublishedTarget: null, ...overrides };
}

/** Our offer withdrawn: UNPUBLISHED, no listing, no publication (the observer's unpublished target). */
export function unpublishedInspection(overrides: Partial<EbayListingInspection> = {}): EbayListingInspection {
  return { providerAccount: providerAccount(), observedAt: AT,
    skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true,
      offers: [inspectedOffer({ status: "UNPUBLISHED", listingId: null, listingStatus: null })], issue: null }],
    publication: null, publicationIssue: null, groupKey: null, groupSkus: null,
    unpublishedTarget: { groupKey: null, skus: [INSPECTION_SKU] }, ...overrides };
}

export function inspectionWithAccount(accountId: string): EbayListingInspection {
  return publishedInspection({ providerAccount: providerAccount(accountId) });
}
