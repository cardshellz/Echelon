export interface ReplenishmentAutoExecutionSettings {
  replenMode: string;
  inlineReplenMaxUnits: number | null;
}

const DEFAULT_INLINE_REPLENISHMENT_BASE_UNITS = 50;

/** The same rule hierarchy governs routine replenishment and claim-backed picks. */
export function resolveReplenishmentAutoExecution(
  ruleOverride: number | null | undefined,
  tierOverride: number | null | undefined,
  settings: ReplenishmentAutoExecutionSettings | null,
  targetBaseUnits: number,
  method = "case_break",
): { shouldAutoExecute: boolean; executionMode: "inline" | "queue" } {
  const decision = (inline: boolean) => ({
    shouldAutoExecute: inline,
    executionMode: inline ? "inline" as const : "queue" as const,
  });
  // Package conversion is same-product, unit-conserving repackaging proved by
  // the claim owner. Component builds and transfers remain separate work.
  if (method !== "case_break" && method !== "package_conversion") return decision(false);
  for (const override of [ruleOverride, tierOverride]) {
    if (override === 1) return decision(true);
    if (override === 2) return decision(false);
  }
  if (settings?.replenMode === "inline") return decision(true);
  if (settings?.replenMode === "hybrid") {
    return decision(targetBaseUnits <= (settings.inlineReplenMaxUnits || DEFAULT_INLINE_REPLENISHMENT_BASE_UNITS));
  }
  return decision(false);
}
