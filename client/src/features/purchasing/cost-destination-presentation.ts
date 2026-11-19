import type { InvoiceCorrectionCostImpact } from "@shared/procurement/invoice-correction-cost-impact";

type Destinations = Pick<InvoiceCorrectionCostImpact, "inventoryValues" | "orderCosts" | "historicalCosts" | "applications">;
export function costDestinationRows(impact: Destinations): Array<[string, number | null, number | null]> {
  return [
    ...impact.inventoryValues.filter(row => row.onHandValueMills.before !== row.onHandValueMills.after)
      .map(row => [`${row.lotNumber} · ${row.onHandUnits.toLocaleString("en-US")} units on hand`, row.onHandValueMills.before, row.onHandValueMills.after] as [string, number | null, number | null]),
    ...impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after)
      .map(row => [`Order #${row.orderId} · cost basis`, row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
    ...impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after)
      .map(row => [row.destination === "historical_cogs" ? "Previously approved cost of goods sold" : "Previously approved inventory adjustment", row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
    ...impact.applications.flatMap(row => row.returnedCosts ?? []).filter(row => row.beforeMills !== row.afterMills)
      .map(row => [`Supplier return #${row.returnId} · value`, row.beforeMills, row.afterMills] as [string, number | null, number | null]),
  ];
}
