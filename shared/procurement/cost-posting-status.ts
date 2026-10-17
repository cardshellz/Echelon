import { canonicalJson } from "../utils/canonical-json";
import { costIssueSchema, type CostIssue } from "./cost-source-contracts";
import { shipmentCostExceptionSchema, type ShipmentCostException } from "./shipment-cost-exception";

export type CostPostingStatus = "pending" | "review_required" | "applied";

/** Posting and supplier confirmation are independent. Callers must establish
 * current source identity before a saved application can prove completion. */
export function resolveCostPostingStatus(input: {
  sourceCurrent: boolean;
  sourceIssue: boolean;
  applicationStatus: string | null;
  reconciled: boolean;
}): CostPostingStatus {
  if (input.sourceIssue !== false) return "review_required";
  if (input.reconciled === true && input.applicationStatus !== "review_required") return "review_required";
  if (input.sourceCurrent === true && input.reconciled === true) return "applied";
  if (input.applicationStatus === "review_required" || input.applicationStatus === "retry_required") return "review_required";
  if (![null, "pending", "applied"].includes(input.applicationStatus)) return "review_required";
  if (input.sourceCurrent !== true) return "pending";
  return input.applicationStatus === "applied" ? "applied" : "pending";
}

/** Only these recorded history gaps can be resolved by the existing approved
 * historical-cost owner. A new issue kind needs its own explicit authority. */
export function isHistoricalCostIssue(issue: CostIssue): boolean {
  const parsed = costIssueSchema.safeParse(issue);
  return parsed.success && (parsed.data.code === "COST_HISTORICAL_LINEAGE_MISSING"
    ? parsed.data.unresolvedQuantity === undefined
    : parsed.data.code === "COST_UNRESOLVED_QUANTITY_RETAINED" && parsed.data.unresolvedQuantity?.component === "landed");
}

/** A posted balance resolves exactly the retained issues that were reviewed.
 * An acceptance alone, a different issue set, or an unbalanced posting is not
 * financial completion. Current source/revision linkage remains the read owner. */
export function isCostReconciliationPosted(
  applicationIssues: readonly CostIssue[],
  exceptionReview: ShipmentCostException | null | undefined,
): boolean {
  const parsed = shipmentCostExceptionSchema.safeParse(exceptionReview);
  if (!parsed.success || !Array.isArray(applicationIssues) || applicationIssues.length === 0) return false;
  const review = parsed.data;
  if (review.amountMills > review.allocatedMills || !review.issues.every(isHistoricalCostIssue)) return false;
  if (review.kind === "missing_receipt_history") {
    if (!review.issues.every(issue => issue.code === "COST_HISTORICAL_LINEAGE_MISSING" && issue.unresolvedQuantity === undefined)
      || review.amountMills !== review.allocatedMills) return false;
  } else {
    if (!review.issues.every(issue => issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED" && issue.unresolvedQuantity?.component === "landed")) return false;
    const quantities = review.issues.map(issue => issue.unresolvedQuantity!);
    if (new Set(quantities.map(quantity => quantity.allocationId)).size !== quantities.length
      || quantities.reduce((sum, quantity) => sum + BigInt(quantity.amountMills), BigInt(0)) !== BigInt(review.amountMills)) return false;
  }
  const posting = review.reconciliation;
  if (posting?.status !== "posted" || posting.unassignedMills !== 0 || posting.destination === null
    || posting.postedMills !== review.amountMills) return false;
  const reviewed = new Set(review.issues.map(canonicalJson));
  if (reviewed.size !== review.issues.length || applicationIssues.length !== reviewed.size) return false;
  const issues = applicationIssues.map(issue => costIssueSchema.safeParse(issue));
  if (issues.some(issue => !issue.success)) return false;
  const recorded = new Set(applicationIssues.map(canonicalJson));
  return recorded.size === applicationIssues.length && [...recorded].every(issue => reviewed.has(issue));
}
