import { Link } from "wouter";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { Button } from "@/components/ui/button";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";

export function CostLinkRepairAction({
  shipmentId,
  lineId,
  issues,
}: {
  shipmentId: number;
  lineId: number;
  issues: readonly CostIssue[];
}) {
  const navigation = useProcurementNavigation();
  const historyIssues = issues.filter((issue) =>
    [
      "COST_HISTORICAL_LINEAGE_MISSING",
      "COST_UNRESOLVED_QUANTITY_RETAINED",
    ].includes(issue.code),
  );
  if (!historyIssues.length) return null;
  if (historyIssues.every((issue) => issue.costLinksAlreadyReviewed)) {
    return (
      <p className="text-xs text-muted-foreground">
        Transfer and repacking links have already been reviewed. The remaining
        quantities need stock movement evidence; repeating that approval will
        not resolve them.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" asChild>
        <Link
          href={navigation.childHref(`/shipments/${shipmentId}?tab=lines`, {
            shipmentCostRepairLineId: lineId,
          })}
        >
          Review transfer and repacking links
        </Link>
      </Button>
      <p className="text-xs text-muted-foreground">
        Restore costs from the recorded stock history. Review the before and
        after before approving.
      </p>
    </div>
  );
}
