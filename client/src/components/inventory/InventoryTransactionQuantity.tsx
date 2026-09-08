import React from "react";
import { cn } from "@/lib/utils";
import { readHistoryShipmentQuantity, signedInventoryQuantity,
  type InventoryTransactionQuantityInput } from "@/lib/inventory-transaction-quantity";

export function InventoryTransactionQuantity(input: InventoryTransactionQuantityInput) {
  const evidence = readHistoryShipmentQuantity(input);
  const delta = signedInventoryQuantity(input.variantQtyDelta);
  if (evidence.status === "verified") {
    return <div className="text-right">
      <div className="font-mono font-medium" title={evidence.source === "canonical_dispatch_receipt"
        ? `Canonical dispatch receipt ${evidence.receiptId}`
        : evidence.source === "operational_dispatch_receipt" ? `Operational shipment receipt ${evidence.receiptId}` : "Legacy shipment ledger evidence"}>
        {evidence.quantity} shipped
      </div>
      <div className="text-xs text-muted-foreground">On-hand Δ {delta}</div>
    </div>;
  }
  if (evidence.status === "invalid") {
    return <div className="text-right">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400" title={evidence.reason}>
        Shipment quantity needs review
      </div>
      <div className="text-xs text-muted-foreground">On-hand Δ {delta}</div>
    </div>;
  }
  return <div className={cn("font-mono font-medium", input.variantQtyDelta > 0 ? "text-green-600"
    : input.variantQtyDelta < 0 ? "text-red-600" : "text-muted-foreground")} title="On-hand quantity delta">{delta}</div>;
}
