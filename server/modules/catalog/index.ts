/**
 * @echelon/catalog — Products, Variants, Assets, Product Lines
 *
 * Tables owned: products, productVariants, productAssets, productLines, productLineProducts
 * Depends on: nothing (leaf module)
 */

// Storage
export { type IProductStorage, productMethods } from "./infrastructure/catalog.storage";
import { type IProductStorage, productMethods } from "./infrastructure/catalog.storage";
export const catalogStorage: IProductStorage = productMethods;

export { readInventoryCostDisplay, type InventoryCostDisplay } from "./infrastructure/inventory-cost-display.reader";

export { createSharedProductPhotoImporter, type SharedImportedPhoto } from "./application/shared-product-photos.service";

// Service types
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "./application/product-import.service";

export {
  confirmProductVariantShipsInOwnContainer,
  type CatalogVariantShippingFlagsWriteExecutor,
} from "./variant-shipping-flags.api";

