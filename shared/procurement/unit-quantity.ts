/** Exact quantity arithmetic shared by shipment entry and receipt-unit changes. */
export const MAX_UNIT_QUANTITY = 2_147_483_647;
export class UnitQuantityError extends Error {
  constructor(public readonly code: "UNIT_QUANTITY_INVALID" | "UNIT_QUANTITY_INEXACT" | "UNIT_QUANTITY_OVERFLOW", message: string) {
    super(message); this.name = "UnitQuantityError";
  }
}
function integer(value: number, positive: boolean): bigint {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_UNIT_QUANTITY) {
    throw new UnitQuantityError("UNIT_QUANTITY_INVALID", "Unit counts and pack factors must be whole numbers within the supported quantity range.");
  }
  return BigInt(value);
}
export function convertUnitQuantity(quantity: number, fromUnitsPerVariant: number, toUnitsPerVariant: number): number {
  const pieces = integer(quantity, false) * integer(fromUnitsPerVariant, true);
  const target = integer(toUnitsPerVariant, true);
  if (pieces % target !== BigInt(0)) throw new UnitQuantityError("UNIT_QUANTITY_INEXACT", "The selected unit cannot represent the recorded pieces exactly.");
  const count = pieces / target;
  if (count > BigInt(MAX_UNIT_QUANTITY)) throw new UnitQuantityError("UNIT_QUANTITY_OVERFLOW", "The converted quantity exceeds the supported range.");
  return Number(count);
}
export function toBasePieces(quantity: number, unitsPerVariant: number): number {
  return convertUnitQuantity(quantity, unitsPerVariant, 1);
}
