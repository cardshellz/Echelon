import type { CostIssue, CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import {
  reconciliationBalanceSchema,
  reconciliationDestinationSchema,
  type ReconciliationBalance,
  type ReconciliationDestination,
  type ReconciliationContext,
  type ReconciliationState,
} from "@shared/procurement/cost-reconciliation";
import { costFingerprint, costInteger } from "../infrastructure/cost-evidence-values";

export interface ReconciliationEligibility {
  amountMills: number;
  identity: string;
}
export interface ReconciliationRecordEvidence {
  record: ReconciliationContext["records"][number];
  hasCogs: boolean;
  hasContribution: boolean;
  hasLegacyCogs: boolean;
  hasPhysicalCommitments: boolean;
  existingLandedMills: number;
}
/** Identity deliberately excludes prices. A reviewed destination follows later
 * cost revisions of the SAME historical quantity; changed history needs review. */
export function reconciliationEligibility(
  source: CostSourceRevision,
  issues: CostIssue[],
  records: ReconciliationRecordEvidence[] = [],
): ReconciliationEligibility | null {
  if (
    source.currency !== "USD" ||
    source.issue ||
    source.totalMills === null ||
    source.totalMills < 0 ||
    !["estimated", "confirmed"].includes(source.evidence) ||
    issues.length === 0
  )
    return null;
  if (source.component === "landed" && source.scope.kind === "shipment_line" && issues.every((issue) => issue.code === "COST_HISTORICAL_LINEAGE_MISSING") && records.length > 0)
    return {
      amountMills: source.totalMills,
      identity: costFingerprint({
        scope: source.scope,
        basePieces: source.basePieces,
        missing: records
          .map(({ record, hasCogs, hasLegacyCogs, hasContribution, hasPhysicalCommitments, existingLandedMills }) => ({
            lotId: record.lotId,
            originalQuantity: record.originalQuantity,
            receiptId: record.receiptId,
            receiptLineId: record.receiptLineId,
            hasOnHand: record.onHandQuantity !== 0,
            hasCogs,
            hasLegacyCogs,
            hasContribution,
            hasPhysicalCommitments,
            hasLandedCost: existingLandedMills !== 0,
          }))
          .sort((a, b) => a.lotId - b.lotId),
      }),
    };
  if (
    !issues.every(
      (issue) => issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED" && issue.unresolvedQuantity?.component === source.component,
    )
  )
    return null;
  const gaps = issues.map((issue) => issue.unresolvedQuantity!).sort((a, b) => a.allocationId - b.allocationId);
  if (new Set(gaps.map((gap) => gap.allocationId)).size !== gaps.length) return null;
  const amountMills = costInteger(
    gaps.reduce((sum, gap) => sum + BigInt(gap.amountMills), BigInt(0)).toString(),
    "historicalAmountMills",
  );
  if (amountMills > source.totalMills) return null;
  return {
    amountMills,
    identity: costFingerprint({
      scope: source.scope,
      basePieces: source.basePieces,
      legacyCostLots: records
        .filter((record) => record.hasLegacyCogs)
        .map((record) => record.record.lotId)
        .sort((a, b) => a - b),
      gaps: gaps.map((gap) => ({
        allocationId: gap.allocationId,
        lotId: gap.inventoryLotId,
        quantity: gap.quantity,
        originalQuantity: gap.originalQuantity,
      })),
    }),
  };
}

export function reconciliationBlocker(
  source: CostSourceRevision,
  issues: CostIssue[],
  records: ReconciliationRecordEvidence[],
  hasKnownRoots: boolean,
): string | null {
  if (!reconciliationEligibility(source, issues, records))
    return "This issue needs its source evidence corrected before a financial adjustment can be approved.";
  if (!records.length) return "The affected inventory records could not be verified.";
  if (records.some((row) => row.hasLegacyCogs))
    return "Older order cost records exist for these lots. Reconcile those links before posting another expense.";
  if (issues.some((issue) => issue.code === "COST_HISTORICAL_LINEAGE_MISSING")) {
    if (
      records.some(
        (row) =>
          row.record.onHandQuantity !== 0 ||
          row.record.originalQuantity === 0 ||
          row.hasPhysicalCommitments ||
          row.hasCogs ||
          row.hasContribution ||
          row.existingLandedMills !== 0,
      )
    ) {
      return "This receipt has stock or existing costs that require attribution. Review its recorded history before booking a historical adjustment.";
    }
    if (hasKnownRoots)
      return "This shipment line also has receipt cost allocations. Reconcile the missing receipt separately to avoid counting its charge twice.";
  }
  return null;
}

export function reconciliationState(
  eligible: ReconciliationEligibility | null,
  ledger: {
    approval: { fingerprint: string; destination: ReconciliationDestination } | null;
    balances: ReconciliationBalance;
  },
): ReconciliationState {
  reconciliationBalanceSchema.parse(ledger.balances);
  const postedMills = costInteger(
    (BigInt(ledger.balances.historical_cogs) + BigInt(ledger.balances.inventory_variance)).toString(),
    "postedMills",
  );
  const unassignedMills = costInteger(
    (BigInt(eligible?.amountMills ?? 0) - BigInt(postedMills)).toString(),
    "unassignedMills",
    -Number.MAX_SAFE_INTEGER,
  );
  const matches =
    eligible &&
    ledger.approval?.fingerprint === eligible.identity &&
    ledger.balances[ledger.approval.destination] === eligible.amountMills;
  return {
    status: matches && unassignedMills === 0 ? "posted" : postedMills > 0 ? "review_required" : "unresolved",
    postedMills,
    unassignedMills,
    destination: ledger.approval?.destination ?? null,
  };
}

export function reconciliationTargets(
  amountMills: number,
  destination: ReconciliationDestination,
): ReconciliationBalance {
  costInteger(amountMills, "reconciliationAmount");
  reconciliationDestinationSchema.parse(destination);
  return { historical_cogs: 0, inventory_variance: 0, [destination]: amountMills };
}
export function reconciliationDeltas(before: ReconciliationBalance, after: ReconciliationBalance) {
  reconciliationBalanceSchema.parse(before);
  reconciliationBalanceSchema.parse(after);
  return reconciliationDestinationSchema.options.flatMap((destination) =>
    before[destination] === after[destination]
      ? []
      : [
          {
            destination,
            beforeMills: before[destination],
            afterMills: after[destination],
            deltaMills: costInteger(
              (BigInt(after[destination]) - BigInt(before[destination])).toString(),
              "reconciliationDelta",
              -Number.MAX_SAFE_INTEGER,
            ),
          },
        ],
  );
}
