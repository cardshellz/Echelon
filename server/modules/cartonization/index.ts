/**
 * Public API for channel-neutral cartonization.
 *
 * Channel adapters provide physical items and available containers to the
 * pure engine. WMS callers use ensurePackPlan to persist the verified result
 * that the packing station executes.
 */
export * from "./domain/cartonize";
export * from "./domain/build-items";
export {
  isWmsCartonizationShadowEnabled,
  WMS_CARTONIZATION_SHADOW_FLAG,
} from "./application/wms-cartonization-shadow";
export {
  buildBoxInstruction,
  computePackPlanInputHash,
  ensurePackPlan,
  maybeGetPackInstruction,
  type EnsurePackPlanRequest,
  type PackPlanDeps,
  type PackPlanResult,
} from "./application/wms-pack-plan.service";
