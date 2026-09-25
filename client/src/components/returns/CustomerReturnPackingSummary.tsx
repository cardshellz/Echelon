import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  previewPackingItemContext,
  type PreviewPackingSummary,
} from "@/lib/customer-return-packing";

export function CustomerReturnPackingSummary({
  order,
  summary,
  boxCount,
  busy,
  onChangeItems,
}: {
  order: CustomerReturnFlowOrder;
  summary: PreviewPackingSummary;
  boxCount: number;
  busy: boolean;
  onChangeItems: () => void;
}) {
  return (
    <section
      data-testid="packing-summary"
      aria-labelledby="packing-summary-title"
      className="space-y-4 rounded-xl bg-muted/60 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div>
          <h3 id="packing-summary-title" className="text-sm font-semibold">
            Return summary
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">Across all boxes</p>
        </div>
        <Button
          variant="link"
          className="min-h-11 px-0 text-sm"
          disabled={busy}
          onClick={onChangeItems}
        >
          Change return items
        </Button>
      </div>
      <div aria-live="polite" aria-atomic="true" className="space-y-4">
        <div
          data-testid="packing-summary-total"
          className="flex flex-wrap gap-x-5 gap-y-1 border-b pb-3 text-sm font-medium tabular-nums"
        >
          <span>Selected: {summary.selectedQuantity ?? "Check quantity"}</span>
          <span>Packed: {summary.packedQuantity ?? "Check quantity"}</span>
          <span>
            {boxCount} {boxCount === 1 ? "box" : "boxes"}
          </span>
        </div>
        {summary.lines.map((item) => {
          const line = order.lines.find(
            (candidate) => candidate.id === item.lineId,
          )!;
          const context = previewPackingItemContext(order, item.lineId);
          const complete = item.packedQuantity === item.selectedQuantity;
          const remaining =
            item.packedQuantity === null
              ? null
              : item.selectedQuantity - item.packedQuantity;
          return (
            <div
              key={item.lineId}
              data-testid={`packing-summary-line-${item.lineId}`}
              className="flex items-start gap-2 text-sm"
            >
              {complete ? (
                <Check
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words">{line.title}</p>
                {context && (
                  <p className="break-words text-xs text-muted-foreground">
                    {context}
                  </p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                  <span>Selected: {item.selectedQuantity}</span>
                  <span
                    className={
                      complete
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "font-medium"
                    }
                  >
                    Packed: {item.packedQuantity ?? "Check quantity"}
                  </span>
                </div>
                {!complete && (
                  <p className="text-xs text-destructive">
                    {remaining === null
                      ? "Check the quantities in your boxes."
                      : remaining > 0
                        ? `${remaining} still to pack.`
                        : `${-remaining} too many packed. Remove the extra quantity or change return items.`}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {summary.emptyBoxNumbers.map((number) => (
          <p key={number} className="text-xs text-muted-foreground">
            Box {number} is empty. Add items or remove it before continuing.
          </p>
        ))}
        {summary.packedQuantity === null && (
          <p className="text-xs text-destructive">
            Check the item quantities before continuing.
          </p>
        )}
      </div>
    </section>
  );
}
