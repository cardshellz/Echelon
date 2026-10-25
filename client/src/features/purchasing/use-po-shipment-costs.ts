import { useQuery } from "@tanstack/react-query";
import { poShipmentCostsSchema } from "@shared/procurement/po-shipment-costs";
import { readShipmentCostWorkflow } from "@/lib/shipment-cost-workflow";

export function usePoShipmentCosts(purchaseOrderId: number | null) {
  return useQuery({
    queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "shipment-costs"],
    enabled: purchaseOrderId !== null,
    queryFn: async () => {
      const response = await readShipmentCostWorkflow(
        `/api/purchase-orders/${purchaseOrderId}/shipment-costs`,
        { includePoLineLinks: true },
      );
      return poShipmentCostsSchema.parse(response);
    },
  });
}
