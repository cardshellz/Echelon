/**
 * @echelon/inventory — Core inventory, ATP, lots, replenishment, cycle counts
 *
 * Tables owned: inventoryLevels, inventoryTransactions, inventoryLots,
 *               replenRules, replenTierDefaults, locationReplenConfig, replenTasks,
 *               cycleCounts, cycleCountItems, warehouseSettings, adjustmentReasons
 * Depends on: catalog (variant lookups), warehouse (location lookups)
 */

// Storage
export { type IInventoryStorage, inventoryMethods } from "./infrastructure/inventory.repository";
export { type IReplenishmentStorage, replenishmentMethods } from "./infrastructure/replenishment.repository";
export { type ICycleCountStorage, cycleCountMethods } from "./infrastructure/cycle-count.repository";

import { type IInventoryStorage, inventoryMethods } from "./infrastructure/inventory.repository";
import { type IReplenishmentStorage, replenishmentMethods } from "./infrastructure/replenishment.repository";
import { type ICycleCountStorage, cycleCountMethods } from "./infrastructure/cycle-count.repository";

export type InventoryModuleStorage = IInventoryStorage & IReplenishmentStorage & ICycleCountStorage;
export const inventoryStorage: InventoryModuleStorage = {
  ...inventoryMethods,
  ...replenishmentMethods,
  ...cycleCountMethods,
};

// Use Cases (Replaces core.service and source.service)
export { InventoryUseCases } from "./application/inventory.use-cases";

// Services
export { createInventoryAtpService } from "./atp.service";
export { createInventoryLotService, InventoryLotService } from "./lots.service";
export { createInventoryAlertService } from "./alerts.service";
// Application Layer (Use Cases)
export { createReplenishmentService, ReplenishmentUseCases as ReplenishmentService } from "./application/replenishment.use-cases";
export { createCycleCountService, CycleCountUseCases as CycleCountService } from "./application/cycle-count.use-cases";
export { createBreakAssemblyService, BreakAssemblyUseCases as BreakAssemblyService } from "./application/break-assembly.use-cases";
export { createCOGSService, COGSService } from "./cogs.service";

// Service types
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary } from "./atp.service";
export type { BreakResult, AssembleResult, ConversionPreview } from "./application/break-assembly.use-cases";
export type { CycleCountUseCases, CycleCountError, ApproveResult, BulkApproveResult, ReconciliationPreview, TransferSuggestion, ReconciliationItem } from "./application/cycle-count.use-cases";
