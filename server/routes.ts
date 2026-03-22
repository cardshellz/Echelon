import type { Express } from "express";
import { createServer, type Server } from "http";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons } from "./modules/identity/rbac";

import { registerAuthRoutes } from "./modules/identity/identity.routes";
import { registerLocationRoutes } from "./modules/warehouse/locations.routes";
import { registerPickingRoutes } from "./modules/orders/picking.routes";
import { registerShopifyRoutes } from "./routes/shopify.routes";
import { registerWarehouseRoutes } from "./modules/warehouse/warehouse.routes";
import { registerProductRoutes } from "./modules/catalog/catalog.routes";
import { registerInventoryRoutes } from "./modules/inventory/inventory.routes";
import { registerChannelRoutes } from "./modules/channels/channels.routes";
import { registerSettingsRoutes } from "./modules/warehouse/settings.routes";
import { registerPurchasingRoutes } from "./modules/procurement/procurement.routes";
import { registerEbayOAuthRoutes } from "./routes/ebay-oauth.routes";
import { registerEbaySettingsRoutes } from "./routes/ebay-settings.routes";
import { registerEbayListingRulesRoutes } from "./routes/ebay-listing-rules.routes";
import { registerEbayChannelRoutes } from "./routes/ebay-channel.routes";
import { registerSyncControlRoutes } from "./modules/channels/sync-control.routes";
import { registerOmsRoutes } from "./routes/oms.routes";
import { registerDropshipAdminRoutes } from "./modules/dropship/admin.routes";
import { registerVendorAuthRoutes } from "./modules/dropship/vendor-auth.routes";
import { registerVendorPortalRoutes, registerStripeWebhookRoute } from "./modules/dropship/vendor-portal.routes";
import { registerVendorEbayRoutes } from "./modules/dropship/vendor-ebay.routes";
import { registerSubscriptionWebhookRoutes } from "./modules/subscriptions/subscription.webhooks";
import { registerSubscriptionRoutes } from "./modules/subscriptions/subscription.routes";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedRBAC();
  await seedDefaultChannels();
  await seedAdjustmentReasons();

  // Subscription webhooks BEFORE auth middleware (unauthenticated, HMAC-verified)
  registerSubscriptionWebhookRoutes(app);

  registerAuthRoutes(app);
  registerLocationRoutes(app);
  registerPickingRoutes(app);
  registerShopifyRoutes(app);
  registerWarehouseRoutes(app);
  registerProductRoutes(app);
  registerInventoryRoutes(app);
  registerChannelRoutes(app);
  registerSettingsRoutes(app);
  registerPurchasingRoutes(app);
  registerEbayOAuthRoutes(app);
  registerEbaySettingsRoutes(app);
  registerEbayListingRulesRoutes(app);
  registerEbayChannelRoutes(app);
  registerSyncControlRoutes(app);
  registerOmsRoutes(app);

  // Dropship platform routes
  registerDropshipAdminRoutes(app);    // behind Echelon admin auth
  registerVendorAuthRoutes(app);       // public (login/register)
  registerVendorPortalRoutes(app);     // behind vendor JWT auth
  registerVendorEbayRoutes(app);       // vendor eBay OAuth + listing push
  registerStripeWebhookRoute(app);     // Stripe webhook (public, signature-verified)
  registerSubscriptionRoutes(app);     // Subscription admin routes (behind auth)

  return httpServer;
}
