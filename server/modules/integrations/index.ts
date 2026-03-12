/**
 * @echelon/integrations — External service adapters (Shopify, etc.)
 *
 * Tables owned: none (pure adapters)
 * Depends on: nothing (leaf module)
 */

export {
  fetchShopifyCatalogProducts,
  fetchUnfulfilledOrders,
  fetchOrdersFulfillmentStatus,
  verifyShopifyWebhook,
  verifyWebhookWithSecret,
  extractSkusFromWebhookPayload,
  extractOrderFromWebhookPayload,
  type ShopifyVariant,
  type ShopifyImage,
  type ShopifyProduct,
  type ShopifyOrder,
  type ShopifyCatalogProduct,
} from "./shopify";
