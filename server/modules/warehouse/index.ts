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

// Services (Pending use-case port)
export { createBinAssignmentService } from "./bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "./bin-assignment.service";
