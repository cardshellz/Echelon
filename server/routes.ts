import type { Express } from "express";
import { createServer, type Server } from "http";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons } from "./modules/identity";

import { registerAuthRoutes } from "./modules/identity/identity.routes";
import { registerLocationRoutes } from "./modules/warehouse/locations.routes";
import { registerPickingRoutes } from "./modules/orders/picking.routes";
import { registerOperationsDashboardRoutes } from "./modules/orders/operations-dashboard.routes";
import { registerOperationsControlTowerRoutes } from "./modules/operations/control-tower.routes";
import { registerFinancialCommandOperationsRoutes } from "./platform/commands/financial-command-operations.routes";
import { registerShopifyRoutes } from "./routes/shopify.routes";
import { registerWarehouseRoutes } from "./modules/warehouse/warehouse.routes";
import { registerProductRoutes } from "./modules/catalog/catalog.routes";
import { registerCatalogExportRoutes } from "./modules/catalog-export/interfaces/http/catalog-export.routes";
import { registerInventoryRoutes } from "./modules/inventory/inventory.routes";
import { registerReplenishmentRoutes } from "./modules/inventory";
import { registerBuildRoutes } from "./modules/inventory/build.routes";
import { registerNotificationRoutes } from "./modules/notifications";
import { registerFinanceAnalyticsRoutes } from "./modules/oms/finance-analytics.routes";
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
import { createMarketplaceListingRegistrationResolverFromEnv } from "./marketplace-listing-registration.composition";
import { registerMarketplaceListingRegistrationRoutes } from "./modules/marketplace-listings/interfaces/http/listing-registration.routes";
import { createMarketplaceListingReplacementResolverFromEnv } from "./marketplace-listing-replacement.composition";
import { registerMarketplaceListingReplacementRoutes } from "./modules/marketplace-listings/interfaces/http/listing-replacement.routes";
import { registerDropshipAuthRoutes } from "./modules/dropship/interfaces/http/dropship-auth.routes";
import { registerDropshipAdminCatalogRoutes } from "./modules/dropship/interfaces/http/dropship-admin-catalog.routes";
import { registerDropshipAdminStoreConnectionRoutes } from "./modules/dropship/interfaces/http/dropship-admin-store-connection.routes";
import { registerDropshipAdminOrderOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-order-ops.routes";
import { registerDropshipAdminListingPushOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-listing-push-ops.routes";
import { registerDropshipAdminTrackingPushOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-tracking-push-ops.routes";
import { registerDropshipAdminNotificationOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-notification-ops.routes";
import { registerDropshipAdminShippingConfigRoutes } from "./modules/dropship/interfaces/http/dropship-admin-shipping-config.routes";
import { registerDropshipAdminCarrierProtectionRoutes } from "./modules/dropship/interfaces/http/dropship-admin-carrier-protection.routes";
import { registerDropshipAdminCarrierClaimRoutes } from "./modules/dropship/interfaces/http/dropship-admin-carrier-claim.routes";
import { registerDropshipAdminReturnPolicyRoutes } from "./modules/dropship/interfaces/http/dropship-admin-return-policy.routes";
import { registerDropshipAdminOmsChannelConfigRoutes } from "./modules/dropship/interfaces/http/dropship-admin-oms-channel-config.routes";
import { registerDropshipAdminWorkerOpsRoutes } from "./modules/dropship/interfaces/http/dropship-admin-worker-ops.routes";
import { registerDropshipVendorCatalogRoutes } from "./modules/dropship/interfaces/http/dropship-vendor-catalog.routes";
import { registerDropshipOnboardingRoutes } from "./modules/dropship/interfaces/http/dropship-onboarding.routes";
import { registerDropshipStoreConnectionRoutes } from "./modules/dropship/interfaces/http/dropship-store-connection.routes";
import { registerDropshipShippingRoutes } from "./modules/dropship/interfaces/http/dropship-shipping.routes";
import { registerDropshipListingRoutes } from "./modules/dropship/interfaces/http/dropship-listing.routes";
import { registerDropshipEbayStoreCategoryRoutes } from "./modules/dropship/interfaces/http/dropship-ebay-store-category.routes";
import { registerDropshipEbayListingSetupRoutes } from "./modules/dropship/interfaces/http/dropship-ebay-listing-setup.routes";
import { registerDropshipEbayListingPolicyOverrideRoutes } from "./modules/dropship/interfaces/http/dropship-ebay-listing-policy-override.routes";
import { registerDropshipListingConfigRoutes } from "./modules/dropship/interfaces/http/dropship-listing-config.routes";
import { registerDropshipWalletRoutes } from "./modules/dropship/interfaces/http/dropship-wallet.routes";
import { registerDropshipOrderRoutes } from "./modules/dropship/interfaces/http/dropship-order.routes";
import { registerDropshipNotificationRoutes } from "./modules/dropship/interfaces/http/dropship-notification.routes";
import { registerDropshipReturnRoutes } from "./modules/dropship/interfaces/http/dropship-return.routes";
import { registerReturnPolicyAdminRoutes } from "./modules/returns/interfaces/http/return-policy-admin.routes";
import { registerReturnCaseAdminRoutes } from "./modules/returns/interfaces/http/return-case-admin.routes";
import { registerDropshipOpsSurfaceRoutes } from "./modules/dropship/interfaces/http/dropship-ops-surface.routes";
import { registerDropshipMarketplaceOrderIntakeRoutes } from "./modules/dropship/interfaces/http/dropship-marketplace-order-intake.routes";
import { registerShippingAdminRoutes } from "./modules/shipping-engine/shipping-admin.routes";
import { registerOutboundShipmentRoutes } from "./modules/shipping-engine/outbound-shipments.routes";
import { registerCarrierCallbackRoutes } from "./modules/shipping-engine/interfaces/http/carrier-callback.routes";
import { registerShadowAdminRoutes } from "./modules/shipping-engine/interfaces/http/shadow-admin.routes";
import { registerPackingRoutes } from "./modules/shipping-engine/interfaces/http/packing.routes";
import { registerRateTableAdminRoutes } from "./modules/shipping-engine/interfaces/http/rate-table-admin.routes";
import { registerRateBookAdminRoutes } from "./modules/shipping-engine/interfaces/http/rate-book-admin.routes";
import { registerRateProgramCloneRoutes } from "./modules/shipping-engine/interfaces/http/rate-program-clone.routes";
import { registerProductRatePolicyAdminRoutes } from "./modules/shipping-engine/interfaces/http/product-rate-policy-admin.routes";
import { registerManualRateQuoteRoutes } from "./modules/shipping-engine/interfaces/http/manual-rate-quote.routes";
import { registerChannelShippingPolicyAdminRoutes } from "./modules/shipping-engine/interfaces/http/channel-shipping-policy-admin.routes";
import { registerStorefrontRatePreviewRoutes } from "./modules/shipping-engine/interfaces/http/storefront-rate-preview.routes";
import { registerDestinationScopeReaderRoutes } from "./modules/shipping-engine/interfaces/http/destination-scope-reader.routes";
import { registerInventoryAvailabilityMasterDataRoutes } from "./modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes";
import { registerInventoryAvailabilityShadowRoutes } from "./modules/inventory-planning/interfaces/http/inventory-availability-shadow.routes";
import { registerInventoryAvailabilityBackfillRoutes } from "./modules/inventory-planning/interfaces/http/inventory-availability-backfill.routes";
import { registerInventoryAvailabilityPhase4Routes } from "./modules/inventory-planning/interfaces/http/inventory-availability-phase4.routes";
import { registerInventoryChannelExposureRoutes } from "./modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes";
import { registerShippingDestinationNormalizationRoutes } from "./modules/shipping-engine/interfaces/http/shipping-destination-normalization.routes";
import { registerFulfillmentRoutingAdminRoutes } from "./modules/shipping-engine/interfaces/http/fulfillment-routing-admin.routes";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedRBAC();
  await seedDefaultChannels();
  await seedAdjustmentReasons();

  // Subscription webhooks BEFORE auth middleware (unauthenticated, HMAC-verified)
  registerSubscriptionWebhookRoutes(app);
  // Shopify CarrierService rate callback BEFORE auth middleware (unauthenticated,
  // webhook-style; token-gated — 404s unless SHIPPING_CALLBACK_TOKEN is set).
  registerCarrierCallbackRoutes(app);
  registerDropshipMarketplaceOrderIntakeRoutes(app);

  registerAuthRoutes(app);
  registerDropshipAuthRoutes(app);
  registerDropshipAdminCatalogRoutes(app);
  registerDropshipAdminStoreConnectionRoutes(app);
  registerDropshipAdminOrderOpsRoutes(app);
  registerDropshipAdminListingPushOpsRoutes(app);
  registerDropshipAdminTrackingPushOpsRoutes(app);
  registerDropshipAdminNotificationOpsRoutes(app);
  registerDropshipAdminShippingConfigRoutes(app);
  registerDropshipAdminCarrierProtectionRoutes(app);
  registerDropshipAdminCarrierClaimRoutes(app);
  registerDropshipAdminReturnPolicyRoutes(app);
  registerShippingAdminRoutes(app);
  registerFulfillmentRoutingAdminRoutes(app);
  registerShadowAdminRoutes(app);
  registerPackingRoutes(app);
  registerRateTableAdminRoutes(app);
  registerRateBookAdminRoutes(app);
  registerRateProgramCloneRoutes(app);
  registerProductRatePolicyAdminRoutes(app);
  registerChannelShippingPolicyAdminRoutes(app);
  registerManualRateQuoteRoutes(app);
  registerStorefrontRatePreviewRoutes(app);
  registerDestinationScopeReaderRoutes(app);
  registerInventoryAvailabilityMasterDataRoutes(app);
  registerInventoryAvailabilityShadowRoutes(app);
  registerInventoryAvailabilityBackfillRoutes(app);
  registerInventoryAvailabilityPhase4Routes(app);
  registerInventoryChannelExposureRoutes(app);
  registerShippingDestinationNormalizationRoutes(app);
  registerOutboundShipmentRoutes(app);
  registerDropshipAdminOmsChannelConfigRoutes(app);
  registerDropshipAdminWorkerOpsRoutes(app);
  registerDropshipVendorCatalogRoutes(app);
  registerDropshipOnboardingRoutes(app);
  registerDropshipStoreConnectionRoutes(app);
  registerDropshipListingConfigRoutes(app);
  registerDropshipShippingRoutes(app);
  registerDropshipWalletRoutes(app);
  registerDropshipOrderRoutes(app);
  registerDropshipNotificationRoutes(app);
  registerDropshipReturnRoutes(app);
  registerReturnPolicyAdminRoutes(app);
  registerReturnCaseAdminRoutes(app);
  registerDropshipOpsSurfaceRoutes(app);
  registerDropshipListingRoutes(app);
  registerDropshipEbayListingSetupRoutes(app);
  registerDropshipEbayListingPolicyOverrideRoutes(app);
  registerDropshipEbayStoreCategoryRoutes(app);
  registerLocationRoutes(app);
  registerPickingRoutes(app);
  registerOperationsDashboardRoutes(app);
  registerOperationsControlTowerRoutes(app);
  registerFinancialCommandOperationsRoutes(app);
  registerShopifyRoutes(app);
  registerWarehouseRoutes(app);
  await registerProductRoutes(app);
  registerCatalogExportRoutes(app);
  registerInventoryRoutes(app);
  registerReplenishmentRoutes(app);
  registerBuildRoutes(app);
  registerChannelRoutes(app);
  registerMarketplaceListingRegistrationRoutes(
    app,
    createMarketplaceListingRegistrationResolverFromEnv(),
  );
  registerMarketplaceListingReplacementRoutes(
    app,
    createMarketplaceListingReplacementResolverFromEnv(),
  );
  registerSettingsRoutes(app);
  registerPickZoneRoutes(app);
  registerPurchasingRoutes(app);
  registerNotificationRoutes(app);
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
  registerFinanceAnalyticsRoutes(app);

  // Dropship V2 routes register after the new use-case layer replaces the Phase 0 prototype.
  registerSubscriptionRoutes(app);     // Subscription admin routes (behind auth)
  registerPickPriorityRoutes(app);     // Pick priority settings (admin-only)
  registerDiagnosticsRoutes(app);      // System diagnostics (admin-only)

  return httpServer;
}
