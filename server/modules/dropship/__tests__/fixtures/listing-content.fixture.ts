import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import type { ContentProfileState } from "../../../../../shared/dropship/listing-content";
export function contentCandidate(): DropshipListingCatalogCandidate {
  return { productVariantId: 101, productId: 7, productName: "Armalope", variantName: "Pack of 50", sku: "ARM-50",
    title: "Armalope pack", description: "<p>Protect your cards.</p><ul><li>Durable mailer</li></ul>", category: "Mailers",
    productLineIds: [3], productIsActive: true, variantIsActive: true, unitsPerVariant: 50, catalogUnitsPerVariant: 50,
    brand: "Card Shellz", condition: "NEW", gtin: null, mpn: "ARM", itemSpecifics: { Color: ["White"] },
    imageUrls: [], weightGrams: 100, defaultRetailPriceCents: 899, ebayBrowseCategoryId: "184267", ebayBrowseCategoryName: "Mailers" };
}
export const noContentProfile: ContentProfileState = { revisionId: null, profile: null, updatedAt: null };
