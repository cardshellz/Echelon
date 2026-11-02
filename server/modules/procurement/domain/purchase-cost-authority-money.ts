import type { PurchaseCostAmount, PurchaseCostAmountProjection } from "@shared/procurement/purchase-cost-authority";

export class PurchaseCostAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "PurchaseCostAuthorityError";
  }
}

export function exactAuthorityMoney(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new PurchaseCostAuthorityError("PURCHASE_COST_AUTHORITY_RANGE", "The cost projection exceeds the exact supported range.", { field });
  return Number(value);
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  const magnitude = numerator < BigInt(0) ? -numerator : numerator;
  const rounded = (magnitude * BigInt(2) + denominator) / (denominator * BigInt(2));
  return numerator < BigInt(0) ? -rounded : rounded;
}

/** Cumulative rounding conserves the selected document total across its signed
 * components. Independent rounding could otherwise lose a mill of packaging or
 * a discount when only the provisional remainder of a PO is selected. */
export function projectAuthorityAmount(amount: PurchaseCostAmount, quantity: number, denominator: number): PurchaseCostAmountProjection {
  if (![quantity, denominator].every(Number.isSafeInteger) || denominator <= 0 || quantity < 0 || quantity > denominator)
    throw new PurchaseCostAuthorityError("PURCHASE_COST_QUANTITY_INVALID", "The projected quantity must be within its positive source denominator.");
  let cumulative = BigInt(0);
  let previous = BigInt(0);
  const allocate = (value: number): number => {
    cumulative += BigInt(value);
    const next = roundedRatio(cumulative * BigInt(quantity), BigInt(denominator));
    const share = exactAuthorityMoney(next - previous, "componentShare");
    previous = next;
    return share;
  };
  const productMills = amount.breakdown ? allocate(amount.breakdown.productMills) : null;
  const packagingMills = amount.breakdown ? allocate(amount.breakdown.packagingMills) : null;
  const goodsMills = amount.breakdown ? exactAuthorityMoney(BigInt(productMills!) + BigInt(packagingMills!), "goods") : allocate(amount.goodsMills);
  let inventory = BigInt(0), excluded = BigInt(0), unclassified = BigInt(0);
  let classificationMissing = false;
  const adjustments = [...amount.adjustments].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (const adjustment of adjustments) {
    const share = BigInt(allocate(adjustment.amountMills));
    if (adjustment.treatment === "inventory") inventory += share;
    else if (adjustment.treatment === "excluded") excluded += share;
    else {
      unclassified += share;
      // Unknown charges cannot cancel each other into a false completion.
      classificationMissing ||= adjustment.amountMills !== 0;
    }
  }
  return {
    documentMills: exactAuthorityMoney(previous, "document"), goodsMills, productMills, packagingMills,
    inventoryAdjustmentsMills: exactAuthorityMoney(inventory, "inventoryAdjustments"),
    excludedAdjustmentsMills: exactAuthorityMoney(excluded, "excludedAdjustments"),
    unclassifiedAdjustmentsMills: exactAuthorityMoney(unclassified, "unclassifiedAdjustments"),
    includedMills: classificationMissing ? null : exactAuthorityMoney(BigInt(goodsMills) + inventory, "included"),
    classification: classificationMissing ? "unclassified" : "complete",
  };
}

export function sumAuthorityAmounts(amounts: readonly PurchaseCostAmountProjection[]): PurchaseCostAmountProjection {
  const sum = (field: Exclude<keyof PurchaseCostAmountProjection, "classification">): number => exactAuthorityMoney(
    amounts.reduce((total, row) => total + BigInt(row[field] ?? 0), BigInt(0)), field,
  );
  const knownBreakdown = amounts.every(row => row.productMills !== null && row.packagingMills !== null);
  return {
    documentMills: sum("documentMills"), goodsMills: sum("goodsMills"),
    productMills: knownBreakdown ? sum("productMills") : null,
    packagingMills: knownBreakdown ? sum("packagingMills") : null,
    inventoryAdjustmentsMills: sum("inventoryAdjustmentsMills"), excludedAdjustmentsMills: sum("excludedAdjustmentsMills"),
    unclassifiedAdjustmentsMills: sum("unclassifiedAdjustmentsMills"),
    includedMills: amounts.some(row => row.includedMills === null) ? null : sum("includedMills"),
    classification: amounts.some(row => row.classification === "unclassified") ? "unclassified" : "complete",
  };
}
