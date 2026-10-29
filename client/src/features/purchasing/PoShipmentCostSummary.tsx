import { noInventoryEffectLabel } from "./cost-inventory-effect-presentation";
import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePoShipmentCosts } from "./use-po-shipment-costs";
import { PoShipmentCostReview } from "./PoShipmentCostReview";
import { purchaseLineNeedsCostReview, purchaseLineInventoryEffect } from "@shared/procurement/purchase-cost-status";
import { buildCostReviewGroups, costReviewSummary } from "@shared/procurement/cost-review-tasks";
import { poCostReviewShipments } from "@shared/procurement/cost-review-adapters";

export function PoShipmentCostSummary({
  purchaseOrderId,
  query,
  onViewShipments,
}: {
  purchaseOrderId: number;
  query: ReturnType<typeof usePoShipmentCosts>;
  onViewShipments: () => void;
}) {
  const [showReview, setShowReview] = useState(false);
  const search = useSearch();
  useEffect(() => {
    if (new URLSearchParams(search).get("costReview") === "1") setShowReview(true);
  }, [search]);
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading shipment costs…
      </p>
    );
  if (query.isError)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 text-sm text-destructive"
      >
        <span>Shipment costs could not be loaded.</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  const costs = query.data.summary;
  const supplierReturns = query.data.supplierCosts?.lines.filter(line => purchaseLineInventoryEffect(line) !== null).length ?? 0;
  if (costs.shipmentCount === 0 && supplierReturns === 0 && !query.data.supplierCosts?.lines.length) return null;
  const money = (cents: number) => formatIntegerCents(cents, costs.currency);
  const posted = query.data.lines.filter(line => line.status === "applied" && line.exceptionReview?.reconciliation?.status === "posted").length;
  const supplierReviews = query.data.supplierCosts?.lines.filter(purchaseLineNeedsCostReview).length ?? 0;
  const groups = buildCostReviewGroups(query.data.supplierCosts, poCostReviewShipments(query.data));
  const taskCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <div>
            <h2 className="text-sm font-semibold">Purchase costs</h2>
            <p className="text-xs text-muted-foreground">
              {costs.shipmentCount === 0 ? "Supplier costs for this PO. No shipment charges are recorded." : `Charges allocated to this PO from ${costs.shipmentCount} shipment${costs.shipmentCount === 1 ? "" : "s"}.`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onViewShipments}>
            View shipments
          </Button>
        </div>
        <div className="space-y-1 text-sm" role="status">
          <div className="rounded-md bg-muted/50 p-3 mb-3" data-testid="po-landed-cost-breakdown">
            <p className="font-semibold">Total landed cost</p>
            <p className="font-mono text-lg font-bold">{costs.combinedCostCents === null ? "Incomplete" : money(costs.combinedCostCents)}</p>
            <p className="text-xs text-muted-foreground">Supplier PO {money(costs.poAmountCents)} + shipment charges {money(costs.totalCents)}. Includes product, packaging and saved freight, duties and other charges.</p>
          </div>
          {costs.otherCents !== 0 && <p>Other shipping charges included in total: <strong>{money(costs.otherCents)}</strong></p>}
          {costs.estimatedCents !== 0 && (
            <p className="text-muted-foreground">
              <strong>Supplier confirmation:</strong> {money(costs.estimatedCents)} uses estimated or unconfirmed charges.
              {costs.inventoryCosting === "applied" ? " Their costs are already posted. Confirm the final charges when the supplier invoice is available." : " Check the final charges against the supplier invoice."}
            </p>
          )}
          {costs.unallocatedChargeCount > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {costs.unallocatedChargeCount} charge
              {costs.unallocatedChargeCount === 1 ? " needs" : "s need"}{" "}
              allocation. The combined cost is incomplete.
            </p>
          )}
          {costs.unsupportedCurrencyCount > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              Some shipment charges use another currency. Review their
              conversion before calculating the combined cost.
            </p>
          )}
          <p className={taskCount > 0 ? "text-amber-800 dark:text-amber-300" : "text-green-800 dark:text-green-300"}>
            {taskCount > 0 || costs.inventoryCosting === "applied" ? costReviewSummary(groups, query.data.supplierCosts ? "all" : "shipping") : "Open the cost details to check the recorded shipment costs."}
          </p>
          {supplierReturns > 0 && <p className="text-green-700 dark:text-green-400">{supplierReturns} PO line{supplierReturns === 1 ? "" : "s"}: {noInventoryEffectLabel}.</p>}
        </div>
        {(groups.length > 0 || costs.reviewLines > 0 || costs.pendingLines > 0 || posted > 0 || supplierReviews > 0 || supplierReturns > 0 || showReview) && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showReview}
            onClick={() => setShowReview(!showReview)}
          >
            {showReview
              ? "Hide cost details"
              : taskCount > 0 ? "Review costs"
                : "View completed costs"}
          </Button>
        )}
        {showReview && (
          <PoShipmentCostReview
            purchaseOrderId={purchaseOrderId}
            costs={query.data}
          />
        )}
      </CardContent>
    </Card>
  );
}
