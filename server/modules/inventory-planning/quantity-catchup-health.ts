// Inventory planning owns the quantity catch-up rows (Channels PR5, PLAN-CH-v3 section 6). This published read port
// gives OMS operations health the parked / review-required issues as read-only SQL fragments, without letting it read
// inventory tables or load the catch-up worker.
export { QUANTITY_CATCHUP_HEALTH_CHECKS, quantityCatchupHealthChecks } from "./infrastructure/quantity-catchup-health.sql";
export type { QuantityCatchupHealthCheck } from "./infrastructure/quantity-catchup-health.sql";
