export const WMS_CARTONIZATION_SHADOW_FLAG =
  "SHIPPING_WMS_CARTONIZATION_SHADOW_ENABLED" as const;

/**
 * Shadow execution is opt-in. There is deliberately no runtime enforcement
 * mode in this rollout; a required WMS cutover needs its own reviewed change.
 */
export function isWmsCartonizationShadowEnabled(
  rawValue: string | undefined = process.env[WMS_CARTONIZATION_SHADOW_FLAG],
): boolean {
  return rawValue?.trim().toLowerCase() === "true";
}
