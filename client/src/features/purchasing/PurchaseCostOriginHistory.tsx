import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { reconciliationDestinations } from "@shared/procurement/cost-reconciliation";
import { Card, CardContent } from "@/components/ui/card";
import { CostOriginRepair, CostOriginRepairSummary } from "./CostOriginRepair";

export function PurchaseCostOriginHistory({
  status,
}: {
  status: PurchaseCostStatus;
}) {
  const repairs = status.lines
    .flatMap((line) =>
      (line.originRepairs ?? []).map((approval) => ({ line, approval })),
    )
    .sort(
      (a, b) =>
        b.approval.recordedAt.localeCompare(a.approval.recordedAt) ||
        b.approval.id - a.approval.id,
    );
  return (
    <section aria-label="Receipt cost repair approvals" className="space-y-3">
      <h3 className="font-semibold">Receipt cost repair approvals</h3>
      <p className="text-xs text-muted-foreground">
        Recorded before and after values for each administrator approval. Later
        changes are shown in the current cost review.
      </p>
      {repairs.length === 0 && (
        <p className="text-sm">No historical receipt cost repairs recorded.</p>
      )}
      {repairs.map(({ line, approval }) => (
        <Card key={approval.id}>
          <CardContent className="space-y-3 p-3 text-sm">
            <strong>
              {line.sku ?? `PO line #${line.purchaseOrderLineId}`} ·{" "}
              {line.lots.find((lot) => lot.id === approval.lotId)?.lotNumber ??
                `Lot #${approval.lotId}`}
            </strong>
            <p>
              Approved by {approval.actorName} ·{" "}
              {new Date(approval.recordedAt).toLocaleString()}
            </p>
            <p>{reconciliationDestinations[approval.destination]}</p>
            <p>{approval.reason}</p>
            <CostOriginRepairSummary summary={approval.summary} />
            <CostOriginRepair lotId={approval.lotId} repaired />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
