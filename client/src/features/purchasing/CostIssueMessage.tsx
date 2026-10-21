import type { CostIssue } from "@shared/procurement/cost-source-contracts";

export function CostIssueMessage({ issue }: { issue: CostIssue }) {
  return (
    <>
      {issue.message}
      {issue.orderCostReview && (
        <a
          className="ml-1 underline text-primary"
          href={`/orders?orderId=${issue.orderCostReview.orderId}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Review order #{issue.orderCostReview.orderId}
        </a>
      )}
    </>
  );
}
