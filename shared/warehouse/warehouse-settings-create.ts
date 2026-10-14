/** Fields historically accepted by POST /api/warehouse-settings. Creation may
 * inherit these warehouse controls, but must not introduce a second writer for
 * purchasing forecast or automation policy merely by echoing a DEFAULT row. */
export const WAREHOUSE_SETTINGS_CREATE_FIELDS = [
  "warehouseId", "warehouseCode", "warehouseName", "replenMode", "shortPickAction", "autoGenerateTrigger",
  "inlineReplenMaxUnits", "inlineReplenMaxCases", "urgentReplenThreshold", "stockoutPriority", "minMaxPriority",
  "scheduledReplenIntervalMinutes", "scheduledReplenEnabled", "maxOrdersPerWave", "maxItemsPerWave", "waveAutoRelease",
  "postPickStatus", "pickMode", "requireScanConfirm", "pickingBatchSize", "autoReleaseDelayMinutes", "enableOrderCombining",
  "channelSyncEnabled", "channelSyncIntervalMinutes", "velocityLookbackDays", "replenQaDailyEnabled", "replenQaDailySampleLimit",
  "replenQaCooldownDays", "replenQaIncludePickBins", "replenQaIncludePalletLocations", "isActive",
] as const;
