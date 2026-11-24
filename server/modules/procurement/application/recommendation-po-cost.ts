import {
  centsToMills,
  computeLineTotalCentsFromMills,
  millsToCents,
} from "@shared/utils/money";

export type RecommendationPoCostInput = {
  estimatedCostMills: unknown;
  estimatedCostCents: unknown;
  orderQtyPieces: unknown;
};

export type RecommendationPoCost = {
  unitCostMills: number;
  unitCostCents: number;
  totalProductCostCents: number;
  lineTotalCents: number;
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
    throw new RangeError(`${field} must be a nonnegative safe integer`);
  }
  return parsed;
}

function isProvided(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export function resolveRecommendationPoCost(input: RecommendationPoCostInput): RecommendationPoCost {
  const orderQtyPieces = positiveSafeInteger(input.orderQtyPieces, "orderQtyPieces");
  const millsProvided = isProvided(input.estimatedCostMills);
  const centsProvided = isProvided(input.estimatedCostCents);

  if (!millsProvided && !centsProvided) {
    throw new RangeError("recommendation supplier cost is required");
  }

  let unitCostMills: number;
  let unitCostCents: number;
  if (millsProvided) {
    unitCostMills = nonnegativeSafeInteger(input.estimatedCostMills, "estimatedCostMills");
    unitCostCents = millsToCents(unitCostMills);
    if (centsProvided) {
      const suppliedCents = nonnegativeSafeInteger(input.estimatedCostCents, "estimatedCostCents");
      if (suppliedCents !== unitCostCents) {
        throw new RangeError(
          `estimatedCostCents must equal the rounded estimatedCostMills mirror (${unitCostCents})`,
        );
      }
    }
  } else {
    unitCostCents = nonnegativeSafeInteger(input.estimatedCostCents, "estimatedCostCents");
    unitCostMills = centsToMills(unitCostCents);
  }

  const totalProductCostCents = computeLineTotalCentsFromMills(unitCostMills, orderQtyPieces);
  return {
    unitCostMills,
    unitCostCents,
    totalProductCostCents,
    lineTotalCents: totalProductCostCents,
  };
}
