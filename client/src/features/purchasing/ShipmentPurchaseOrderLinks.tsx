import { Link } from "wouter";
import { shipmentPurchaseOrderReferencesSchema } from "@shared/procurement/shipment-purchase-orders";

type Props = {
  purchaseOrders: unknown;
  legacyPurchaseOrderIds?: unknown[];
  hrefFor: (purchaseOrderId: number) => string;
};

export function ShipmentPurchaseOrderLinks({ purchaseOrders, legacyPurchaseOrderIds = [], hrefFor }: Props) {
  // Older cached detail responses expose only IDs. Keep those links usable until
  // refresh; a malformed new projection must never be presented as no purchases.
  const parsed = shipmentPurchaseOrderReferencesSchema.safeParse(purchaseOrders);
  if (purchaseOrders !== undefined && !parsed.success) {
    return <span role="status" className="text-sm text-destructive">Purchase links unavailable</span>;
  }
  const references = parsed.success ? parsed.data : [...new Set(
    legacyPurchaseOrderIds.filter((id): id is number => typeof id === "number"
      && Number.isInteger(id) && id > 0 && id <= 2_147_483_647),
  )].map((id) => ({ id, poNumber: `PO #${id}` }));

  if (!parsed.success && references.length === 0) {
    return <span role="status" className="text-sm text-destructive">Purchase links unavailable</span>;
  }
  if (references.length === 0) return <span className="text-muted-foreground">No linked purchase orders</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {references.map((purchase) => (
        <Link
          key={purchase.id}
          href={hrefFor(purchase.id)}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex min-h-[44px] items-center break-words font-mono text-sm text-primary hover:underline md:min-h-0"
        >
          {purchase.poNumber}
        </Link>
      ))}
    </div>
  );
}
