import React from "react";
import type { PoShipmentCosts } from "@shared/procurement/po-shipment-costs";
import { poCostReviewShipments } from "@shared/procurement/cost-review-adapters";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { CostReviewPanel } from "./CostReviewPanel";

export function PoShipmentCostReview({ costs }: { purchaseOrderId: number; costs: PoShipmentCosts }) {
  const navigation = useProcurementNavigation();
  return <div className="border-t pt-3"><CostReviewPanel supplier={costs.supplierCosts} shipments={poCostReviewShipments(costs)} navigation={navigation} /></div>;
}
