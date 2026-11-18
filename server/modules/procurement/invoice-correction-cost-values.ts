import { hasExactLotCostTotals, lotCostTotals, LotCostError, moneyToSafeNumber, type LotCosts } from "../inventory/domain/lot-cost";
import { readUnallocatedLotCosts } from "../inventory/infrastructure/cost-quantity.repository";
import { costInteger, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { PoAmendmentDependencies } from "./po-amendment-dependencies.repository";

/** Read exact extended inventory values through the existing valuation owner.
 * Unknown legacy totals or unmatched custody are not valued using rounded rates.
 * Call before and after the cost update, within the same locked transaction. */
export async function readInvoiceCorrectionInventoryValues(tx: AmendmentTransaction, dependencies: PoAmendmentDependencies) {
  const lots = [...new Map(dependencies.evidence.flatMap(row => row.graph.lots)
    .map(lot => [costInteger(lot.id, "lotId", 1), lot])).values()]
    .sort((left, right) => costInteger(left.id, "lotId", 1) - costInteger(right.id, "lotId", 1));
  const eligible = lots.filter(lot => {
    if (!hasExactLotCostTotals(lot)) return false;
    try { lotCostTotals(lot); return true; }
    catch (error) { if (error instanceof LotCostError) return false; throw error; }
  });
  const exact = new Set(eligible.map(lot => costInteger(lot.id, "lotId", 1)));
  let available = new Map<number, { quantity: number; costs: LotCosts }>();
  let custodyIssue: string | null = null;
  try { available = await readUnallocatedLotCosts(tx, eligible.map(lot => ({ ...lot, id: lot.id }))); }
  catch (error) {
    // A real stock-history discrepancy remains a visible costing outcome; it
    // must not turn a bill correction into a forced inventory repair. Missing
    // infrastructure or an incomplete bounded read still rolls the edit back.
    if (!(error instanceof CostEvidenceError) || error.code.endsWith("_LIMIT")) throw error;
    custodyIssue = `The saved stock history does not establish an exact inventory value: ${error.message}`;
  }
  return lots.map(lot => {
    const lotId = costInteger(lot.id, "lotId", 1), onHandUnits = costInteger(lot.qty_on_hand, "onHandUnits");
    const valuation = available.get(lotId);
    return {
      lotId, lotNumber: String(lot.lot_number), onHandUnits,
      originalLotTotalMills: exact.has(lotId) ? moneyToSafeNumber(lotCostTotals(lot).totals.totalMills, "original lot value") : null,
      onHandValueMills: onHandUnits === 0 ? 0 : valuation?.quantity === onHandUnits
        ? moneyToSafeNumber(valuation.costs.totalMills, "on-hand value") : null,
      valueReviewReason: onHandUnits === 0 || valuation?.quantity === onHandUnits ? null : custodyIssue
        ?? "The exact value of this lot's remaining stock is not yet verified from its cost history.",
    };
  });
}
export type InvoiceCorrectionInventoryValues = Awaited<ReturnType<typeof readInvoiceCorrectionInventoryValues>>;
