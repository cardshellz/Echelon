/**
 * Supply refresh: re-plan a claim whose order demand is unchanged but which was
 * planned short because stock was missing when the order was claimed.
 *
 * Nothing re-plans such a claim on its own (replacement normally requires a
 * demand change), so a line claimed at 0 stays at 0 and every pick on it fails
 * with CLAIM_LINE_PICK_OVERAGE even after stock arrives.
 *
 * Pure rules only; the repository owns locking and persistence.
 */

export interface ClaimLineBalance {
  lineKey: string;
  /** Demand still open on the active claim: requested - released - consumed - picked. */
  remainingRequestedQty: bigint;
  /** Planned quantity still open: planned - released - consumed - picked. */
  remainingPlannedQty: bigint;
  pickedTargetQty: bigint;
}

export interface PlannedLine {
  lineKey: string;
  plannedQty: string;
  shortfallQty: string;
}

export type ClaimSupplyRefreshRejection =
  | { code: "CLAIM_SUPPLY_REFRESH_NOT_SHORT"; message: string }
  | { code: "CLAIM_SUPPLY_REFRESH_PICK_IN_PROGRESS"; message: string; lineKey: string }
  | { code: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT"; message: string; previousShortfallQty: string; nextShortfallQty: string }
  | { code: "CLAIM_SUPPLY_REFRESH_LINE_REGRESSION"; message: string; lineKey: string; previousPlannedQty: string; nextPlannedQty: string };

export function remainingShortfall(lines: readonly ClaimLineBalance[]): bigint {
  return lines.reduce((total, line) => total + (line.remainingRequestedQty - line.remainingPlannedQty), BigInt(0));
}

/**
 * Checked before any resource is released. A line with picked custody and
 * still-open demand cannot move to a replacement claim: the replacement line
 * would start at zero picked custody and the next pick on it would fail the
 * exact custody check (CLAIM_WMS_PICK_CUSTODY_MISMATCH). Fully picked lines
 * have no open demand and keep their custody on the superseded claim, which
 * shipment dispatch already resolves.
 */
export function rejectSupplyRefreshBeforePlanning(
  lines: readonly ClaimLineBalance[],
): ClaimSupplyRefreshRejection | null {
  const partiallyPicked = lines.find((line) =>
    line.pickedTargetQty > BigInt(0) && line.remainingRequestedQty > BigInt(0));
  if (partiallyPicked) {
    return {
      code: "CLAIM_SUPPLY_REFRESH_PICK_IN_PROGRESS",
      message: "A partly picked line cannot be re-reserved. Finish or unpick it first.",
      lineKey: partiallyPicked.lineKey,
    };
  }
  if (remainingShortfall(lines) <= BigInt(0)) {
    return { code: "CLAIM_SUPPLY_REFRESH_NOT_SHORT", message: "The active claim is not short of stock." };
  }
  return null;
}

/**
 * Checked after the replacement plan is computed, inside the same transaction.
 * The refresh must be a strict improvement: no line may lose planned quantity
 * (that would take stock away from an order that already had it), and total
 * shortfall must drop. A rejection rolls the whole transaction back.
 */
export function rejectSupplyRefreshPlan(
  previous: readonly ClaimLineBalance[],
  next: readonly PlannedLine[],
): ClaimSupplyRefreshRejection | null {
  const nextByKey = new Map(next.map((line) => [line.lineKey, line] as const));
  for (const line of previous) {
    if (line.remainingRequestedQty === BigInt(0)) continue;
    const nextPlanned = BigInt(nextByKey.get(line.lineKey)?.plannedQty ?? "0");
    if (nextPlanned < line.remainingPlannedQty) {
      return {
        code: "CLAIM_SUPPLY_REFRESH_LINE_REGRESSION",
        message: "Re-planning would take reserved stock away from a line.",
        lineKey: line.lineKey,
        previousPlannedQty: line.remainingPlannedQty.toString(),
        nextPlannedQty: nextPlanned.toString(),
      };
    }
  }
  const previousShortfall = remainingShortfall(previous);
  const nextShortfall = next.reduce((total, line) => total + BigInt(line.shortfallQty), BigInt(0));
  if (nextShortfall >= previousShortfall) {
    return {
      code: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT",
      message: "No new stock is available to reserve for this order.",
      previousShortfallQty: previousShortfall.toString(),
      nextShortfallQty: nextShortfall.toString(),
    };
  }
  return null;
}
