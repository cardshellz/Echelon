// Inventory owns clearing evidence. This public read port never computes ATP or changes channel work.
export { readStockClearingEvidence, fenceStockClearingEvidence } from "./infrastructure/stock-clearing-evidence.reader";
export type { StockClearingEvidence } from "./infrastructure/stock-clearing-evidence.reader";
