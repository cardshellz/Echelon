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
export { type IChannelStorage, channelMethods } from "./channels.storage";
export { type IChannelCatalogStorage, channelCatalogMethods } from "./channel-catalog.storage";

import { type IChannelStorage, channelMethods } from "./channels.storage";
import { type IChannelCatalogStorage, channelCatalogMethods } from "./channel-catalog.storage";

export type ChannelsModuleStorage = IChannelStorage & IChannelCatalogStorage;
export const channelsStorage: ChannelsModuleStorage = {
  ...channelMethods,
  ...channelCatalogMethods,
};

// Service types
export type { SyncResult } from "./sync.service";
export type { ReservationResult } from "./reservation.service";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "./product-push.service";

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
} from "./channel-adapter.interface";
export { ChannelAdapterRegistry } from "./channel-adapter.interface";

// Source Lock System (Phase 1)
export { createSourceLockService } from "./source-lock.service";
export type { SourceLockService } from "./source-lock.service";

// Allocation Engine (Phase 1)
export { createAllocationEngine } from "./allocation-engine.service";
export type { AllocationEngine, ProductAllocationResult, VariantChannelAllocation } from "./allocation-engine.service";

// Shopify Adapter (Phase 1)
export { ShopifyAdapter, createShopifyAdapter } from "./adapters/shopify.adapter";

// Phase 2: Source-of-Truth Wiring
export { createCatalogBackfillService } from "./catalog-backfill.service";
export type { CatalogBackfillService, BackfillOptions, BackfillResult } from "./catalog-backfill.service";

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
