/**
 * Capability-scoped public API for `warehouse.*` table mutations delegated by
 * peer modules (`catalog`, `channels`, `inventory`, `orders`, and `server/seed.ts`)
 * so `modules/warehouse` is the sole writer on `warehouse.echelon_settings`,
 * `warehouse.product_locations`, `warehouse.warehouse_locations`, and
 * `warehouse.warehouses`.
 */
export {
  upsertSyncEchelonSettingInWarehouse,
  deleteProductLocationsByVariantIdInWarehouse,
  updateProductLocationsSkuByVariantIdInWarehouse,
  reassignProductLocationsToVariantInWarehouse,
  mergeVariantProductLocationsInTx,
  deleteProductLocationsBySkusInTx,
  updateAutoFixedPickProductLocationInTx,
  insertAutoFixedPickProductLocationInTx,
  seedSampleProductLocationsInWarehouse,
  insertBackfillDefaultWarehouseLocationInWarehouse,
  unfreezeWarehouseLocationsForCycleCountInWarehouse,
  freezeWarehouseLocationsChunkForCycleCountInWarehouse,
  releaseStaleCycleCountLocationFreezesInWarehouse,
  insertVirtual3plWarehouseLocationInWarehouse,
  insertInterwarehouseTransitLocationInWarehouse,
  closeInterwarehouseTransitLocationInWarehouse,
  updateWarehouseFeedEnabledInWarehouse,
  updateWarehouseInventorySyncStatusInWarehouse,
} from "./infrastructure/cross-module-warehouse-mutations.repository";
