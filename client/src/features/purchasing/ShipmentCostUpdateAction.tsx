import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createShipmentCostUpdateClient, shipmentCostWorkflowError } from "@/lib/shipment-cost-workflow";
import { Button } from "@/components/ui/button";

export function ShipmentCostUpdateAction({ shipmentId, disabled = false }: { shipmentId: number; disabled?: boolean }) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [client] = useState(() => createShipmentCostUpdateClient(() => crypto.randomUUID()));
  const update = useMutation({
    mutationFn: (id: number) => client.update(id),
    // The response can be lost after commit. Always reload persisted outcomes,
    // including other linked POs; never leave a success toast over stale totals.
    onSettled: async (_result, _error, id) => {
      const shipmentPath = `/api/inbound-shipments/${id}`;
      await queryClient.invalidateQueries({ predicate: query => {
        const path = query.queryKey[0];
        return typeof path === "string" && (path === shipmentPath || path.startsWith(`${shipmentPath}/`)
          || path.startsWith("/api/purchase-orders/"));
      } });
    },
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
