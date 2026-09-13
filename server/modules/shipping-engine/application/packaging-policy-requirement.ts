/**
 * Legacy packaging fallback gate.
 *
 * A channel with no saved `shipping.channel_packaging_policies` row resolves
 * boxes through the legacy `shipping.packaging_assignments` table, which has no
 * branding requirement and weaker availability semantics. That fallback is the
 * designed migration default (migration 241 manufactures no policies), so it
 * stays on until operations has saved a policy for every active channel. Once
 * that dependency report is clean, setting this variable to `true` makes a
 * policy-less channel fail closed instead of packing from legacy rows.
 */
export const SHIPPING_PACKAGING_POLICY_REQUIRED_ENV = "SHIPPING_PACKAGING_POLICY_REQUIRED";

export function isPackagingPolicyRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV]?.trim().toLowerCase() === "true";
}
