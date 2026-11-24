/**
 * Public catalog product/variant eBay metadata write contract (`catalog.products`, `catalog.product_variants`).
 */
export {
  bulkUpdateCatalogProductType,
  setCatalogVariantEbayListingExcludedInTx,
  updateCatalogProductEbayBrowseCategory,
  updateCatalogProductType,
} from "./application/ebay-product-metadata.command";
