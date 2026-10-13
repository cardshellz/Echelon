import React from "react";
import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import { Badge } from "@/components/ui/badge";
import { MemberProductPrice } from "@/components/MemberProductPrice";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import { formatOrderEditMoney } from "@/lib/order-edits";
import {
  exactOrderEditUnitPrice,
  groupOrderEditDisplayLines,
} from "@/lib/order-edit-display";

export function OrderEditUnitPrice({
  cents,
  currency = "USD",
  retailCents,
  plan = null,
}: {
  cents: number | null;
  currency?: string;
  retailCents?: number | null;
  plan?: MemberPlanPresentation | null;
}) {
  return (
    <div className="oe-item-price">
      {cents === null ? (
        <span aria-label="Unit price unavailable">—</span>
      ) : plan &&
        retailCents !== null &&
        retailCents !== undefined &&
        cents < retailCents ? (
        <MemberProductPrice
          priceCents={cents}
          retailPriceCents={retailCents}
          plan={plan}
          layout="compact"
        />
      ) : (
        <>
          {formatOrderEditMoney(cents, currency)} <span>each</span>
        </>
      )}
    </div>
  );
}

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
      <ul className="oe-review-items">
        {groupOrderEditDisplayLines(lines).map((line) => (
          <li key={line.key} className="oe-review-item">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {line.title}{" "}
                {showAdded && line.added && (
                  <Badge variant="outline" className="oe-added-pill">
                    Added
                  </Badge>
                )}
              </p>
              {line.variantTitle && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {line.variantTitle}
                </p>
              )}
            </div>
            <div className="oe-line-pricing">
              <OrderEditUnitPrice
                cents={exactOrderEditUnitPrice(line.totalCents, line.quantity)}
              />
              <p className="oe-reviewed-quantity">Qty {line.quantity}</p>
              <p className="oe-item-total">
                {formatOrderEditMoney(line.totalCents, "USD")}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
