import type { MarketplaceObservedListingPublication, MarketplaceProviderAccountObservation } from "./listing-registration-plan";

export interface EbayListingInspectionIssue {
  readonly code: string; readonly message: string; readonly status?: number;
  readonly sku?: string; readonly listingId?: string; readonly groupKey?: string; readonly listingStatus?: string;
  readonly groupVariantSkus?: readonly string[];
}
export interface EbayListingInspectedOffer {
  readonly sku: string | null;
  readonly offerId: string;
  readonly status: "PUBLISHED" | "UNPUBLISHED";
  readonly listingId: string | null;
  readonly listingStatus: string | null;
}
export interface EbayListingInspectedSku {
  readonly sku: string;
  readonly inventoryItemExists: boolean | null;
  readonly offers: readonly EbayListingInspectedOffer[];
  readonly issue: EbayListingInspectionIssue | null;
}
/** Diagnostic reads are not publication proof. Only publication carries the
 * existing canonical observer's complete account/group/member verification. */
export interface EbayListingInspection {
  readonly providerAccount: MarketplaceProviderAccountObservation;
  readonly observedAt: Date;
  readonly skus: readonly EbayListingInspectedSku[];
  readonly publication: MarketplaceObservedListingPublication | null;
  readonly publicationIssue: EbayListingInspectionIssue | null;
  readonly groupKey: string | null;
  readonly groupSkus: readonly string[] | null;
}
