import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createShipmentCostUpdateClient, shipmentCostWorkflowError } from "@/lib/shipment-cost-workflow";
import { Button } from "@/components/ui/button";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { FinancialCommandRequestError } from "@/lib/financial-command";

export function ShipmentCostUpdateAction({ shipmentId, disabled = false, onMeasurementsNeeded }: { shipmentId: number; disabled?: boolean; onMeasurementsNeeded?: () => void }) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [client] = useState(() => createShipmentCostUpdateClient(() => crypto.randomUUID()));
  const update = useMutation({
    mutationFn: (id: number) => client.update(id),
    onError: error => {
      if (error instanceof FinancialCommandRequestError && error.code === "MISSING_ALLOCATION_DIMENSIONS") onMeasurementsNeeded?.();
    },
    // The response can be lost after commit. Always reload persisted outcomes,
    // including other linked POs; never leave a success toast over stale totals.
    onSettled: () => invalidatePurchaseCosts(queryClient),
  });
  if (!hasPermission("purchasing", "approve")) return <p className="text-sm text-muted-foreground">
    A purchasing approver can update these costs. You can review the saved details below.
  </p>;
  const current = update.variables === shipmentId;
  return <div className="space-y-2">
    <Button className="min-h-[44px]" disabled={disabled || update.isPending} onClick={() => update.mutate(shipmentId)}>
      {update.isPending && current ? "Updating shipment costs…" : "Update shipment costs"}
    </Button>
    {current && update.isError && <p role="alert" className="text-sm text-destructive">{shipmentCostWorkflowError(update.error)}</p>}
    {current && update.isSuccess && <p role="status" className="text-sm">
      {update.data.status === "review_required"
        ? "Shipment charges are saved. Inventory application results, including historical exceptions, are shown below."
        : "Cost update saved. Review the refreshed charge split and results below."}
    </p>}
  </div>;
}
