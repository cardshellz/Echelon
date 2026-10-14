/** Allocate an immutable quantity interval from an exact integer cost total.
 * Adjacent intervals telescope to the original amount, including signed credits.
 * Quantity offsets are recorded financial custody; current stock is not an offset.
 */
export function allocateIntegerCostInterval(
  total: bigint,
  basisQuantity: bigint,
  startQuantity: bigint,
  quantity: bigint,
): bigint {
  const zero = BigInt(0);
  if (
    basisQuantity <= zero ||
    startQuantity < zero ||
    quantity < zero ||
    startQuantity + quantity > basisQuantity
  ) {
    throw new RangeError(
      "Cost interval is outside its original quantity basis",
    );
  }
  const magnitude = total < zero ? -total : total;
  const allocated =
    (magnitude * (startQuantity + quantity)) / basisQuantity -
    (magnitude * startQuantity) / basisQuantity;
  return total < zero ? -allocated : allocated;
}
