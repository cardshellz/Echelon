/**
 * @echelon/warehouse — Physical locations, zones, bin assignment, settings
 */

import * as repository from "./infrastructure/warehouse.repository";

// Unified Repository Instance
export const warehouseStorage = repository;

// Services (Pending use-case port)
export { createBinAssignmentService } from "./bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "./bin-assignment.service";
