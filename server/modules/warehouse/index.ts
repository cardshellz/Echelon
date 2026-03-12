/**
 * @echelon/warehouse — Physical locations, zones, bin assignment, settings
 *
 * Tables owned: warehouses, warehouseZones, warehouseLocations, productLocations,
 *               echelonSettings, appSettings
 * Depends on: nothing (leaf module)
 */

// Storage
export { type IWarehouseStorage, warehouseMethods } from "./warehouse.storage";
export { type IProductLocationStorage, productLocationMethods } from "./product-locations.storage";
export { type ISettingsStorage, settingsMethods } from "./settings.storage";

import { type IWarehouseStorage, warehouseMethods } from "./warehouse.storage";
import { type IProductLocationStorage, productLocationMethods } from "./product-locations.storage";
import { type ISettingsStorage, settingsMethods } from "./settings.storage";

export type WarehouseModuleStorage = IWarehouseStorage & IProductLocationStorage & ISettingsStorage;
export const warehouseStorage: WarehouseModuleStorage = {
  ...warehouseMethods,
  ...productLocationMethods,
  ...settingsMethods,
};

// Services
export { createBinAssignmentService } from "./bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "./bin-assignment.service";
