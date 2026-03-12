/**
 * @echelon/catalog — Products, Variants, Assets, Product Lines
 *
 * Tables owned: products, productVariants, productAssets, productLines, productLineProducts
 * Depends on: nothing (leaf module)
 */

// Storage
export { type IProductStorage, productMethods } from "./catalog.storage";
import { type IProductStorage, productMethods } from "./catalog.storage";
export const catalogStorage: IProductStorage = productMethods;

// Service types
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "./product-import.service";
