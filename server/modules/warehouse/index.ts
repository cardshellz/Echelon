/**
 * @echelon/warehouse — Physical locations, zones, bin assignment, settings
 */

import * as repository from "./infrastructure/warehouse.repository";

// Unified Repository Instance
export const warehouseStorage = repository;

// Audited preparation of existing warehouses for inventory publication setup.
export { WarehouseInventorySourceService } from "./application/warehouse-inventory-source.service";
export { PostgresWarehouseInventorySourceStore } from "./infrastructure/warehouse-inventory-source.repository";
export { WarehouseInventorySourceError } from "./domain/warehouse-inventory-source";

// Internal API Boundaries (CI-03)
export * from "./bin-assignment.api";
export * from "./inventory-governance.api";
export * from "./cutover-work.api";
export {
  getReplenishmentSettingsForWarehouse,
  getSettingsForWarehouse,
  getSlaCutoffConfig,
  type SlaCutoffConfig,
} from "./settings.resolver";
export { selectPickBinCandidate } from "./pick-bin-candidate";
