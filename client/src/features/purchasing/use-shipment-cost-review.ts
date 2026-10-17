import { useQuery } from "@tanstack/react-query";
import { shipmentCostReviewSchema } from "@shared/procurement/shipment-cost-workflow";
import { readShipmentCostWorkflow } from "@/lib/shipment-cost-workflow";

export function useShipmentCostReview(shipmentId: number | null, enabled = true) {
  return useQuery({
    queryKey: [`/api/inbound-shipments/${shipmentId}/cost-review`],
    enabled: enabled && shipmentId !== null,
    queryFn: async () => {
      const response = await readShipmentCostWorkflow(`/api/inbound-shipments/${shipmentId}/cost-review`);
      const parsed = shipmentCostReviewSchema.parse(response);
      if (parsed.shipmentId !== shipmentId) throw new Error("Cost results belong to another shipment.");
      return parsed;
    },
  });
}
