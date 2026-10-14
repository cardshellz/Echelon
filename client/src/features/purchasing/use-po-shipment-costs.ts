import { useQuery } from "@tanstack/react-query";
import { poShipmentCostsSchema } from "@shared/procurement/po-shipment-costs";
import { apiRequest } from "@/lib/queryClient";

export function usePoShipmentCosts(purchaseOrderId: number | null) {
  return useQuery({
    queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "shipment-costs"],
    enabled: purchaseOrderId !== null,
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/purchase-orders/${purchaseOrderId}/shipment-costs`,
      );
      return poShipmentCostsSchema.parse(await response.json());
    },
  });
}
