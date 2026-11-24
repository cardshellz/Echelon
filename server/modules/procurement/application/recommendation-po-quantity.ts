export type RecommendationPoQuantityInput = {
  suggestedOrderQty: unknown;
  suggestedOrderPieces: unknown;
  orderUomUnits: unknown;
};

export type RecommendationPoQuantity = {
  orderQtyPieces: number;
  orderUomQty: number;
  orderUomUnits: number;
};

export type RecommendationPoQuantityOptions = {
  /**
   * Healthy top-off acceptance: the engine suggested nothing, so BOTH
   * suggestedOrderQty and suggestedOrderPieces are exactly zero. The
   * pieces = qty x units consistency rule still applies (0 = 0 x units) and
   * orderUomUnits must still be positive. Callers that opt in must require a
   * positive requestedPieces override before any PO line is written.
   */
  allowZeroBaseline?: boolean;
};

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return parsed;
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

export function resolveRecommendationPoQuantity(
  input: RecommendationPoQuantityInput,
  options: RecommendationPoQuantityOptions = {},
): RecommendationPoQuantity {
  const allowZeroBaseline = options.allowZeroBaseline === true;
  const orderUomQty = allowZeroBaseline
    ? nonnegativeSafeInteger(input.suggestedOrderQty, "suggestedOrderQty")
    : positiveSafeInteger(input.suggestedOrderQty, "suggestedOrderQty");
  const orderQtyPieces = allowZeroBaseline
    ? nonnegativeSafeInteger(input.suggestedOrderPieces, "suggestedOrderPieces")
    : positiveSafeInteger(input.suggestedOrderPieces, "suggestedOrderPieces");
  const orderUomUnits = positiveSafeInteger(input.orderUomUnits, "orderUomUnits");
  const calculatedPieces = BigInt(orderUomQty) * BigInt(orderUomUnits);

  if (calculatedPieces > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("recommendation quantity exceeds the safe integer range");
  }
  if (BigInt(orderQtyPieces) !== calculatedPieces) {
    throw new RangeError(
      `suggestedOrderPieces must equal suggestedOrderQty * orderUomUnits (${calculatedPieces.toString()})`,
    );
  }

  return {
    orderQtyPieces,
    orderUomQty,
    orderUomUnits,
  };
}
