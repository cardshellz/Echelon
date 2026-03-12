/**
 * @echelon/catalog — Products, Variants, Assets, Product Lines
 *
 * Tables owned: products, productVariants, productAssets, productLines, productLineProducts
 * Depends on: nothing (leaf module)
 */

// Storage
export { type IProductStorage, productMethods } from "./catalog.storage";

// Routes
export { registerProductRoutes } from "./catalog.routes";

// Services
export { createProductImportService } from "./product-import.service";
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "./product-import.service";
