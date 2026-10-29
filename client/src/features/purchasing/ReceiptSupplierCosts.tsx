import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePoShipmentCosts } from "./use-po-shipment-costs";
import { useShipmentCostReview } from "./use-shipment-cost-review";
import { CostReviewPanel } from "./CostReviewPanel";
import { poCostReviewShipments, shipmentCostReviewLines } from "@shared/procurement/cost-review-adapters";

/** A receipt can belong to a consolidated shipment. Scope by receipt membership,
 * not SKU or the shipment's first PO, and reuse the current posting projection. */
export function ReceiptSupplierCosts({
  receiptId,
  purchaseOrderId,
  shipmentId,
  navigation,
}: {
  receiptId: number;
  purchaseOrderId: number | null;
  shipmentId: number | null;
  navigation: ProcurementNavigation;
}) {
  const purchase = usePoShipmentCosts(
    shipmentId === null ? purchaseOrderId : null,
  );
  const shipment = useShipmentCostReview(shipmentId);
  if (shipmentId === null && purchaseOrderId === null) return null;
  const review = shipmentId !== null ? shipment : purchase;
  const supplier = review.data?.supplierCosts;
  const lines = supplier?.lines.filter((line) =>
    line.receipts.some((receipt) => receipt.receiptId === receiptId),
  );
  const purchaseLineIds = new Set(lines?.map(line => line.purchaseOrderLineId));
  const shipmentLines = shipmentId !== null && shipment.data ? shipmentCostReviewLines(shipment.data)
    : purchase.data ? poCostReviewShipments(purchase.data) : [];
  return (
    <Card role="region" aria-label="Receipt supplier cost status">
      <CardContent className="p-3 space-y-3">
        {review.isPending && (
          <p role="status">Loading current receipt costs…</p>
        )}
        {review.isError && (
          <div role="alert">
            Current receipt costs could not be loaded.{" "}
            <Button variant="outline" onClick={() => void review.refetch()}>
              Reload receipt costs
            </Button>
          </div>
        )}
        {review.isSuccess &&
          (lines?.length ? (
            <CostReviewPanel
              supplier={{ lines }}
              shipments={shipmentLines.filter(line => line.purchaseOrderLineId !== null && purchaseLineIds.has(line.purchaseOrderLineId))}
              navigation={navigation}
            />
          ) : (
            <p className="text-sm">
              {supplier
                ? "No supplier cost lines are linked to this receipt."
                : "Current supplier cost evidence is unavailable. Reload the receipt after the cost service is available."}
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
