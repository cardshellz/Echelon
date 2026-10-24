import { Badge } from "@/components/ui/badge";
import { purchaseOrderStatus, type PurchaseOrderStatusSource } from "@shared/procurement/purchase-order-status";

export function PurchaseOrderStatusBadge({ purchaseOrder }: { purchaseOrder: PurchaseOrderStatusSource }) {
  const status = purchaseOrderStatus(purchaseOrder);
  return <Badge data-testid="purchase-order-status" variant={status.code === "cancelled" ? "destructive"
    : ["closed", "short_closed", "draft"].includes(status.code) ? "secondary" : "outline"}>
    {status.label}
  </Badge>;
}
