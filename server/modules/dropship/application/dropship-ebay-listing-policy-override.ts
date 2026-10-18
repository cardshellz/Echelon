/**
 * One size's own eBay business policies, as stored in
 * dropship.dropship_ebay_listing_policy_overrides. The rows stay and are
 * still read (the listing preview and the listing settings facts), but no
 * route writes them any more: their per-size writer was deleted in Listing
 * settings PR 12, and only the leftovers clean-up changes them now
 * (dropship-listing-setting-leftovers.repository.ts).
 */
export interface DropshipEbayListingPolicyOverride {
  productVariantId: number;
  revisionId: number;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  updatedAt: Date;
}
