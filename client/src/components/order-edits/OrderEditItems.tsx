import React from "react";
import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import { Badge } from "@/components/ui/badge";
import { formatOrderEditMoney } from "@/lib/order-edits";
import { groupOrderEditDisplayLines } from "@/lib/order-edit-display";

export function OrderEditItems({
  lines,
  showAdded = false,
}: {
  lines: OrderEditOperation["lines"];
  showAdded?: boolean;
}) {
  return (
    <section aria-label="Items in your order">
      <h3 className="mb-3 text-sm font-medium">Items in your order</h3>
      <ul className="divide-y rounded-md border">
        {groupOrderEditDisplayLines(lines).map((line) => (
          <li key={line.key} className="flex items-start gap-3 p-3 sm:p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{line.title}</p>
              {line.variantTitle && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {line.variantTitle}
                </p>
              )}
              {showAdded && line.added && (
                <Badge variant="outline" className="mt-2">
                  Added
                </Badge>
              )}
            </div>
            <div className="shrink-0 text-right text-sm">
              <p className="text-xs text-muted-foreground">Qty {line.quantity}</p>
              <p className="mt-1 font-medium tabular-nums">
                {formatOrderEditMoney(line.totalCents, "USD")}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
