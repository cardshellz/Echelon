// Channels owns Shopify identities, feeds and logins. Inventory planning's stock-link engine consumes this read-only
// source (PLAN-CH2 v4.1 §6.2) and the adapter beside it (adapters/shopify-stock-link.adapter.ts) through its own ports
// (IP/application/stock-link.ports.ts); the composition registers both for channel_connection + shopify.
export { createShopifyStockLinkSource, ShopifyStockLinkSource, SHOPIFY_STOCK_LINK_RECENT_OVERLAP } from "./infrastructure/shopify-stock-link-source";
export {
  createShopifyStockLinkAdapter, ShopifyStockLinkAdapter, ShopifyStockLinkProviderError, shopifyStockLinkFingerprint,
  SHOPIFY_STOCK_LINK_API_VERSION, STOCK_LINK_COST_FLOOR_RATIO,
} from "./adapters/shopify-stock-link.adapter";
export type { ShopifyStockLinkAdapterDependencies, ShopifyStockLinkFingerprintConnection } from "./adapters/shopify-stock-link.adapter";
