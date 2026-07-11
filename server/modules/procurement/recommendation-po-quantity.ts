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

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return parsed;
}

export function resolveRecommendationPoQuantity(
  input: RecommendationPoQuantityInput,
): RecommendationPoQuantity {
  const orderUomQty = positiveSafeInteger(input.suggestedOrderQty, "suggestedOrderQty");
  const orderQtyPieces = positiveSafeInteger(input.suggestedOrderPieces, "suggestedOrderPieces");
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

export function calculateRecommendationLineTotalCents(
  unitCostCents: unknown,
  orderQtyPieces: unknown,
): number {
  const normalizedUnitCostCents = Number(unitCostCents ?? 0);
  const normalizedOrderQtyPieces = positiveSafeInteger(orderQtyPieces, "orderQtyPieces");
  if (!Number.isSafeInteger(normalizedUnitCostCents) || normalizedUnitCostCents < 0) {
    throw new RangeError("unitCostCents must be a nonnegative safe integer");
  }

  const total = BigInt(normalizedUnitCostCents) * BigInt(normalizedOrderQtyPieces);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("recommendation line total exceeds the safe integer range");
  }
  return Number(total);
}
