/**
 * Capability-scoped public API for `channels.channels` and
 * `channels.channel_connections` configuration/seed mutations invoked by
 * `dropship` and `identity`.
 */
export {
  repairDropshipDefaultOmsChannelInTx,
  insertDropshipDefaultOmsChannelInTx,
  clearExistingDropshipOmsChannelAndConnectionMarkersInTx,
  markChannelAsDropshipOmsInTx,
  ensureDefaultShopifyChannelSeeded,
  listDropshipOmsChannelOptionsInTx,
  findDropshipDefaultOmsChannelIdInTx,
  lockDropshipOmsChannelByIdInTx,
} from "./infrastructure/channel-registry-mutations.repository";
