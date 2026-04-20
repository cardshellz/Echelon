/**
 * Thin re-export to keep sync-recovery.service free of cross-module
 * import ordering weirdness. The underlying logic lives in
 * ../oms/shopify-bridge.ts.
 */
export { backfillShopifyOrders } from "../oms/shopify-bridge";
