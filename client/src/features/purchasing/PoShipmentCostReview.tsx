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

export function PoShipmentCostReview({
  costs,
}: {
  purchaseOrderId: number;
  costs: PoShipmentCosts;
}) {
  const navigation = useProcurementNavigation();
  const pending = costs.lines.filter((line) => line.status !== "applied");
  const groups = [
    ...new Map(
      pending.map((line) => [
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
        <h3 className="font-semibold text-sm">Inventory cost review</h3>
        <p className="text-xs text-muted-foreground">
          Update shipment costs here to refresh the charge split and the costs of stock and sold items.
          Any remaining issues stay below for review.
        </p>
      </div>
      {pending.length === 0 && (
        <p className="text-sm text-green-700 dark:text-green-400">
          All confirmed shipment costs have been applied to inventory.
        </p>
      )}
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
          {["costing", "closed"].includes(shipment.status) && <ShipmentCostUpdateAction key={shipment.id} shipmentId={shipment.id} />}
          <p className="text-xs text-muted-foreground">
            This updates the entire shipment, including its other linked POs. Closed-shipment adjustments are recorded automatically.
          </p>
          {pending
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
                    <Badge
                      variant={
                        line.status === "review_required"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {line.status === "review_required"
                        ? "Needs review"
                        : "Awaiting cost update"}
                    </Badge>
                    {line.recordedAt && (
                      <div className="text-xs text-muted-foreground">
                        Last attempt:{" "}
                        {new Date(line.recordedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 text-sm">
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
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        Cost review details · line #{line.lineId}
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
