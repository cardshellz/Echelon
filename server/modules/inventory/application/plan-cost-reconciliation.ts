import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import {
  reconciliationBlocker,
  reconciliationDeltas,
  reconciliationEligibility,
  reconciliationTargets,
} from "../domain/cost-reconciliation";
import {
  CostEvidenceError,
  type CostEvidenceTransaction,
  type RecordedCostRevision,
} from "../infrastructure/cost-evidence.repository";
import {
  hasReconciliationRoots,
  readReconciliationLedger,
  readReconciliationRecords,
  reconciliationScope,
  type CostReconciliationPlan,
} from "../infrastructure/cost-reconciliation.repository";

/** Called under the inventory graph lock, before applying stock/order costs. */
export async function planCostReconciliation(
  tx: CostEvidenceTransaction,
  revision: RecordedCostRevision,
  issues: CostIssue[],
  fullyApplied: boolean,
): Promise<CostReconciliationPlan | null> {
  const source = revision.contract;
  const ledger = await readReconciliationLedger(tx, reconciliationScope(source));
  if (!ledger.approval) return null;
  const records = await readReconciliationRecords(tx, source, issues);
  const eligible = reconciliationEligibility(source, issues, records);
  if (
    !eligible &&
    issues.length === 0 &&
    !fullyApplied &&
    (ledger.balances.historical_cogs > 0 || ledger.balances.inventory_variance > 0)
  ) {
    // A partially restored receipt must not add tracked costs while retaining
    // the expense for the whole shipment. Abort both writes until its remaining
    // source interval is attributable; do not manufacture a residual destination.
    throw new CostEvidenceError(
      "COST_RECONCILIATION_PARTIAL_HISTORY",
      "Restored receipt history does not cover the full shipment quantity. Complete its receipt attribution before replacing the historical cost adjustment.",
    );
  }
  if (!eligible && !(issues.length === 0 && fullyApplied)) return null;
  const approved =
    eligible &&
    ledger.approval.fingerprint === eligible.identity &&
    !reconciliationBlocker(source, issues, records, await hasReconciliationRoots(tx, source));
  // Changed history invalidates attribution. Reverse the old expense in the
  // same transaction as any newly known stock/order cost; require a new review
  // for what remains. Retaining both would count the historical charge twice.
  const historicalAmountMills = approved ? eligible.amountMills : 0;
  const targets = reconciliationTargets(historicalAmountMills, ledger.approval.destination);
  return {
    ledger,
    targets,
    identity: {
      approvalId: ledger.approval.id,
      historicalAmountMills,
      evidenceFingerprint: eligible?.identity ?? "restored_history",
    },
    matches:
      reconciliationDeltas(ledger.balances, targets).length === 0 &&
      ledger.lastIds[ledger.approval.destination] !== undefined,
  };
}
