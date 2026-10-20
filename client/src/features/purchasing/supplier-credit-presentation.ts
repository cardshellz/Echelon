import type { SupplierCreditDetail } from "@shared/procurement/supplier-credit";
export function supplierCreditCostLabel(state: SupplierCreditDetail["costStatus"]): string {
  if (state === "not_applicable") return "No cost effect";
  return state.replaceAll("_", " ");
}
