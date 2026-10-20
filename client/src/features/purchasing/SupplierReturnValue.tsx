import React from "react";
import type { SupplierReturnCostTotals } from "@shared/procurement/supplier-return";
import { formatWorkspaceMills } from "./purchase-workspace-format";
export function SupplierReturnValue({ value, label }: { value: SupplierReturnCostTotals; label: string }) {
  return <section aria-label={label} className="space-y-1"><p className="font-medium">{label}</p><dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
    {([ ["Product", "productMills"], ["Packaging", "packagingMills"], ["Landed", "landedMills"], ["Total", "totalMills"] ] as const).map(([name, key]) => <div key={key}><dt className="text-muted-foreground">{name}</dt><dd className="font-mono break-words">{formatWorkspaceMills(value[key], "USD")}</dd></div>)}
  </dl></section>;
}
