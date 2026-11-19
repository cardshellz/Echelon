// Inventory owns the stock-update outbox. This published read port gives OMS
// operations health the refused (dead-lettered) channel stock updates without
// letting it read inventory tables or load the publication runtime.
export {
  channelStockUpdateDeadLetterDestinationCountSql,
  channelStockUpdateDeadLetterDestinationSampleSql,
} from "./infrastructure/channel-stock-update-dead-letter.sql";
