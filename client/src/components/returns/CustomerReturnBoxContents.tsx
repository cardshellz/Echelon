import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  describePreviewItem,
  type PreviewSelections,
} from "@/lib/customer-return-preview";
import {
  readPreviewQuantity,
  type PreviewParcelDraft,
} from "@/lib/customer-return-parcels";
import {
  changePreviewPackingQuantity,
  previewPackingItemContext,
  previewParcelQuantityLimit,
  type PreviewPackingSummary,
} from "@/lib/customer-return-packing";
import { CustomerReturnBoxItemPicker } from "./CustomerReturnBoxItemPicker";

export function CustomerReturnBoxContents({
  order,
  selections,
  parcels,
  parcel,
  summary,
  boxNumber,
  busy,
  autoFocus,
  onChange,
}: {
  order: CustomerReturnFlowOrder;
  selections: PreviewSelections;
  parcels: PreviewParcelDraft[];
  parcel: PreviewParcelDraft;
  summary: PreviewPackingSummary;
  boxNumber: number;
  busy: boolean;
  autoFocus: boolean;
  onChange: (parcels: PreviewParcelDraft[]) => void;
}) {
  const addItemsButton = useRef<HTMLButtonElement>(null);
  const [focusedLine, setFocusedLine] = useState<string | null>(null);
  const [error, setError] = useState<{
    lineId: string;
    message: string;
    forParcels: readonly PreviewParcelDraft[];
  } | null>(null);
  function edit(lineId: string, raw: string) {
    const result = changePreviewPackingQuantity(
      order,
      selections,
      parcels,
      parcel.key,
      lineId,
      raw,
    );
    if (result.kind === "updated") {
      setError(null);
      onChange(result.parcels);
      return;
    }
    setError({
      lineId,
      forParcels: parcels,
      message:
        result.kind === "already_assigned"
          ? `Up to ${result.maximum} can go in this box. Use Add or move items to move items from another box, or Change return items to return more.`
          : "Check this item's quantities in the other boxes first.",
    });
  }
  const visible = selections.filter((selection) => {
    const quantity = readPreviewQuantity(
      parcel.items.find((item) => item.lineId === selection.lineId)?.quantity ??
        "0",
    );
    // Keep an invalid or active draft available for correction. Zero rows disappear
    // after editing ends; starting another box never presents zero contents.
    return (
      quantity === null || quantity > 0 || focusedLine === selection.lineId
    );
  });
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CustomerReturnBoxItemPicker
          order={order}
          selections={selections}
          parcels={parcels}
          parcelKey={parcel.key}
          boxNumber={boxNumber}
          busy={busy}
          autoFocus={autoFocus}
          triggerRef={addItemsButton}
          onEditingEnd={() => setFocusedLine(null)}
          onChange={(next) => {
            setError(null);
            onChange(next);
          }}
        />
      </div>
      {visible.length === 0 && (
        <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
          No items in this box yet. Choose Add or move items above.
        </p>
      )}
      <div className="divide-y">
        {visible.map((selection) => {
          const line = order.lines.find(
            (item) => item.id === selection.lineId,
          )!;
          const description = describePreviewItem(order, line.id);
          const context = previewPackingItemContext(order, line.id);
          const itemIndex = selections.findIndex(
            (item) => item.lineId === line.id,
          );
          const quantityId = `preview-box-${parcel.key}-quantity-${itemIndex}`;
          const raw =
            parcel.items.find((item) => item.lineId === line.id)?.quantity ??
            "0";
          const quantity = readPreviewQuantity(raw);
          const packed = summary.lines[itemIndex].packedQuantity;
          const elsewhere =
            quantity !== null && packed !== null ? packed - quantity : null;
          const maximum = previewParcelQuantityLimit(
            selections,
            parcels,
            parcel.key,
            line.id,
          );
          // An edit in any box invalidates messages about the previous allocation.
          const rejected =
            error?.lineId === line.id && error.forParcels === parcels
              ? error.message
              : null;
          return (
            <div
              key={line.id}
              data-testid={`packing-item-${parcel.key}-${line.id}`}
              className="space-y-2 py-3 first:pt-0 last:pb-0"
              onBlur={(event) => {
                // A zero row disappears after editing. Keep keyboard focus out
                // of its Remove button when that next target is about to unmount.
                if (
                  quantity === 0 &&
                  event.currentTarget.contains(event.relatedTarget)
                ) {
                  addItemsButton.current?.focus();
                }
              }}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <Label
                  htmlFor={quantityId}
                  className="min-w-0 flex-1 basis-36 break-words font-normal leading-relaxed"
                >
                  {line.title}
                  {context && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {context}
                    </span>
                  )}
                </Label>
                <div className="flex max-w-full items-start gap-1">
                  <div className="min-w-0 max-w-full space-y-1">
                    <div className="flex max-w-full flex-wrap items-center justify-center rounded-md border border-input bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring">
                      <Input
                        id={quantityId}
                        aria-label={`Quantity of ${description.accessibleName} in box ${boxNumber}`}
                        type="number"
                        min="0"
                        max={maximum ?? undefined}
                        step="1"
                        inputMode="numeric"
                        className="min-h-11 max-w-full shrink-0 border-0 px-2 text-center tabular-nums shadow-none focus-visible:ring-0"
                        style={{
                          width: `calc(${Math.max(raw.length, 2)}ch + 2.5rem)`,
                        }}
                        disabled={busy}
                        value={raw}
                        aria-invalid={quantity === null || undefined}
                        aria-describedby={`${quantityId}-progress${elsewhere !== null && elsewhere > 0 ? ` ${quantityId}-elsewhere` : ""}${rejected ? ` ${quantityId}-error` : ""}`}
                        onFocus={() => setFocusedLine(line.id)}
                        onBlur={(event) => {
                          // Hold the row while a picker click completes. Collapsing
                          // it on pointer-down can shift the page and lose the click.
                          // Opening the picker or leaving its trigger ends the edit.
                          if (
                            quantity === 0 &&
                            event.relatedTarget === addItemsButton.current
                          )
                            return;
                          setFocusedLine(null);
                        }}
                        onChange={(event) => edit(line.id, event.target.value)}
                      />
                      <span
                        aria-hidden="true"
                        className="shrink-0 py-1 pr-3 text-sm tabular-nums text-muted-foreground"
                      >
                        of {selection.quantity}
                      </span>
                    </div>
                    <p
                      aria-hidden="true"
                      className={`text-center text-xs ${quantity === null ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {quantity === null
                        ? "Enter a whole number"
                        : "added to this box"}
                    </p>
                    <p id={`${quantityId}-progress`} className="sr-only">
                      {quantity === null
                        ? "Enter a whole number of items for this box."
                        : `${quantity} of ${selection.quantity} added to this box.`}
                    </p>
                    {elsewhere !== null && elsewhere > 0 && (
                      <p
                        id={`${quantityId}-elsewhere`}
                        className="break-words text-center text-xs text-muted-foreground"
                      >
                        {elsewhere} in other boxes
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    disabled={busy}
                    aria-label={`Remove ${description.accessibleName} from box ${boxNumber}`}
                    title="Remove from this box"
                    onClick={() => {
                      addItemsButton.current?.focus();
                      edit(line.id, "0");
                    }}
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {rejected && (
                <p
                  id={`${quantityId}-error`}
                  role="alert"
                  className="text-xs leading-relaxed text-destructive"
                >
                  {rejected}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
