import type { SupplierCreditCostPreview } from "@shared/procurement/supplier-credit-cost-review";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { reconciliationDestinations } from "@shared/procurement/cost-reconciliation";
export function SupplierCreditCostImpact({ preview }: { preview: SupplierCreditCostPreview }) {
  const rows: Array<[string, number | null, number | null]> = [
    ...preview.inventoryValues.map(row => [`${row.lotNumber} · ${row.onHandUnits.toLocaleString()} units on hand`, row.beforeMills, row.afterMills] as [string, number | null, number | null]),
    ...preview.impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [`Order #${row.orderId} · cost basis`, row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
    ...preview.impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [reconciliationDestinations[row.destination], row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
  ];
  const money = (amount: number | null) => amount === null ? "Needs review" : `$${exactMoneyAsInput(amount, 4)}`;
  return <section aria-label="Receipt credit cost changes" className="space-y-2 text-sm">
    <h3 className="font-semibold">Receipt cost changes</h3>
    {preview.receipts?.length ? <><p>Supplier cost by receipt</p><table aria-label="Supplier cost by receipt" className="w-full table-fixed"><thead><tr className="border-b"><th className="text-left w-1/2 py-2">Receipt</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead><tbody>{preview.receipts.map(row => <tr key={row.receivingLineId} className="border-b"><th className="text-left py-2 font-normal break-words">{row.receiptNumber}<span className="block text-xs">{row.pieces.toLocaleString()} pieces</span></th><td className="text-right p-2">{money(row.beforeMills)}</td><td className="text-right py-2">{money(row.afterMills)}</td></tr>)}</tbody></table></> : null}
    {rows.length ? <details><summary>Stock and order cost details</summary><table aria-label="Stock and order cost changes" className="w-full table-fixed"><thead><tr className="border-b"><th className="text-left w-1/2 py-2">What changes</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead><tbody>{rows.map(([label, before, after], index) => <tr key={`${label}:${index}`} className="border-b"><th className="text-left py-2 font-normal break-words">{label}</th><td className="text-right p-2 break-words">{money(before)}</td><td className="text-right py-2 break-words">{money(after)}</td></tr>)}</tbody></table></details> : <p>No linked stock or order cost changes.</p>}
    <p>Stock quantities, the original invoice and cash payments do not change. Invoice applications remain a separate action.</p>
    {preview.issues.map((issue, index) => <p key={index} className="text-amber-700">{issue}</p>)}
  </section>;
}
