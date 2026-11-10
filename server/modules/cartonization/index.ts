/**
 * Public API for channel-neutral cartonization (`CI-03`).
 *
 * Channel adapters provide physical items and available containers to the
 * pure engine. WMS callers use ensurePackPlan to persist the verified result
 * that the packing station executes.
 */
export * from "./cartonize-engine.api";
export * from "./pack-plan.api";
export * from "./packing-inputs.api";
