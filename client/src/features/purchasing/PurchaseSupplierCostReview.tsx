import React from "react";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import type { PurchaseCostStatus, PurchaseLineCostStatus } from "@shared/procurement/purchase-cost-status";
import { CostReviewPanel } from "./CostReviewPanel";

export function PurchaseSupplierCostLine({ line, navigation }: { line: PurchaseLineCostStatus; navigation: ProcurementNavigation }) {
  return <CostReviewPanel supplier={{ lines: [line] }} navigation={navigation} />;
}

export function PurchaseSupplierCostReview({ status, navigation }: { status: PurchaseCostStatus; navigation: ProcurementNavigation }) {
  return <CostReviewPanel supplier={status} navigation={navigation} />;
}
