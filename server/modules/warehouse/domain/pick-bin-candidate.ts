/**
 * Pure ranking for "which slot row should an order line point at".
 *
 * Why a ranking and not a hard `is_primary = 1` requirement: until 2026-05-14
 * (commit 0faaa645, "Harden pick slotting cleanup") the slot writer cleared the
 * primary flag on EVERY sibling variant of a product whenever a new variant of
 * that product was slotted, then flagged only the new variant. Real, bin-backed
 * slot rows were left with is_primary = 0 and nothing ever restored them.
 * Separately, rows created by the Shopify product webhook carry the default
 * flag but point at no bin. Treating the flag as a hard gate therefore stamped
 * UNASSIGNED on every order line of SKUs that were visibly assigned in Slotting
 * Setup (SHLZ-MAG-STND-P5 / ARM-ENV-GRD-C60 / ARM-ENV-GRD-P10, 2026-09).
 *
 * Here the flag is a preference: a bin-backed row always beats no row, and the
 * order is total and deterministic (slot id breaks every tie) so two syncs of
 * the same order line resolve the same bin.
 *
 * Callers must already have restricted candidates to rows that point at a real
 * warehouse location (an inner join on warehouse_locations); a row without a
 * bin cannot direct a picker anywhere and must never be a candidate.
 */

export const ACTIVE_SLOT_STATUS = "active";
export const PICK_FACE_LOCATION_TYPE = "pick";

export type PickBinCandidate = {
  /** product_locations.id — the final, deterministic tie-breaker. */
  slotId: number;
  /** product_locations.status: "active" or "draft". */
  slotStatus: string | null;
  /** product_locations.is_primary: 1 preferred, 0 secondary / bulk. */
  isPrimary: number | null;
  /** warehouse_locations.is_active */
  locationIsActive: number | null;
  /** warehouse_locations.is_pickable */
  locationIsPickable: number | null;
  /** warehouse_locations.location_type */
  locationType: string | null;
  /** warehouse_locations.cycle_count_freeze_id — set while a count freezes the bin. */
  cycleCountFreezeId: number | null;
};

/** A bin a picker can be sent to right now. Mirrors assignVariantToLocation's target validation. */
export function isUsablePickFace(candidate: PickBinCandidate): boolean {
  return (
    Number(candidate.locationIsActive) === 1 &&
    Number(candidate.locationIsPickable) === 1 &&
    candidate.locationType === PICK_FACE_LOCATION_TYPE &&
    candidate.cycleCountFreezeId == null
  );
}

function rankPreferred(preferred: boolean): number {
  return preferred ? 0 : 1;
}

/**
 * Sort comparator, best candidate first:
 *   1. active slot rows before draft ones — a draft slot is planned setup, not
 *      confirmed stock placement (reservation.service applies the same rule);
 *   2. usable pick faces before inactive, non-pick, or frozen bins;
 *   3. the primary flag;
 *   4. lowest slot id (oldest row), so the choice is stable across syncs.
 *
 * Draft rows stay eligible on purpose: some SKUs' only slot row is a draft and
 * the previous resolver (which ignored status) resolved them; ranking them
 * last preserves that without letting a draft beat a confirmed slot.
 */
export function comparePickBinCandidates(a: PickBinCandidate, b: PickBinCandidate): number {
  const byStatus =
    rankPreferred(a.slotStatus === ACTIVE_SLOT_STATUS) - rankPreferred(b.slotStatus === ACTIVE_SLOT_STATUS);
  if (byStatus !== 0) return byStatus;

  const byPickFace = rankPreferred(isUsablePickFace(a)) - rankPreferred(isUsablePickFace(b));
  if (byPickFace !== 0) return byPickFace;

  const byPrimary = rankPreferred(Number(a.isPrimary) === 1) - rankPreferred(Number(b.isPrimary) === 1);
  if (byPrimary !== 0) return byPrimary;

  return a.slotId - b.slotId;
}

/**
 * Returns the best candidate or null when there are none. Never mutates the
 * input. Throws on a candidate without a usable slot id, because a row that
 * cannot be identified cannot be audited — the caller decides whether that
 * degrades to "no bin" (wms-sync does, with a warning).
 */
export function selectPickBinCandidate<T extends PickBinCandidate>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.slotId)) {
      throw new Error(`Pick bin candidate has an invalid slot id: ${String(candidate.slotId)}`);
    }
  }
  return [...candidates].sort(comparePickBinCandidates)[0];
}
