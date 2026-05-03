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
import { registerDropshipAuthRoutes } from "./modules/dropship/interfaces/http/dropship-auth.routes";
import { registerDropshipAdminCatalogRoutes } from "./modules/dropship/interfaces/http/dropship-admin-catalog.routes";
import { registerDropshipAdminStoreConnectionRoutes } from "./modules/dropship/interfaces/http/dropship-admin-store-connection.routes";
import { registerDropshipAdminOrderOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-order-ops.routes";
import { registerDropshipAdminListingPushOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-listing-push-ops.routes";
import { registerDropshipAdminTrackingPushOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-tracking-push-ops.routes";
import { registerDropshipAdminNotificationOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-notification-ops.routes";
import { registerDropshipAdminShippingConfigRoutes } from "./modules/dropship/interfaces/http/dropship-admin-shipping-config.routes";
import { registerDropshipAdminOmsChannelConfigRoutes } from "./modules/dropship/interfaces/http/dropship-admin-oms-channel-config.routes";
import { registerDropshipVendorCatalogRoutes } from "./modules/dropship/interfaces/http/dropship-vendor-catalog.routes";
import { registerDropshipOnboardingRoutes } from "./modules/dropship/interfaces/http/dropship-onboarding.routes";
import { registerDropshipStoreConnectionRoutes } from "./modules/dropship/interfaces/http/dropship-store-connection.routes";
import { registerDropshipShippingRoutes } from "./modules/dropship/interfaces/http/dropship-shipping.routes";
import { registerDropshipListingRoutes } from "./modules/dropship/interfaces/http/dropship-listing.routes";
import { registerDropshipListingConfigRoutes } from "./modules/dropship/interfaces/http/dropship-listing-config.routes";
import { registerDropshipWalletRoutes } from "./modules/dropship/interfaces/http/dropship-wallet.routes";
import { registerDropshipOrderRoutes } from "./modules/dropship/interfaces/http/dropship-order.routes";
import { registerDropshipNotificationRoutes } from "./modules/dropship/interfaces/http/dropship-notification.routes";
import { registerDropshipReturnRoutes } from "./modules/dropship/interfaces/http/dropship-return.routes";
import { registerDropshipOpsSurfaceRoutes } from "./modules/dropship/interfaces/http/dropship-ops-surface.routes";

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
  registerDropshipAuthRoutes(app);
  registerDropshipAdminCatalogRoutes(app);
  registerDropshipAdminStoreConnectionRoutes(app);
  registerDropshipAdminOrderOpsRoutes(app);
  registerDropshipAdminListingPushOpsRoutes(app);
  registerDropshipAdminTrackingPushOpsRoutes(app);
  registerDropshipAdminNotificationOpsRoutes(app);
  registerDropshipAdminShippingConfigRoutes(app);
  registerDropshipAdminOmsChannelConfigRoutes(app);
  registerDropshipVendorCatalogRoutes(app);
  registerDropshipOnboardingRoutes(app);
  registerDropshipStoreConnectionRoutes(app);
  registerDropshipListingConfigRoutes(app);
  registerDropshipShippingRoutes(app);
  registerDropshipWalletRoutes(app);
  registerDropshipOrderRoutes(app);
  registerDropshipNotificationRoutes(app);
  registerDropshipReturnRoutes(app);
  registerDropshipOpsSurfaceRoutes(app);
  registerDropshipListingRoutes(app);
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
