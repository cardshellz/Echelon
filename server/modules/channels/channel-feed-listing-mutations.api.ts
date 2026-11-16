/**
 * Capability-scoped public API for `channels.channel_feeds` and
 * `channels.channel_listings` mutations delegated by `catalog` and `inventory`.
 */
export {
  updateChannelFeedByIdInChannels,
  insertChannelFeedInChannels,
  updateChannelFeedSyncStatusByIdInChannels,
  deactivateActiveChannelFeedsByVariantIdInChannels,
  deactivateAllChannelFeedsByVariantIdInChannels,
  upsertShopifyVariantFeedAndListingLinkInTx,
  disableShopifyVariantFeedsAndResetListingsInTx,
  disableDelistedShopifyVariantFeedAndListingInTx,
  upsertRepairedShopifyVariantFeedAndListingInTx,
} from "./infrastructure/channel-feed-listing-mutations.repository";
