/**
 * Public eBay channel administration, listing-rule, taxonomy, and listing-state mutation contracts.
 */
export {
  deleteEbayListingRuleRecord,
  insertDefaultEbayChannelConnection,
  insertEbayListingRuleRecord,
  markChannelListingReconcileDeleted,
  markChannelListingReconcileEnded,
  markChannelVariantListingPendingForRelist,
  markChannelVariantListingSyncError,
  markChannelVariantListingZeroed,
  mergeEbayChannelConnectionMerchantLocation,
  replaceEbayCategoryAspects,
  replaceEbayProductAspectOverrides,
  replaceEbayTypeAspectDefaults,
  updateEbayListingRuleRecord,
  upsertChannelVariantListedOverrideInTx,
  upsertEbayCategoryTypeListingEnabled,
  type EbayCategoryAspectSeedItem,
} from "./infrastructure/ebay-route-admin.repository";
