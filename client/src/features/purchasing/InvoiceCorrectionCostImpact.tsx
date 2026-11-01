import React from "react";
import type { InvoiceCorrectionCostImpact as Impact } from "@shared/procurement/invoice-correction-cost-impact";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";

export function InvoiceCorrectionCostImpact({ impact, currency, purchaseOrderId, approved }: { impact: Impact; currency: string; purchaseOrderId: number; approved: boolean }) {
  const navigation = useProcurementNavigation();
  const money = (value: number | null) => value === null ? "Not verified" : `${value % 100 === 0
    ? exactMoneyAsInput(BigInt(value) / BigInt(100), 2) : exactMoneyAsInput(value, 4)} ${currency}`;
  const rows: Array<[string, number | null, number | null]> = impact.sourceAmounts
    .filter(row => row.before.totalMills !== row.after.totalMills || row.before.evidence !== row.after.evidence)
    .map(row => [`Supplier ${row.component} cost`, row.before.totalMills, row.after.totalMills]);
  for (const lot of impact.inventoryValues) {
    if (lot.onHandValueMills.before !== lot.onHandValueMills.after) rows.push([
      `${lot.lotNumber} · ${lot.onHandUnits.toLocaleString("en-US")} units on hand`, lot.onHandValueMills.before, lot.onHandValueMills.after,
    ]);
  }
  rows.push(...impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after)
    .map(row => [`Order #${row.orderId} · cost basis`, row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]));
  rows.push(...impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after)
    .map(row => [row.destination === "historical_cogs" ? "Previously approved cost of goods sold" : "Previously approved inventory adjustment",
      row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]));
  rows.push(...impact.applications.flatMap(application => application.returnedCosts ?? [])
    .filter(row => row.beforeMills !== row.afterMills)
    .map(row => [`Supplier return #${row.returnId} · value`, row.beforeMills, row.afterMills] as [string, number | null, number | null]));
  const issues = [...new Map(impact.applications.flatMap(row => row.issues).map(issue => [issue.code + issue.message, issue])).values()];
  const posted = !impact.needsReview;
  const waitingForReceipt = impact.applications.every(row => row.status === "pending_finalization");
  return <section aria-label="Invoice inventory cost changes" className="space-y-2 rounded border p-3 text-sm">
    <h3 className="font-semibold">Inventory and order costs</h3>
    {rows.length > 0 ? <table className="w-full table-fixed" aria-label="Inventory cost changes">
      <thead><tr className="border-b"><th className="w-[46%] py-2 text-left">What changes</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead>
      <tbody>{rows.map(([label, before, after], index) => <tr key={`${label}:${index}`} className="border-b"><th className="py-2 text-left font-normal break-words">{label}</th><td className="p-2 text-right break-words">{money(before)}</td><td className="py-2 text-right font-medium break-words">{money(after)}</td></tr>)}</tbody>
    </table> : <p>The recorded inventory and order cost amounts do not change.</p>}
    <p className={posted ? "text-green-800 dark:text-green-300" : "text-amber-800 dark:text-amber-300"}>{posted
      ? approved ? "Supplier costs are posted." : "These supplier costs will be saved with the invoice correction."
      : waitingForReceipt ? approved ? "Supplier amounts are saved. Inventory costing is waiting for receiving."
        : "These supplier amounts will be saved. Inventory costing will wait for receiving."
      : approved ? "The invoice correction is saved. These cost items still need attention." : "The invoice can be saved. These cost items still need attention."}</p>
    {impact.reviewTasks.length > 0 && !waitingForReceipt && <ul className="space-y-2">{impact.reviewTasks.map(task => <li key={task.id}><strong>{task.title}</strong><p>{task.explanation}</p></li>)}</ul>}
    {issues.length > 0 && <details><summary className="cursor-pointer">Recorded cost checks</summary><ul className="mt-2 list-disc space-y-1 pl-4">{issues.map(issue => <li key={issue.code + issue.message}>{issue.message}</li>)}</ul></details>}
    {approved && impact.needsReview && <a className="inline-block underline" href={`${navigation.childHref(`/purchase-orders/${purchaseOrderId}?tab=lines`)}&costReview=1`}>Open the remaining cost review</a>}
    {impact.inventoryValues.some(lot => lot.valueReviewReason !== null) && <details><summary className="cursor-pointer">Stock values still to verify</summary>
      <ul className="mt-2 list-disc pl-4">{impact.inventoryValues.filter(lot => lot.valueReviewReason !== null).map(lot => <li key={lot.lotId}>{lot.lotNumber}: {lot.valueReviewReason}</li>)}</ul>
    </details>}
    {impact.inventoryValues.some(lot => lot.originalLotTotalMills.before !== lot.originalLotTotalMills.after) && <details><summary className="cursor-pointer">Original lot totals, including goods already moved</summary>
      <ul className="mt-2 space-y-1">{impact.inventoryValues.filter(lot => lot.originalLotTotalMills.before !== lot.originalLotTotalMills.after).map(lot => <li key={lot.lotId}>{lot.lotNumber}: {money(lot.originalLotTotalMills.before)} → {money(lot.originalLotTotalMills.after)}</li>)}</ul>
    </details>}
    <p className="text-xs text-muted-foreground">Stock counts, receipts, shipments and cash payments do not change. Order rows show cost basis; they do not establish a sale or a new expense.</p>
  </section>;
}
