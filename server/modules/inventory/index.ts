/**
 * @echelon/inventory — Core inventory, ATP, lots, replenishment, cycle counts
 *
 * Tables owned: inventoryLevels, inventoryTransactions, inventoryLots,
 *               replenRules, replenTierDefaults, locationReplenConfig, replenTasks,
 *               cycleCounts, cycleCountItems, warehouseSettings, adjustmentReasons
 * Depends on: catalog (variant lookups), warehouse (location lookups)
 */

// Storage
export { type IInventoryStorage, inventoryMethods } from "./inventory.storage";
export { type IReplenishmentStorage, replenishmentMethods } from "./replenishment.storage";
export { type ICycleCountStorage, cycleCountMethods } from "./cycle-counts.storage";

import { type IInventoryStorage, inventoryMethods } from "./inventory.storage";
import { type IReplenishmentStorage, replenishmentMethods } from "./replenishment.storage";
import { type ICycleCountStorage, cycleCountMethods } from "./cycle-counts.storage";

export type InventoryModuleStorage = IInventoryStorage & IReplenishmentStorage & ICycleCountStorage;
export const inventoryStorage: InventoryModuleStorage = {
  ...inventoryMethods,
  ...replenishmentMethods,
  ...cycleCountMethods,
};

// Services
export { createInventoryCoreService } from "./core.service";
export { createInventoryAtpService } from "./atp.service";
export { createInventoryLotService } from "./lots.service";
export { createInventoryAlertService } from "./alerts.service";
export { createInventorySourceService } from "./source.service";
export { createReplenishmentService } from "./replen.service";
export { createCycleCountService } from "./cycle-count.service";
export { createBreakAssemblyService } from "./break-assembly.service";
export { createCOGSService } from "./cogs.service";
export type { COGSService } from "./cogs.service";

// Service types
export type { InventoryCoreService } from "./core.service";
export type { InventoryLotService } from "./lots.service";
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary } from "./atp.service";
export type { BreakResult, AssembleResult, ConversionPreview } from "./break-assembly.service";
export type { SyncResult as InventorySourceSyncResult } from "./source.service";
export type { CycleCountService, CycleCountError, ApproveResult, BulkApproveResult, ReconciliationPreview, TransferSuggestion, ReconciliationItem } from "./cycle-count.service";
