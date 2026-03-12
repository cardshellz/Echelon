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

// Routes
export { registerWarehouseRoutes } from "./warehouse.routes";
export { registerLocationRoutes } from "./locations.routes";
export { registerSettingsRoutes } from "./settings.routes";

// Services
export { createBinAssignmentService } from "./bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "./bin-assignment.service";
