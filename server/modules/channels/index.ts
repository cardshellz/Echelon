/**
 * @echelon/channels — Multi-channel distribution, feeds, reservations, sync
 *
 * Tables owned: channels, channelConnections, partnerProfiles, channelFeeds,
 *               channelReservations, channelProductAllocation, channelSyncLog,
 *               channelProductOverrides, channelVariantOverrides, channelPricing,
 *               channelListings, channelAssetOverrides, channelProductLines
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

// Routes
export { registerChannelRoutes } from "./channels.routes";

// Services
export { createChannelSyncService } from "./sync.service";
export { createChannelProductPushService } from "./product-push.service";
export { createReservationService } from "./reservation.service";

// Service types
export type { SyncResult } from "./sync.service";
export type { ReservationResult } from "./reservation.service";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "./product-push.service";
