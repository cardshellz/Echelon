/**
 * Published internal Inventory interface for Catalog workflows
 * (product/variant archive, variant merge, inventory tracking policy/history,
 * and catalog identity cleanup).
 */
export {
  ARCHIVABLE_REPLEN_TASK_STATUSES,
  archiveProductReplenishmentInTx,
  cancelProductReplenishmentTasksInTx,
  deactivateProductReplenishmentRulesInTx,
} from "./infrastructure/replenishment-archive.repository";
export {
  exportTrackingStopHistory,
  listTrackingStopHistory,
  loadTrackingStopSnapshot,
  retainTrackingStopHistory,
  trackingStopOperationalBlockers,
} from "./infrastructure/tracking-stop.repository";
export { correctProduct102CountIdentity } from "./infrastructure/product-102-count-identity.repository";
export { openOperationalQuantityPosting } from "./infrastructure/operational-quantity-posting";
export { lockInventoryCostGraph } from "./infrastructure/cost-evidence.repository";
export type { QuantityCommand } from "./domain/quantity-ledger";
export type { InventoryUseCases } from "./application/inventory.use-cases";
