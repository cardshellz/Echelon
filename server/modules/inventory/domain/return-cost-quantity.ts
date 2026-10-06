export interface SoldCostQuantity {
  id: number;
  inventoryLotId: number;
  quantity: number;
  unitMills: bigint;
}
export interface ReversedCostQuantity {
  negativeCostId: number;
  originalCostId: number;
  quantity: number;
}

export class ReturnCostQuantityError extends Error {
  readonly code = "RETURN_COST_ALLOCATION_CONFLICT";
  readonly statusCode = 409;
}

/** Net only explicitly linked unpicks. A negative COGS row is never a new sold
 * layer, and matching SKU/lot/price alone does not prove which pick it reversed.
 */
export function returnableCostQuantities(costs: readonly SoldCostQuantity[], reversals: readonly ReversedCostQuantity[]): Map<number, number> {
  const byId = new Map<number, SoldCostQuantity>();
  for (const cost of costs) {
    if (!Number.isSafeInteger(cost.id) || cost.id <= 0 || byId.has(cost.id)
      || !Number.isSafeInteger(cost.inventoryLotId) || cost.inventoryLotId <= 0
      || !Number.isSafeInteger(cost.quantity) || cost.quantity === 0 || Math.abs(cost.quantity) > 2_147_483_647
      || cost.unitMills < BigInt(0)) throw new ReturnCostQuantityError("Invalid exact sold cost quantity.");
    byId.set(cost.id, cost);
  }
  const available = new Map(costs.filter(cost => cost.quantity > 0).map(cost => [cost.id, cost.quantity]));
  const linked = new Set<number>();
  for (const reversal of reversals) {
    const negative = byId.get(reversal.negativeCostId);
    const original = byId.get(reversal.originalCostId);
    if (!negative || !original || linked.has(negative.id) || negative.quantity >= 0 || original.quantity <= 0
      || !Number.isSafeInteger(reversal.quantity) || reversal.quantity !== -negative.quantity
      || negative.inventoryLotId !== original.inventoryLotId || negative.unitMills !== original.unitMills) {
      throw new ReturnCostQuantityError("An unpick does not identify its exact original sold cost layer.");
    }
    const remaining = available.get(original.id)! - reversal.quantity;
    if (remaining < 0) throw new ReturnCostQuantityError("Unpicks exceed their exact original sold quantity.");
    available.set(original.id, remaining);
    linked.add(negative.id);
  }
  if (costs.some(cost => cost.quantity < 0 && !linked.has(cost.id))) {
    throw new ReturnCostQuantityError("A negative sold cost row is missing its original pick lineage.");
  }
  return available;
}
