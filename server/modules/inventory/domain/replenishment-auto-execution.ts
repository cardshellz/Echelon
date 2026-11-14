export interface ReplenishmentAutoExecutionSettings {
  replenMode: string;
  inlineReplenMaxUnits: number | null;
}

const DEFAULT_INLINE_REPLENISHMENT_BASE_UNITS = 50;

/**
 * The run/queue override (1 = always run, 2 = always queue) that applies to a
 * manually created task. A replen rule or tier default sets that override
 * together with its own replenishment method, so it governs only tasks of
 * that method. Example: the level-3 tier default is "pallet drop, always
 * queue"; a manual case break into a level-3 SKU is not a pallet drop and
 * follows the warehouse execution mode instead. An override with no recorded
 * method keeps applying, as before.
 */
export function manualReplenishmentAutoOverride(input: {
  autoReplen: number | null | undefined;
  autoReplenMethod: string | null | undefined;
  taskMethod: string;
}): number | null {
  if (input.autoReplen == null) return null;
  if (input.autoReplenMethod && input.autoReplenMethod !== input.taskMethod) return null;
  return input.autoReplen;
}

/** Methods whose routine movement is owned by the inline inventory executor. */
export function supportsInlineReplenishment(method: string): boolean {
  return (
    method === "case_break" ||
    method === "package_conversion" ||
    method === "full_case"
  );
}

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
    executionMode: inline ? ("inline" as const) : ("queue" as const),
  });
  // Same-SKU reserve transfers use the existing inventory transfer owner;
  // conversions still require server-side authorization. Builds and pallet
  // drops retain their separate execution contracts.
  if (!supportsInlineReplenishment(method)) return decision(false);
  for (const override of [ruleOverride, tierOverride]) {
    if (override === 1) return decision(true);
    if (override === 2) return decision(false);
  }
  if (settings?.replenMode === "inline") return decision(true);
  if (settings?.replenMode === "hybrid") {
    return decision(
      targetBaseUnits <=
        (settings.inlineReplenMaxUnits ||
          DEFAULT_INLINE_REPLENISHMENT_BASE_UNITS),
    );
  }
  return decision(false);
}
