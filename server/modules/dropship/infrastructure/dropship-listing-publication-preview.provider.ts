import { EbayListingBuilder } from "../../channels/adapters/ebay/ebay-listing-builder";
import type { DropshipMarketplaceListingIntent } from "../application/dropship-marketplace-listing-provider";
import type { DropshipPublicationPreview } from "../application/dropship-listing-presentation";
import { DropshipError } from "../domain/errors";
import { buildDropshipEbayListingDraft, parseEbayListingConfig } from "./dropship-ebay-listing-push.provider";

/** Pure draft construction: no credentials, network requests, listings, or inventory writes. */
export function resolveDropshipPublicationPreview(intent: DropshipMarketplaceListingIntent): DropshipPublicationPreview | null {
  if (intent.platform !== "ebay") return null;
  const draft = buildDropshipEbayListingDraft({
    productVariantId: intent.productVariantId,
    listingIntent: intent,
    existingExternalOfferId: null,
  }, parseEbayListingConfig(intent.marketplaceConfig, {}), new EbayListingBuilder());
  const item = draft.inventoryItems[0]?.payload;
  if (!item?.product) {
    throw new DropshipError("DROPSHIP_LISTING_PRESENTATION_UNAVAILABLE", "The eBay listing draft did not contain a product.");
  }
  return {
    title: item.product.title,
    description: item.product.description ?? null,
    imageUrls: item.product.imageUrls ?? [],
    condition: item.condition,
    itemSpecifics: item.product.aspects ?? {},
  };
}
