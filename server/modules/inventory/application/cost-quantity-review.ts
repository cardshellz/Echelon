import { unresolvedCostQuantitySchema, type CostComponent, type CostIssue } from "@shared/procurement/cost-source-contracts";
import { costForQuantityIntervals } from "../domain/cost-quantity-intervals";
import { CostEvidenceError, costInteger, type CostEvidenceTransaction } from "../infrastructure/cost-evidence.repository";
import { readUnresolvedCostQuantities } from "../infrastructure/cost-quantity.repository";

/** Read after establishing financial custody and projecting the new component.
 * Retain the exact unresolved amount in the same immutable application as the
 * successful inventory/COGS changes, including when the source amount changes. */
export async function readCostQuantityReview(tx: CostEvidenceTransaction, target: {
  lotId: number; lotNumber: string; basisQuantity: number; component: CostComponent; totalMills: number; currency: string;
}): Promise<CostIssue[]> {
  const unresolved = await readUnresolvedCostQuantities(tx, target.lotId);
  return unresolved.map(row => {
    if (row.snapshot.originalQuantity !== target.basisQuantity) {
      throw new CostEvidenceError("COST_UNRESOLVED_QUANTITY_INVALID", "Unresolved cost quantity conflicts with the original lot basis.", { lotId: target.lotId });
    }
    const amount = costForQuantityIntervals(BigInt(target.totalMills), target.basisQuantity, row.intervals);
    const detail = unresolvedCostQuantitySchema.parse({
      inventoryLotId: target.lotId, allocationId: row.allocationId, lotNumber: target.lotNumber,
      originalQuantity: row.snapshot.originalQuantity, onHandQuantityAtReview: row.snapshot.onHandQuantity,
      recordedOutflowQuantityAtReview: row.snapshot.recordedOutflowQuantity, quantity: row.snapshot.unresolvedQuantity,
      component: target.component, amountMills: costInteger(amount.toString(), "unresolved.amountMills"),
    });
    const displayAmount = `${amount / BigInt(10_000)}.${(amount % BigInt(10_000)).toString().padStart(4, "0")}`;
    return {
      code: "COST_UNRESOLVED_QUANTITY_RETAINED",
      message: `Lot ${target.lotNumber}: ${detail.quantity} lot units are not explained by the recorded history (${detail.originalQuantity} original, ${detail.onHandQuantityAtReview} on hand and ${detail.recordedOutflowQuantityAtReview} recorded outflow at review). ${displayAmount} ${target.currency} of ${target.component} cost is retained separately. Known inventory and order costs were updated; stock counts were not changed.`,
      unresolvedQuantity: detail,
    };
  });
}
