/**
 * Capability-scoped public API for `catalog.product_line_products` writes
 * delegated by peer modules (such as `channels`).
 */
export {
  type ProductLineMembershipExecutor,
  replaceProductLineProductsInCatalog,
  addProductToProductLineInCatalog,
  removeProductFromProductLineInCatalog,
  addProductsToProductLineInCatalog,
  removeProductsFromLineInCatalog,
  removeProductsFromAllLinesInCatalog,
} from "./application/product-line-membership.command";
