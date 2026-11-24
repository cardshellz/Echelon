/**
 * Capability-scoped public API for `inventory.*` table mutations delegated by
 * peer modules (`identity`, `catalog`, `channels`, `orders`, `procurement`, and
 * repair scripts) so `modules/inventory` is the sole writer on
 * `inventory.adjustment_reasons`, `inventory.inventory_levels`,
 * `inventory.inventory_transactions`, `inventory.replen_tasks`, and
 * `inventory.warehouse_settings`.
 */
export {
  seedDefaultAdjustmentReasonsInInventory,
  deleteZeroPreLedgerInventoryLevelsByVariantIdInInventory,
  deleteZeroInventoryLevelsByVariantIdInTx,
  insertShopifyBackfillInventoryLevelAndReceiptTxnInInventory,
  insertOrphanedReservationUnreserveTransactionInInventory,
  repairOrphanedPickedInventoryLevelInTx,
  cancelShipmentBlockingReplenTasksForOrderInInventory,
  updateWarehouseOrderCombiningSettingInInventory,
  insertWarehouseOrderCombiningSettingInInventory,
  updateDefaultOrderCombiningSettingInInventory,
  insertDefaultOrderCombiningSettingInInventory,
  updateDefaultProcurementPolicySettingsWithCasInTx,
  updateWarehouseAutoDraftAndForecastSettingsInTx,
  relocateSlotReplenPointersInInventory,
} from "./infrastructure/cross-module-inventory-mutations.repository";
