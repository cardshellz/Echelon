const POSTGRES_INTEGER_MAX = 2_147_483_647;

export class ShipStationCommercialQuantityError extends Error {
  readonly code = "INVALID_SHIPSTATION_COMMERCIAL_SPLIT";

  constructor(readonly context: Readonly<Record<string, unknown>>) {
    super("ShipStation physical split has invalid commercial quantity evidence");
    this.name = "ShipStationCommercialQuantityError";
  }
}

/**
 * A physical split moves existing commercial demand, never creates more of it.
 * NULL is the pre-refund default and must stay NULL on both rows so historical
 * source evidence and its hashes remain unchanged.
 */
export function partitionCommercialRequestedQuantity(input: Readonly<{
  sourceQuantity: number;
  splitQuantity: number;
  commercialRequestedQuantity: number | null;
}>): Readonly<{ childQuantity: number | null; retainedQuantity: number | null }> {
  const { sourceQuantity, splitQuantity, commercialRequestedQuantity } = input;
  if (!Number.isInteger(sourceQuantity) || sourceQuantity <= 0 || sourceQuantity > POSTGRES_INTEGER_MAX
    || !Number.isInteger(splitQuantity) || splitQuantity <= 0 || splitQuantity > sourceQuantity
    || (commercialRequestedQuantity !== null && (
      !Number.isInteger(commercialRequestedQuantity)
      || commercialRequestedQuantity < 0
      || commercialRequestedQuantity > sourceQuantity
    ))) {
    throw new ShipStationCommercialQuantityError({
      sourceQuantity,
      splitQuantity,
      commercialRequestedQuantity,
    });
  }
  if (commercialRequestedQuantity === null) {
    return Object.freeze({ childQuantity: null, retainedQuantity: null });
  }
  const childQuantity = Math.min(commercialRequestedQuantity, splitQuantity);
  return Object.freeze({
    childQuantity,
    retainedQuantity: commercialRequestedQuantity - childQuantity,
  });
}
