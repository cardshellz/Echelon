/**
 * Displacement for a confirmed shipment.
 *
 * A picker confirmed that units of an order already shipped, but the books
 * promised every unit of that variant in the warehouse to other orders that
 * have not started picking (2026-10-02: C-11 held 146 units, all reserved,
 * while 15 more physically shipped for orders planned at 0). The shipped
 * units came out of that shared stock, so some unstarted reservation is
 * already fictional. The lowest-priority unstarted orders give it up first,
 * newest among equals, which keeps the most urgent and oldest promises intact.
 *
 * Pure rules only; the repository owns locking, release and re-planning.
 */

export interface DisplacementDonor {
  claimId: bigint;
  orderId: number;
  /** wms.orders.priority: shipping-speed base plus membership modifier; higher is picked sooner. */
  priority: number;
  /** Open (unpicked, unreleased) reserved units of the needed variant in the warehouse. */
  openQty: bigint;
}

/**
 * Chooses donors until they cover the shortfall: the lowest pick priority
 * gives up stock first (so a standard order yields before an expedited or
 * member order), and among equals the newest order yields first. Returns null
 * when even all of them cannot cover it: a partial displacement would take
 * stock from other orders and still leave the pick unrecordable.
 */
export function selectDisplacementDonors(
  donors: readonly DisplacementDonor[],
  shortQty: bigint,
): DisplacementDonor[] | null {
  if (shortQty <= BigInt(0)) return [];
  const yieldOrder = [...donors].sort((left, right) => left.priority - right.priority
    || right.orderId - left.orderId
    || (right.claimId > left.claimId ? 1 : right.claimId < left.claimId ? -1 : 0));
  const selected: DisplacementDonor[] = [];
  let covered = BigInt(0);
  for (const donor of yieldOrder) {
    if (donor.openQty <= BigInt(0)) continue;
    selected.push(donor);
    covered += donor.openQty;
    if (covered >= shortQty) return selected;
  }
  return null;
}

/** Stable evidence for proving the donor set did not change under lock. */
export function displacementEvidence(donors: readonly DisplacementDonor[]): string {
  return donors.map((donor) => `${donor.claimId}:${donor.orderId}:${donor.priority}:${donor.openQty}`).join(",");
}
