import type { CutoverReconstructionEvidence } from "./inventory-cutover-reconstruction";

type Level = CutoverReconstructionEvidence["levels"][number];
type Lot = CutoverReconstructionEvidence["lots"][number];
const MAX_QUANTITY = BigInt(2_147_483_647);

/** Position quantities are an output, never a second physical observation. */
export function deriveVerifiedOpeningPositions(levels: readonly Level[], lots: readonly Lot[]): Level[] {
  const byCell = new Map<string, Level>();
  const seenLevels = new Set<number>();
  const seenLots = new Set<number>();
  const totals = new Map<number, { onHand: bigint; reserved: bigint; picked: bigint }>();
  for (const level of levels) {
    const key = `${level.productVariantId}:${level.warehouseLocationId}`;
    if (seenLevels.has(level.id) || byCell.has(key)) throw new Error("Opening positions must have distinct SKU/bin identities");
    seenLevels.add(level.id); byCell.set(key, level);
  }
  for (const lot of lots) {
    if (seenLots.has(lot.id)) throw new Error("Opening lot observations must be distinct");
    seenLots.add(lot.id);
    const onHand = parseQuantity(lot.onHandQty), reserved = parseQuantity(lot.reservedQty), picked = parseQuantity(lot.pickedQty);
    if (reserved > onHand) throw new Error("A verified lot cannot reserve more units than its on-hand observation");
    const level = byCell.get(`${lot.productVariantId}:${lot.warehouseLocationId}`);
    // An explicitly empty historical lot with no physical position contributes
    // no stock. Its full identity/cost/zero observation remains in the audit.
    if (onHand === BigInt(0) && reserved === BigInt(0) && picked === BigInt(0) && !level) continue;
    if (!level || level.warehouseId === null || lot.warehouseLocationId === null) {
      throw new Error("Every nonzero lot observation requires an exact SKU/bin/warehouse position");
    }
    const sum = totals.get(level.id) ?? { onHand: BigInt(0), reserved: BigInt(0), picked: BigInt(0) };
    sum.onHand += onHand; sum.reserved += reserved; sum.picked += picked;
    if (Object.values(sum).some(value => value > MAX_QUANTITY)) throw new Error("Verified SKU/bin quantity exceeds supported inventory range");
    totals.set(level.id, sum);
  }
  return levels.map(level => {
    const total = totals.get(level.id);
    return { ...level, variantQty: (total?.onHand ?? BigInt(0)).toString(), reservedQty: (total?.reserved ?? BigInt(0)).toString(),
      pickedQty: (total?.picked ?? BigInt(0)).toString(), packedQty: "0" };
  });
}

function parseQuantity(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_QUANTITY) {
    throw new Error("Every opening lot quantity must be an explicit nonnegative inventory integer; blanks are not zero");
  }
  return BigInt(value);
}
