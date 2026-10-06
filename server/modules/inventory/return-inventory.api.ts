/** Published internal Inventory interface. Both supported return workflows use
 * the same physical and financial owners in their existing transaction. */
export { applyReturnedStock, applyReturnRestock, ReturnRestockError } from "./application/return-restock.use-case";
export type { ApplyReturnedStockInput, ApplyReturnRestockInput, ApplyReturnRestockResult } from "./application/return-restock.use-case";
export { quarantineReturnedStock } from "./application/quarantine-returned-stock";
export { lockInventoryCostGraph, costFingerprint, CostEvidenceError } from "./infrastructure/cost-evidence.repository";
export { LotCostError } from "./domain/lot-cost";
export { readPhysicalReturnQuantities } from "./infrastructure/physical-return-quantity.reader";
export { loadReturnCommand, recordReturnCommand } from "./infrastructure/return-command.repository";
