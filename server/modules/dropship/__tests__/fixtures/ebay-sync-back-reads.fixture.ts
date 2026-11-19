/**
 * eBay sync-back test reads (plan v4 §4): the raw JSON shapes of
 * `GET /sell/inventory/v1/offer/{offerId}` and `GET /inventory_item/{sku}`
 * as the decision tests feed them through the real parser. Values are the
 * ones a listing Card Shellz pushed would carry; each test overrides only
 * what it is about.
 */
export const READ_OFFER_ID = "OFFER-9001";
export const READ_SKU = "CS-TOP-100";
export const READ_LISTING_ID = "110000000001";

export interface RawOfferOverrides {
  [key: string]: unknown;
  listingPolicies?: Record<string, unknown> | undefined;
  listing?: Record<string, unknown> | undefined;
  pricingSummary?: Record<string, unknown>;
}

export function rawOffer(overrides: RawOfferOverrides = {}): Record<string, unknown> {
  return {
    offerId: READ_OFFER_ID,
    sku: READ_SKU,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    status: "PUBLISHED",
    availableQuantity: 10,
    categoryId: "183454",
    listingDescription: "<p>Card Shellz toploaders.</p>",
    pricingSummary: { price: { value: "11.00", currency: "USD" } },
    listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" },
    listing: { listingId: READ_LISTING_ID, listingStatus: "ACTIVE" },
    // A field sync-back does not model: ignored, never kept.
    merchantLocationKey: "cs-wh-1",
    ...overrides,
  };
}

export function rawInventoryItem(overrides: Record<string, unknown> = {}, product: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: READ_SKU,
    condition: "NEW",
    product: {
      title: "Card Shellz Toploaders 3x4 (100)",
      description: "<p>Card Shellz toploaders.</p>",
      aspects: { Brand: ["Card Shellz"], Size: ["3x4"] },
      imageUrls: ["https://i.ebayimg.com/1.jpg", "https://i.ebayimg.com/2.jpg"],
      ...product,
    },
    availability: { shipToLocationAvailability: { quantity: 10 } },
    ...overrides,
  };
}
