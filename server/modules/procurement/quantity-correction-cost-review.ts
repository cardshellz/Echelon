import type {
  CostIssue,
  CostSourceRevision,
} from "@shared/procurement/cost-source-contracts";
import {
  reconciliationBalanceSchema,
  type ReconciliationBalance,
  type ReconciliationDestination,
} from "@shared/procurement/cost-reconciliation";
import type { QuantityCorrectionSummary } from "@shared/procurement/receipt-shipment-quantity-correction";
import {
  reconciliationEligibility,
  type ReconciliationRecordEvidence,
} from "../inventory/domain/cost-reconciliation";
import { costInteger } from "../inventory/infrastructure/cost-evidence.repository";

export interface QuantityCorrectionCostReview {
  unassignedMills: number | null;
  needsHistoryReview: boolean;
  affectedLots: NonNullable<
    QuantityCorrectionSummary["shipmentCostReview"]
  >["affectedLots"];
  postedMills: number;
  destination: ReconciliationDestination | null;
}

/** Report only amounts justified by the saved application. A missing cost link
 * does not prove that the entire shipment charge is still unassigned. */
export function summarizeQuantityCorrectionCostReview(input: {
  source: CostSourceRevision | null;
  status: string | null;
  issues: CostIssue[] | null;
  records: ReconciliationRecordEvidence[];
  hasKnownRoots: boolean;
  balances: ReconciliationBalance;
  destination: ReconciliationDestination | null;
}): QuantityCorrectionCostReview {
  const balances = reconciliationBalanceSchema.parse(input.balances);
  const postedMills = costInteger(
    (
      BigInt(balances.historical_cogs) + BigInt(balances.inventory_variance)
    ).toString(),
    "posted cost",
  );
  const { source, issues, records } = input;
  const result: QuantityCorrectionCostReview = {
    unassignedMills: null,
    needsHistoryReview: false,
    affectedLots: [],
    postedMills,
    destination: input.destination,
  };
  if (!source || issues === null) return result;
  result.needsHistoryReview = issues.some((issue) =>
    [
      "COST_HISTORICAL_LINEAGE_MISSING",
      "COST_UNRESOLVED_QUANTITY_RETAINED",
      "COST_EXISTING_POSTING_PRESERVED",
    ].includes(issue.code),
  );
  result.affectedLots = records.map(({ record }) => ({
    lotId: record.lotId,
    lotNumber: record.lotNumber,
    receiptId: record.receiptId,
    receivedUnits: record.originalQuantity,
    onHandUnits: record.onHandQuantity,
  }));
  if (input.status === "applied" && issues.length === 0) {
    result.unassignedMills = 0;
    return result;
  }
  const eligible = reconciliationEligibility(source, issues, records);
  const missingOrigins = issues.some(
    (issue) => issue.code === "COST_HISTORICAL_LINEAGE_MISSING",
  );
  const priorAttribution =
    input.hasKnownRoots ||
    records.some(
      (record) =>
        record.existingLandedMills !== 0 ||
        record.hasCogs ||
        record.hasLegacyCogs ||
        record.hasContribution,
    );
  if (eligible && !(missingOrigins && priorAttribution)) {
    const remaining = BigInt(eligible.amountMills) - BigInt(postedMills);
    // An over-posting needs its own review, not a fabricated zero balance.
    if (remaining >= BigInt(0))
      result.unassignedMills = costInteger(
        remaining.toString(),
        "unassigned cost",
      );
  }
  return result;
}
