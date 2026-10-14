import { useState } from "react";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePoShipmentCosts } from "./use-po-shipment-costs";
import { PoShipmentCostReview } from "./PoShipmentCostReview";

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
  if (costs.shipmentCount === 0) return null;
  const money = (cents: number) => formatIntegerCents(cents, costs.currency);
  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <div>
            <h2 className="text-sm font-semibold">Shipment costs</h2>
            <p className="text-xs text-muted-foreground">
              Charges allocated to this PO from {costs.shipmentCount} shipment
              {costs.shipmentCount === 1 ? "" : "s"}.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onViewShipments}>
            View shipments
          </Button>
        </div>
        <div className="space-y-1 text-sm" role="status">
          <p>
            Allocated shipment charges:{" "}
            <strong>{money(costs.totalCents)}</strong>
          </p>
          {costs.otherCents !== 0 && (
            <p>
              Other shipment charges included in total cost:{" "}
              <strong>{money(costs.otherCents)}</strong>
            </p>
          )}
          {costs.estimatedCents !== 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {money(costs.estimatedCents)} is estimated or awaiting
              confirmation.
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
          {costs.inventoryCosting === "review_required" && (
            <p className="text-destructive">
              {costs.reviewLines > 0
                ? `${costs.reviewLines} shipment line${costs.reviewLines === 1 ? " has" : "s have"} a recorded cost update that needs review.`
                : "Shipment charge evidence needs review before inventory costs can be updated."}
            </p>
          )}
          {costs.inventoryCosting === "pending" && (
            <p className="text-amber-700 dark:text-amber-400">
              Inventory costing is awaiting receipt, confirmed charges or a cost
              update.
            </p>
          )}
          {costs.inventoryCosting === "applied" && (
            <p className="text-green-700 dark:text-green-400">
              Confirmed shipment costs applied to inventory.
            </p>
          )}
        </div>
        {(costs.reviewLines > 0 || costs.pendingLines > 0 || showReview) && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showReview}
            onClick={() => setShowReview(!showReview)}
          >
            {showReview
              ? "Hide cost review"
              : costs.reviewLines > 0
                ? `Review ${costs.reviewLines} line${costs.reviewLines === 1 ? "" : "s"}`
                : "Review inventory costs"}
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
