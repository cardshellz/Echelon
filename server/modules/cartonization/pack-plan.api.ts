/**
 * Cartonization — WMS Pack Plan & Shadow Flag Internal API (`CI-03`)
 */
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
