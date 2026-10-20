import { poAmendmentReturnedCostSchema, type PoAmendmentReturnedCost } from "@shared/procurement/po-amendment-impact";
import { supplierReturnCostAdjustmentSchema } from "@shared/procurement/supplier-return";
import { moneyToSafeNumber } from "../inventory/domain/lot-cost";

type ReturnedImpact = {
  returnedCosts?: PoAmendmentReturnedCost[];
  returnedCostDeltaMills?: number;
};

/** Project the actual owner's applied deltas. Replayed applications do not
 * change value during this amendment; generated entry IDs cannot bind preview. */
export function projectPoAmendmentReturnedCosts(application: {
  replayed: boolean;
  supplierReturnAdjustments?: unknown;
}): ReturnedImpact {
  const adjustments = supplierReturnCostAdjustmentSchema.array().max(10_000)
    .parse(application.supplierReturnAdjustments ?? []);
  if (application.replayed || adjustments.length === 0) return {};
  const returnedCosts = adjustments.map(row => poAmendmentReturnedCostSchema.parse({
    returnId: row.returnId, returnLineId: row.returnLineId, returnAllocationId: row.returnAllocationId,
    costQuantityAllocationId: row.costQuantityAllocationId, inventoryLotId: row.inventoryLotId,
    quantity: row.quantity, component: row.component,
    beforeMills: row.beforeMills, afterMills: row.afterMills, deltaMills: row.deltaMills,
  })).sort((left, right) => left.returnAllocationId - right.returnAllocationId);
  const returnedCostDeltaMills = moneyToSafeNumber(
    returnedCosts.reduce((sum, row) => sum + BigInt(row.deltaMills), BigInt(0)), "returned value amendment delta");
  return { returnedCosts, returnedCostDeltaMills };
}
