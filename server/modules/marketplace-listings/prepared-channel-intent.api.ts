/** Published preparation contract. Execution, receipts, and stock remain with
 * their existing workflow owners during the Phase 2 adoption. */
export { prepareChannelIntent, assertPreparedChannelIntent, preparedChannelIntentHash,
  ChannelPreparedIntentError } from "./domain/prepared-channel-intent";
export type { ChannelIntentAccount, ChannelPreparedIntent, ChannelPreparedIntentInput,
  ChannelPreparedMember } from "@shared/types/channel-prepared-intent";
