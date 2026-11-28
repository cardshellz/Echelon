/**
 * Capability-scoped public API for cross-module `catalog.products` and
 * `catalog.product_variants` mutations (`channels`, `inventory`, `procurement`).
 *
 * Accepts caller DB/transaction executors so transactions and unit-test mocks
 * remain intact without touching the DB singleton at module load time.
 */
export {
  updateVariantWeightIfNullInCatalog,
  updateVariantBackfillCostsInCatalog,
  syncVariantCostRollupFromLotsInCatalog,
  updateVariantReceiptCostRollupInCatalog,
  updateProductFromShopifyBackfillInCatalog,
  insertProductFromShopifyBackfillInCatalog,
  updateProductPulledContentFieldsInCatalog,
  setProductReorderExcludedInCatalog,
} from "./application/cross-module-product-mutations.command";
