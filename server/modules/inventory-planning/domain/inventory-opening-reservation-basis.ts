import { openingReservationRebaseSchema, type CutoverReconstructionEvidence,
  type CutoverReconstructionBlocker, type OpeningReservationRebase } from "@shared/types/inventory-cutover-reconstruction";

/** Called only after an explicit independent-verification opt-in. All lot and
 * owner verification must still pass before any proposal becomes executable. */
export function planOpeningReservationBasis(evidence: CutoverReconstructionEvidence): {
  rebases: OpeningReservationRebase[]; blockers: CutoverReconstructionBlocker[];
} {
  const rebases: OpeningReservationRebase[] = [], blockers: CutoverReconstructionBlocker[] = [];
  const key = (location: number | null, variant: number) => `${location}:${variant}`;
  const totals = new Map<string, { onHand: bigint; reserved: bigint; picked: bigint; invalid: boolean }>();
  for (const lot of evidence.lots) {
    const position = key(lot.warehouseLocationId, lot.productVariantId);
    const total = totals.get(position) ?? { onHand: BigInt(0), reserved: BigInt(0), picked: BigInt(0), invalid: false };
    const onHand = BigInt(lot.onHandQty), reserved = BigInt(lot.reservedQty), picked = BigInt(lot.pickedQty);
    total.onHand += onHand; total.reserved += reserved; total.picked += picked;
    total.invalid ||= onHand < BigInt(0) || reserved < BigInt(0) || picked < BigInt(0) || reserved > onHand;
    totals.set(position, total);
  }
  for (const level of evidence.levels) {
    const total = totals.get(key(level.warehouseLocationId, level.productVariantId))
      ?? { onHand: BigInt(0), reserved: BigInt(0), picked: BigInt(0), invalid: false };
    if (total.invalid || level.warehouseId === null || total.onHand !== BigInt(level.variantQty)
      || total.picked !== BigInt(level.pickedQty) || BigInt(level.packedQty) !== BigInt(0)
      || total.reserved > BigInt(level.reservedQty)) {
      blockers.push({ code: "OPENING_PHYSICAL_BASIS_INVALID", subject: `level:${level.id}`,
        message: "Verified physical lots must match on-hand and picked counters, have valid reservations, and fit within the recorded level reservation. No stock, picked custody or missing reservation is invented." });
      continue;
    }
    if (BigInt(level.reservedQty) === total.reserved) continue;
    const parsed = openingReservationRebaseSchema.safeParse({ inventoryLevelId: level.id, warehouseId: level.warehouseId,
      warehouseLocationId: level.warehouseLocationId, productVariantId: level.productVariantId, variantQty: level.variantQty,
      reservedQty: level.reservedQty, pickedQty: level.pickedQty, packedQty: level.packedQty, physicalReservedQty: total.reserved.toString() });
    if (parsed.success) rebases.push(parsed.data);
    else blockers.push({ code: "OPENING_RESERVATION_BASIS_INVALID", subject: `level:${level.id}`,
      message: "The recorded reservation counter cannot be translated to verified physical custody safely." });
  }
  return { rebases: rebases.sort((a,b) => a.inventoryLevelId-b.inventoryLevelId), blockers };
}
