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
  // Transfers, assembly and other warehouse work never become implicit picks.
  if (method !== "case_break") return decision(false);
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
