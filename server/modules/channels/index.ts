/**
 * @echelon/channels — Multi-channel distribution, feeds, reservations, sync
 *
 * Tables owned: channels, channelConnections, partnerProfiles, channelFeeds,
 *               channelReservations, channelProductAllocation, channelSyncLog,
 *               channelProductOverrides, channelVariantOverrides, channelPricing,
 *               channelListings, channelAssetOverrides, channelProductLines,
 *               sourceLockConfig, allocationAuditLog
 * Depends on: catalog, inventory (ATP queries only)
 */

// Storage
export { ChannelIdentityService } from "./channel-identity.service";
export { ChannelIdentityError } from "./channel-identity.domain";
export type { ChannelItemIdentity } from "./channel-identity.domain";
export { type IChannelStorage, channelMethods } from "./channels.storage";
export { type IChannelCatalogStorage } from "./channel-catalog.storage";

import { type IChannelStorage, channelMethods } from "./channels.storage";
import { type IChannelCatalogStorage, channelCatalogMethods } from "./channel-catalog.storage";

export type ChannelsModuleStorage = IChannelStorage & IChannelCatalogStorage;
export const channelsStorage: ChannelsModuleStorage = {
  ...channelMethods,
  ...channelCatalogMethods,
};

// Internal API Facades (CI-03 / CHN-2)
export * from "./product-identity.api";
export * from "./ebay-maintenance-evidence.api";
export * from "./shopify-identity.api";
export * from "./ebay-connector.api";

// Service types
export type { SyncResult, ChannelSyncServiceContract } from "./sync.service";
export type { ReservationResult, ReservationInventoryCore } from "./reservation.service";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "./product-push.service";

export interface ChannelsApi {
  readonly channelSync: import("./sync.service").ChannelSyncServiceContract;
  readonly channelProductPush: import("./product-push.service").ChannelProductPushService;
  readonly syncSettings: import("./sync-settings.service").SyncSettingsService;
  readonly allocationEngine: import("./allocation-engine.service").AllocationEngine;
  readonly sourceLockService: import("./source-lock.service").SourceLockService;
}

// Channel Adapter Interface (Phase 1)
export type {
  IChannelAdapter,
  ChannelListingPayload,
  ListingPushResult,
  InventoryPushItem,
  InventoryPushResult,
  PricingPushItem,
  PricingPushResult,
  ChannelOrder,
  ChannelOrderLineItem,
  OrderIngestionResult,
  FulfillmentPayload,
  FulfillmentPushResult,
  CancellationPayload,
  CancellationPushResult,
  ChannelOrderAdapter,
  ChannelOrderNormalizeContext,
  ChannelWebhookVerifyInput,
  ChannelWebhookVerifyResult,
  ValidatedChannelCancelEvent,
  ValidatedChannelOrder,
  ValidatedChannelOrderLine,
  ValidatedChannelRefundEvent,
} from "./channel-adapter.interface";
export {
  ChannelAdapterRegistry,
  ChannelOrderAdapterRegistry,
  ChannelOrderBoundaryValidationError,
  channelIntakeCancelSchema,
  channelIntakeOrderLineSchema,
  channelIntakeOrderSchema,
  channelIntakeRefundSchema,
  parseValidatedChannelCancel,
  parseValidatedChannelOrder,
  parseValidatedChannelRefund,
} from "./channel-adapter.interface";

// Source Lock System (Phase 1)
export { createSourceLockService } from "./source-lock.service";
export type { SourceLockService } from "./source-lock.service";

// Allocation Engine (Phase 1)
export { createAllocationEngine } from "./allocation-engine.service";
export type { AllocationEngine, AllocationVelocity, ProductAllocationResult, VariantChannelAllocation } from "./allocation-engine.service";
export {
  ALLOCATION_ERROR_CODES,
  AllocationEngineError,
  describeAllocationFailure,
  isAllocationEngineError,
} from "./allocation-engine.errors";
export type { AllocationEngineErrorClassification, AllocationErrorCode } from "./allocation-engine.errors";

// Shopify Adapter (Phase 1)
export { ShopifyAdapter, createShopifyAdapter } from "./adapters/shopify.adapter";

// Phase 2: Source-of-Truth Wiring
export { createCatalogBackfillService } from "./catalog-backfill.service";
export type { CatalogBackfillService, BackfillOptions, BackfillResult } from "./catalog-backfill.service";

export { runShopifyWeightBackfill, createShopifyWeightBackfillDeps, toGrams } from "./shopify-weight-backfill.service";
export type {
  ShopifyWeightBackfillOptions,
  ShopifyWeightBackfillReport,
  ShopifyWeightBackfillDeps,
  WeightBackfillCandidate,
  ShopifyWeightMeasurement,
} from "./shopify-weight-backfill.service";

export { createEchelonSyncOrchestrator } from "./echelon-sync-orchestrator.service";
export type {
  EchelonSyncOrchestrator,
  SyncOrchestratorConfig,
  InventorySyncResult,
  PricingSyncResult,
  ListingSyncResult,
  FullSyncResult,
} from "./echelon-sync-orchestrator.service";

export { createScheduledSyncService } from "./scheduled-sync.service";
export type { ScheduledSyncService, ScheduledSyncConfig, ScheduledSyncStatus } from "./scheduled-sync.service";

export { initializeSourceLockDefaults, initializeAllChannelDefaults } from "./source-lock-init";
