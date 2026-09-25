import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  previewPackingItemContext,
  type PreviewPackingSummary,
} from "@/lib/customer-return-packing";

function packingStatus(summary: PreviewPackingSummary): string {
  if (summary.ready) return "All items are in boxes";
  if (summary.selectedQuantity === null || summary.packedQuantity === null) {
    return "Check the item quantities before continuing.";
  }
  if (
    summary.lines.some(
      (item) =>
        item.packedQuantity !== null &&
        item.packedQuantity > item.selectedQuantity,
    )
  ) {
    return "Remove the extra items from your boxes.";
  }
  const remaining = summary.selectedQuantity - summary.packedQuantity;
  if (remaining > 0)
    return `${remaining} still ${remaining === 1 ? "needs" : "need"} a box`;
  if (summary.emptyBoxNumbers.length > 0)
    return "Remove empty boxes to continue.";
  return "Check your box contents before continuing.";
}

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
      className="min-w-0 space-y-2 rounded-xl bg-muted/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h3 id="packing-summary-title" className="text-sm font-semibold">
          Items to return
        </h3>
        <Button
          variant="link"
          className="min-h-11 px-0 text-sm"
          disabled={busy}
          onClick={onChangeItems}
        >
          Change return items
        </Button>
      </div>
      <div aria-live="polite" aria-atomic="true" className="min-w-0 space-y-2">
        <div
          data-testid="packing-summary-total"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums"
        >
          <span className="min-w-0 break-words font-medium">
            {summary.selectedQuantity === null
              ? "Check return quantity"
              : `${summary.selectedQuantity} ${summary.selectedQuantity === 1 ? "item" : "items"} to return`}
          </span>
          <span className="text-muted-foreground">
            {boxCount} {boxCount === 1 ? "box" : "boxes"}
          </span>
          <span
            className={`flex min-w-0 basis-full items-start gap-1.5 sm:ml-auto sm:basis-auto ${summary.ready ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}
          >
            {summary.ready && (
              <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 break-words">
              {packingStatus(summary)}
            </span>
          </span>
        </div>
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">
            Items to return and quantities across all boxes
          </caption>
          <colgroup>
            <col />
            <col className="w-[4.5rem] sm:w-24" />
            <col className="w-[4.5rem] sm:w-24" />
          </colgroup>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-2 text-left font-medium">
                Product
              </th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">
                To return
              </th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">
                In boxes
              </th>
            </tr>
          </thead>
          <tbody>
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
                <tr
                  key={item.lineId}
                  data-testid={`packing-summary-line-${item.lineId}`}
                  className="border-b border-border/50 last:border-0"
                >
                  <th
                    scope="row"
                    className="py-2 pr-2 text-left align-top font-normal"
                  >
                    <p className="break-words [overflow-wrap:anywhere]">
                      {line.title}
                      {context && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {context}
                        </span>
                      )}
                    </p>
                    {!complete && (
                      <p className="mt-1 break-words text-xs text-destructive">
                        {remaining === null
                          ? "Check the quantities in your boxes."
                          : remaining > 0
                            ? `${remaining} still to add to a box.`
                            : `${-remaining} too many in boxes. Remove the extra quantity or change return items.`}
                      </p>
                    )}
                  </th>
                  <td className="py-2 pl-2 text-right align-top tabular-nums">
                    <span className="block break-all">
                      {item.selectedQuantity}
                    </span>
                  </td>
                  <td
                    className={`py-2 pl-2 text-right align-top tabular-nums ${complete ? "text-emerald-700 dark:text-emerald-400" : "font-medium"}`}
                  >
                    <span className="block break-all">
                      {item.packedQuantity ?? "Check"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {summary.emptyBoxNumbers.map((number) => (
          <p key={number} className="text-xs text-muted-foreground">
            Box {number} is empty. Add items or remove it before continuing.
          </p>
        ))}
      </div>
    </section>
  );
}
