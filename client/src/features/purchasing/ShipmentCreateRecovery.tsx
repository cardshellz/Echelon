import { Button } from "@/components/ui/button";
import type { ShipmentCreateRecovery as Recovery } from "@/lib/shipment-create-command";

export function ShipmentCreateRecovery({ recovery, error, pending, onRetry, onRefresh }: {
  recovery: Recovery | null; error: string | null; pending: boolean; onRetry: (recovery: Recovery) => void; onRefresh: () => void;
}) {
  if (error) return <div role="alert" className="rounded-md border border-destructive p-3 text-sm">{error}<Button type="button" variant="outline" className="mt-2" onClick={onRefresh}>Retry recovery read</Button></div>;
  if (!recovery) return null;
  const selection = recovery.body.purchaseOrder;
  return <div role="alert" className="space-y-2 rounded-md border border-amber-500 p-3 text-sm">
    <p className="font-medium">Shipment creation needs confirmation</p>
    <p>{recovery.body.shipmentNumber ? `${recovery.body.shipmentNumber}. ` : ""}{selection
      ? `Saved request includes ${selection.lineSelections?.length} selected lines from purchase order ${selection.purchaseOrderId}.`
      : "Saved request creates an empty draft shipment."} Recover this request before starting another shipment.</p>
    <p>Recovery checks the original request and opens its shipment when confirmed.</p>
    <Button type="button" variant="outline" disabled={pending} onClick={() => onRetry(recovery)}>{pending ? "Recovering shipment..." : "Recover shipment creation"}</Button>
  </div>;
}
