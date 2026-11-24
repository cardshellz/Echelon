// Inventory planning owns the stock-link engine's state (channels PR2, PLAN-CH2 v4.1 §8). This published read port
// gives OMS operations health the stock-link issues as read-only SQL fragments, without letting it read inventory
// tables or load the engine, its runner or its pool.
export {
  STOCK_LINK_HEALTH_CHECKS, STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF, stockLinkHealthChecks, stockLinkHealthChecksForProcess,
} from "./infrastructure/stock-link-health.sql";
export type { StockLinkHealthCheck } from "./infrastructure/stock-link-health.sql";
