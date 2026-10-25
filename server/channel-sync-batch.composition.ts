import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { ChannelSyncBatchService } from "./modules/marketplace-listings/application/channel-sync-batch.service";
import { ChannelSyncBatchError } from "./modules/marketplace-listings/domain/channel-sync-batch";
import { PostgresChannelSyncBatchRepository } from "./modules/marketplace-listings/infrastructure/pg-channel-sync-batch.repository";
import { EbaySyncBatchAdapter } from "./modules/channels/adapters/ebay/ebay-sync-batch.adapter";
import { EBAY_CHANNEL_ID } from "./modules/channels/infrastructure/ebay-api-runtime";
import {
  ebayListingSyncRepository,
} from "./modules/channels/infrastructure/ebay-active-listing-sync";

import { selectIncludedEbaySyncProducts, syncChannelListings } from "./modules/channels/infrastructure/ebay-channel-listing-sync";

export function createChannelSyncBatchService(): ChannelSyncBatchService {
  const adapters = new Map([
    [
      EBAY_CHANNEL_ID,
      new EbaySyncBatchAdapter({
        channelId: EBAY_CHANNEL_ID,
        select: selectIncludedEbaySyncProducts,
        sync: syncChannelListings,
        status: ebayListingSyncRepository,
      }),
    ],
  ]);
  return new ChannelSyncBatchService({
    store: new PostgresChannelSyncBatchRepository(pool),
    adapter(channelId) {
      const adapter = adapters.get(channelId);
      if (!adapter)
        throw new ChannelSyncBatchError(
          "SYNC_CHANNEL_UNSUPPORTED",
          "Bulk sync is not available for this channel.",
          422,
        );
      return adapter;
    },
    now: () => new Date(),
    uuid: randomUUID,
  });
}
