import { noInventoryEffectLabel } from "./cost-inventory-effect-presentation";
import type { SupplierCreditDetail } from "@shared/procurement/supplier-credit";
export function supplierCreditCostLabel(state: SupplierCreditDetail["costStatus"]): string {
  if (state === "not_applicable") return "No cost effect";
  return state.replaceAll("_", " ");
}

export function supplierCreditCostSummary(credit: Pick<SupplierCreditDetail, "costStatus" | "lines">): string {
  return credit.costStatus === "posted" && credit.lines.length > 0
    && credit.lines.every(line => line.costState === "posted" && line.inventoryEffect)
    ? noInventoryEffectLabel : supplierCreditCostLabel(credit.costStatus);
}
