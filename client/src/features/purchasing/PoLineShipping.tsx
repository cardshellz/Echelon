import { useEffect, useRef } from "react";
import { Link } from "wouter";
import type { PurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";

export function PoLineShippingQuantity({ progress, kind, loading }: {
  progress?: PurchaseLineShipping;
  kind: "shipped" | "remaining";
  loading: boolean;
}) {
  if (!progress) return <span className="text-xs text-muted-foreground">{loading ? "Loading…" : "Unavailable"}</span>;
  const pieces = kind === "shipped" ? progress.shippedPieces : progress.stillToShipPieces;
  return <div className="tabular-nums">
    <span>{pieces === null ? "Unverified" : pieces.toLocaleString()}</span>
    {kind === "shipped" && !progress.quantitiesComplete && <p className="text-xs text-amber-700">Verified links only</p>}
    {kind === "remaining" && progress.plannedPieces > 0 && <p className="text-xs text-muted-foreground">{progress.plannedPieces.toLocaleString()} planned</p>}
    {kind === "remaining" && (progress.line.cancelledPieces ?? 0) > 0 && <p className="text-xs text-muted-foreground">{progress.line.cancelledPieces!.toLocaleString()} cancelled</p>}
  </div>;
}

const statusLabels: Record<string, string> = {
  draft: "Planned · Draft", booked: "Planned · Booked", in_transit: "Shipped · In transit",
  at_port: "Shipped · At port", customs_clearance: "Shipped · Customs", delivered: "Delivered",
  costing: "Delivered · Cost review", closed: "Closed", cancelled: "Cancelled · Not counted",
};

/** Each link identifies the saved shipment line and records this PO tab/line in
 * the existing URL journey, so Back works after reload and in copied links. */
export function PoLineShipmentLinks({ progress, loading, navigation, poNumber }: {
  progress?: PurchaseLineShipping; loading: boolean; navigation: ProcurementNavigation; poNumber: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = navigation.record?.relationship?.line;
  const returning = progress?.shipments.some(shipment => shipment.shipmentLineId === selected) ?? false;
  useEffect(() => {
    // The PO has desktop and mobile markup. Focus only the visible copy.
    if (returning && ref.current?.getClientRects().length) {
      ref.current.scrollIntoView({ block: "center" });
      ref.current.focus({ preventScroll: true });
    }
  }, [returning]);
  if (!progress) return <span className="text-xs text-muted-foreground">{loading ? "Loading shipment links…" : "Shipment links unavailable"}</span>;
  return <div ref={ref} role="group" tabIndex={-1} className="space-y-2 text-xs min-w-0 rounded focus:outline-primary"
    aria-label={`Shipments for PO line ${progress.line.lineNumber}`}>
    {progress.shipments.length === 0 && <span className="text-muted-foreground">No linked shipments</span>}
    {progress.shipments.map(shipment => <div key={shipment.shipmentLineId}>
      <Link className="font-medium text-primary underline underline-offset-2 break-all"
        href={navigation.childHref(`/shipments/${shipment.shipmentId}?tab=lines&poScope=${progress.line.purchaseId}&shipmentLine=${shipment.shipmentLineId}&document=${encodeURIComponent(shipment.shipmentNumber)}`,
          { currentLabel: poNumber, currentRelationship: { po: progress.line.purchaseId, line: shipment.shipmentLineId } })}>
        {shipment.shipmentNumber}
      </Link>
      <p className="tabular-nums">{shipment.pieces.toLocaleString()} pcs · {statusLabels[shipment.status] ?? "Status unknown"}</p>
      {shipment.linkIssue && <p className="text-amber-700">PO links disagree · Not counted</p>}
    </div>)}
    {progress.issues.length > 0 && <div className="text-amber-700 space-y-1">
      {progress.issues.map(issue => <p key={issue}>{issue}</p>)}
      <Link href={navigation.childHref(`/purchase-orders/${progress.line.purchaseId}?tab=shipments&poScope=${progress.line.purchaseId}&document=${encodeURIComponent(poNumber)}`,
        { currentLabel: poNumber })} className="underline">Review shipment links</Link>
    </div>}
  </div>;
}
