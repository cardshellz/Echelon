import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePoShipmentCosts } from "./use-po-shipment-costs";
import { useShipmentCostReview } from "./use-shipment-cost-review";
import { PurchaseSupplierCostReview } from "./PurchaseSupplierCostReview";

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
            <PurchaseSupplierCostReview
              status={{ lines }}
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
