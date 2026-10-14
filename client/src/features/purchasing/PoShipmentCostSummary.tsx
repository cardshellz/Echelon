import { useQuery } from "@tanstack/react-query";
import { poShipmentCostSummarySchema } from "@shared/procurement/po-shipment-cost-summary";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function PoShipmentCostSummary({
  purchaseOrderId,
  onViewShipments,
}: {
  purchaseOrderId: number;
  onViewShipments: () => void;
}) {
  const query = useQuery({
    queryKey: [
      `/api/purchase-orders/${purchaseOrderId}`,
      "shipment-cost-summary",
    ],
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/purchase-orders/${purchaseOrderId}/shipment-cost-summary`,
      );
      return poShipmentCostSummarySchema.parse(await response.json());
    },
  });
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
  const costs = query.data;
  if (costs.shipmentCount === 0) return null;
  const money = (cents: number) => formatIntegerCents(cents, costs.currency);
  const amounts = [
    ["Shipment freight", costs.freightCents],
    ["Shipment duties / tax", costs.dutyCents],
    ["Other shipment charges", costs.otherCents],
    ["PO + shipment costs", costs.combinedCostCents],
  ] as const;
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {amounts.map(([label, amount]) => (
            <div key={label}>
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="font-mono font-semibold">
                {amount === null ? "Incomplete" : money(amount)}
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-1 text-sm" role="status">
          <p>
            Allocated shipment charges:{" "}
            <strong>{money(costs.totalCents)}</strong>
          </p>
          {costs.estimatedCents !== 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {money(costs.estimatedCents)} is estimated or awaiting
              confirmation.
            </p>
          )}
          {costs.unallocatedChargeCount > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {costs.unallocatedChargeCount} charge
              {costs.unallocatedChargeCount === 1 ? "" : "s"}{" "}
              {costs.unallocatedChargeCount === 1 ? "needs" : "need"}{" "}
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
              Inventory costing needs review
              {costs.reviewLines > 0
                ? ` on ${costs.reviewLines} shipment line${costs.reviewLines === 1 ? "" : "s"}`
                : ""}
              . Open the shipments to review or retry the cost update.
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
      </CardContent>
    </Card>
  );
}
