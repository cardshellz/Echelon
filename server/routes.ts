import type { Express } from "express";
import { createServer, type Server } from "http";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons } from "./modules/identity";

import { registerAuthRoutes } from "./modules/identity/identity.routes";
import { registerLocationRoutes } from "./modules/warehouse/locations.routes";
import { registerPickingRoutes } from "./modules/orders/picking.routes";
import { registerShopifyRoutes } from "./routes/shopify.routes";
import { registerWarehouseRoutes } from "./modules/warehouse/warehouse.routes";
import { registerProductRoutes } from "./modules/catalog/catalog.routes";
import { registerInventoryRoutes } from "./modules/inventory/inventory.routes";
import { registerChannelRoutes } from "./modules/channels/channels.routes";
import { registerSettingsRoutes } from "./modules/warehouse/settings.routes";
import { registerPickZoneRoutes } from "./modules/warehouse/pick-zones.routes";
import { registerPurchasingRoutes } from "./modules/procurement/procurement.routes";
import { registerEbayOAuthRoutes } from "./routes/ebay-oauth.routes";
import { registerEbaySettingsRoutes } from "./routes/ebay-settings.routes";
import { registerEbayListingRulesRoutes } from "./routes/ebay-listing-rules.routes";
import { router as ebayConfigRouter } from "./routes/ebay/ebay-config.routes";
import { router as ebayTaxonomyRouter } from "./routes/ebay/ebay-taxonomy.routes";
import { router as ebayListingsRouter } from "./routes/ebay/ebay-listings.routes";
import { router as ebayPricingRouter } from "./routes/ebay/ebay-pricing.routes";
import { router as ebayPoliciesRouter } from "./routes/ebay/ebay-policies.routes";
import { registerSyncControlRoutes } from "./modules/channels/sync-control.routes";
import { registerOmsRoutes } from "./routes/oms.routes";
import { registerSubscriptionWebhookRoutes } from "./modules/subscriptions/subscription.webhooks";
import { registerSubscriptionRoutes } from "./modules/subscriptions/subscription.routes";
import { registerDiagnosticsRoutes } from "./routes/diagnostics";
import { registerPickPriorityRoutes } from "./routes/pick-priority.routes";

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
  await registerProductRoutes(app);
  registerInventoryRoutes(app);
  registerChannelRoutes(app);
  registerSettingsRoutes(app);
  registerPickZoneRoutes(app);
  registerPurchasingRoutes(app);
  registerEbayOAuthRoutes(app);
  registerEbaySettingsRoutes(app);
  registerEbayListingRulesRoutes(app);
  app.use(ebayConfigRouter);
  app.use(ebayTaxonomyRouter);
  app.use(ebayListingsRouter);
  app.use(ebayPricingRouter);
  app.use(ebayPoliciesRouter);
  registerSyncControlRoutes(app);
  registerOmsRoutes(app);

  // Dropship V2 routes register after the new use-case layer replaces the Phase 0 prototype.
  registerSubscriptionRoutes(app);     // Subscription admin routes (behind auth)
  registerPickPriorityRoutes(app);     // Pick priority settings (admin-only)
  registerDiagnosticsRoutes(app);      // System diagnostics (admin-only)

  return httpServer;
}
