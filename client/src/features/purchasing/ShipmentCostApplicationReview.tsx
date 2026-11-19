import React from "react";
import { shipmentCostReviewLines } from "@shared/procurement/cost-review-adapters";
import { useShipmentCostReview } from "./use-shipment-cost-review";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { CostReviewPanel } from "./CostReviewPanel";

export function ShipmentCostApplicationReview({ shipmentId }: { shipmentId: number }) {
  const navigation = useProcurementNavigation();
  const review = useShipmentCostReview(shipmentId);
  return <Card role="region" aria-label="Inventory cost results">
    <CardContent className="p-4 space-y-3 text-sm">
      {review.isPending && <p role="status">Loading current costs…</p>}
      {review.isError && <div role="alert" className="space-y-2"><p>Current costs could not be loaded. Reload before deciding whether another update is needed.</p>
        <Button variant="outline" onClick={() => void review.refetch()}>Reload cost results</Button></div>}
      {review.isSuccess && <CostReviewPanel supplier={review.data.supplierCosts} shipments={shipmentCostReviewLines(review.data)} navigation={navigation} showShipmentUpdates={false} />}
    </CardContent>
  </Card>;
}
