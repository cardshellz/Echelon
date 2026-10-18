import { Link } from "wouter";
import {
  shipmentCostReviewGuidance,
  type PoShipmentCosts,
} from "@shared/procurement/po-shipment-costs";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShipmentCostUpdateAction } from "./ShipmentCostUpdateAction";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { ShipmentCostExceptionReview } from "./ShipmentCostExceptionReview";
import { PurchaseSupplierCostReview } from "./PurchaseSupplierCostReview";

export function PoShipmentCostReview({
  costs,
}: {
  purchaseOrderId: number;
  costs: PoShipmentCosts;
}) {
  const navigation = useProcurementNavigation();
  const visible = costs.lines.filter((line) => line.status !== "applied" || line.exceptionReview?.reconciliation?.status === "posted");
  const pending = visible.filter(line => line.status !== "applied");
  const groups = [
    ...new Map(
      visible.map((line) => [
        line.shipmentId,
        {
          id: line.shipmentId,
          number: line.shipmentNumber,
          status: line.shipmentStatus,
        },
      ]),
    ).values(),
  ];
  return (
    <section
      aria-label="Shipment inventory cost review"
      className="space-y-4 border-t pt-3"
    >
      <div>
        <h3 className="font-semibold text-sm">{pending.length ? "Cost updates and approvals" : "Cost postings"}</h3>
        <p className="text-xs text-muted-foreground">
          {pending.length ? "Items still needing attention are shown with their next step. Completed postings include their saved approval."
            : "Shipment charges are posted. Open a posting to see the amount, destination and administrator approval. Supplier product and packaging costs are shown separately below."}
        </p>
      </div>
      {costs.supplierCosts && <PurchaseSupplierCostReview status={costs.supplierCosts} navigation={navigation} />}
      {groups.map((shipment) => (
        <div
          key={shipment.id}
          role="group"
          aria-label={`Cost review for shipment ${shipment.number ?? shipment.id}`}
          className="rounded-md border p-3 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-sm">
              Shipment {shipment.number ?? `#${shipment.id}`}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" asChild>
                <Link href={navigation.childHref(`/shipments/${shipment.id}?tab=allocation`)}>
                  View shipment cost details
                </Link>
              </Button>
            </div>
          </div>
          {["costing", "closed"].includes(shipment.status) && pending.some(line => line.shipmentId === shipment.id
            && (!line.exceptionReview || line.exceptionReview.reconciliation?.status === "review_required")) && <>
          <ShipmentCostUpdateAction key={shipment.id} shipmentId={shipment.id} />
          <p className="text-xs text-muted-foreground">
            This updates the entire shipment, including its other linked POs. Closed-shipment adjustments are recorded automatically.
          </p>
          </>}
          {visible
            .filter((line) => line.shipmentId === shipment.id)
            .map((line) => {
              const guidance = shipmentCostReviewGuidance(line.issues);
              return (
                <div
                  key={line.lineId}
                  className="grid gap-2 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="font-mono text-sm break-all">
                      {line.sku ?? `Shipment line #${line.lineId}`}
                    </div>
                    <div className="text-xs">
                      Allocated charge:{" "}
                      <strong>
                        {formatIntegerCents(
                          line.allocatedCents,
                          costs.summary.currency,
                        )}
                      </strong>
                    </div>
                    {!line.exceptionReview && <Badge
                      variant={
                        line.status === "review_required"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {line.status === "review_required"
                        ? "Needs review"
                        : "Awaiting cost update"}
                    </Badge>}
                    {line.recordedAt && (
                      <div className="text-xs text-muted-foreground">
                        {line.status === "applied" ? "Cost update recorded:" : "Last attempt:"}{" "}
                        {new Date(line.recordedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 text-sm">
                    {line.exceptionReview ? <ShipmentCostExceptionReview lineId={line.lineId} review={line.exceptionReview} /> : <>
                    {guidance.explanation ? (
                      <p>{guidance.explanation}</p>
                    ) : (
                      line.issues.map((issue) => (
                        <p key={`${issue.code}:${issue.message}`}>
                          {issue.message}
                        </p>
                      ))
                    )}
                    <p>
                      <strong>Next step:</strong> {guidance.nextStep}
                    </p>
                    </>}
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        {line.status === "applied" ? "Original inventory history" : "Cost review details"} · line #{line.lineId}
                      </summary>
                      <ul className="list-disc pl-4 mt-1 space-y-1">
                        {line.issues.map((issue) => (
                          <li key={`${issue.code}:${issue.message}`}>
                            <span className="font-mono">{issue.code}</span>:{" "}
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                </div>
              );
            })}
        </div>
      ))}
    </section>
  );
}
