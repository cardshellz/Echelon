import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  shipmentCostPushResultSchema,
  shipmentCostReviewGuidance,
  type PoShipmentCosts,
} from "@shared/procurement/po-shipment-costs";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function PoShipmentCostReview({
  purchaseOrderId,
  costs,
}: {
  purchaseOrderId: number;
  costs: PoShipmentCosts;
}) {
  const { hasPermission } = useAuth();
  const canApprove = hasPermission("purchasing", "approve");
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: async (shipmentId: number) => {
      const response = await apiRequest(
        "POST",
        `/api/inbound-shipments/${shipmentId}/push-costs-to-lots`,
      );
      const result = shipmentCostPushResultSchema.safeParse(
        await response.json(),
      );
      if (!result.success)
        throw new Error(
          "The cost update response could not be verified. Check the latest recorded results before retrying.",
        );
      return result.data;
    },
    onMutate: () => setOutcome(null),
    onSuccess: (result) => {
      setOutcome(
        result.status === "review_required"
          ? "The cost update finished, but some lines still need review. Check the latest recorded reasons below."
          : "Inventory cost update completed. Check the latest recorded line results below.",
      );
    },
    // A lost response may follow a committed update. Re-read its recorded
    // outcome on both success and failure; never guess from the POST alone.
    onSettled: async (_result, _error, shipmentId) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [`/api/purchase-orders/${purchaseOrderId}`],
        }),
        queryClient.invalidateQueries({
          queryKey: [`/api/inbound-shipments/${shipmentId}`],
        }),
      ]);
    },
  });
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
          These are the last recorded results and current charge checks.
          Retrying checks the charges and lot history again.
        </p>
      </div>
      {retry.isError && (
        <p role="alert" className="text-sm text-destructive">
          {retry.error.message}
        </p>
      )}
      {outcome && (
        <p role="status" className="text-sm">
          {outcome}
        </p>
      )}
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
                <Link href={`/shipments/${shipment.id}?tab=allocation`}>
                  Open shipment allocation
                </Link>
              </Button>
              {canApprove &&
                ["costing", "closed"].includes(shipment.status) && (
                  <Button
                    size="sm"
                    onClick={() => retry.mutate(shipment.id)}
                    disabled={retry.isPending}
                  >
                    {retry.isPending && retry.variables === shipment.id
                      ? "Updating inventory costs…"
                      : "Retry inventory cost update"}
                  </Button>
                )}
            </div>
          </div>
          {!canApprove && (
            <p className="text-xs text-muted-foreground">
              A user with purchasing approval permission can retry this cost
              update.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            A retry applies this shipment's recorded charges to inventory and
            cost of sold stock, including any other linked POs.
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
