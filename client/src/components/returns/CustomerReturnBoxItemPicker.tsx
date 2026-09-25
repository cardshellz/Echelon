import { useId, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  previewPackingItemContext,
  previewPackingSources,
  transferPreviewPackingQuantity,
} from "@/lib/customer-return-packing";

export function CustomerReturnBoxItemPicker({
  order,
  selections,
  parcels,
  parcelKey,
  boxNumber,
  busy,
  autoFocus,
  triggerRef,
  onEditingEnd,
  onChange,
}: {
  order: CustomerReturnFlowOrder;
  selections: PreviewSelections;
  parcels: PreviewParcelDraft[];
  parcelKey: number;
  boxNumber: number;
  busy: boolean;
  autoFocus: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onEditingEnd: () => void;
  onChange: (parcels: PreviewParcelDraft[]) => void;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const available = open
    ? previewPackingSources(selections, parcels, parcelKey)
    : { ok: true as const, sources: [] };
  function changeOpen(next: boolean) {
    if (next) onEditingEnd();
    setOpen(next);
    setAmounts({});
    setError(null);
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          autoFocus={autoFocus}
          onBlur={onEditingEnd}
          variant="outline"
          className="min-h-11"
          disabled={busy}
          aria-label={`Add or move items to box ${boxNumber}`}
        >
          <Plus aria-hidden="true" className="h-4 w-4" /> Add or move items
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add items to Box {boxNumber}</DialogTitle>
          <DialogDescription>
            Choose items that still need a box, or move items from another box.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!available.ok ? (
          <p className="text-sm">
            Check the quantities in your boxes before adding or moving items.
          </p>
        ) : available.sources.length === 0 ? (
          <p className="text-sm">
            All return items are already in this box. To return more items,
            choose Change return items in the summary.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {available.sources.map((source, sourceIndex) => {
              const line = order.lines.find(
                (item) => item.id === source.lineId,
              )!;
              const description = describePreviewItem(order, line.id);
              const context = previewPackingItemContext(order, line.id);
              const fromBoxNumber =
                source.fromParcelKey === null
                  ? null
                  : parcels.findIndex(
                      (parcel) => parcel.key === source.fromParcelKey,
                    ) + 1;
              const sourceName =
                fromBoxNumber === null
                  ? "items not in a box"
                  : `box ${fromBoxNumber}`;
              // JSON tuple encoding avoids collisions between arbitrary purchased-line IDs.
              const key = JSON.stringify([source.fromParcelKey, source.lineId]);
              const helpId = `${pickerId}-quantity-help-${sourceIndex}`;
              const raw = amounts[key] ?? "1";
              const quantity = readPreviewQuantity(raw);
              const valid =
                quantity !== null &&
                quantity > 0 &&
                quantity <= source.quantity;
              return (
                <form
                  key={key}
                  data-testid={`packing-source-${source.fromParcelKey ?? "unassigned"}-${line.id}`}
                  className="space-y-3 p-3"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy || !valid) return;
                    const result = transferPreviewPackingQuantity(
                      order,
                      selections,
                      parcels,
                      {
                        lineId: source.lineId,
                        fromParcelKey: source.fromParcelKey,
                        toParcelKey: parcelKey,
                        quantity,
                      },
                    );
                    if (result.kind !== "updated") {
                      setError(
                        "Those items are no longer available here. Close this window and check your boxes.",
                      );
                      return;
                    }
                    onChange(result.parcels);
                    changeOpen(false);
                  }}
                >
                  <div className="min-w-0 text-sm">
                    <p className="break-words font-medium">{line.title}</p>
                    {context && (
                      <p className="break-words text-xs text-muted-foreground">
                        {context}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fromBoxNumber === null
                        ? "Not in a box"
                        : `From Box ${fromBoxNumber}`}{" "}
                      · {source.quantity} available
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max={source.quantity}
                      step="1"
                      className="min-h-11 max-w-full text-center tabular-nums"
                      style={{
                        width: `calc(${Math.max(raw.length, 2)}ch + 2.5rem)`,
                      }}
                      aria-label={`Quantity of ${description.accessibleName} to add from ${sourceName}`}
                      aria-invalid={!valid || undefined}
                      aria-describedby={!valid ? helpId : undefined}
                      value={raw}
                      disabled={busy}
                      onChange={(event) => {
                        setAmounts((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }));
                        setError(null);
                      }}
                    />
                    <Button
                      type="submit"
                      className="min-h-11"
                      disabled={busy || !valid}
                    >
                      {fromBoxNumber === null ? "Add to box" : "Move to box"}
                    </Button>
                  </div>
                  {!valid && (
                    <p id={helpId} className="text-xs text-destructive">
                      Enter a whole number from 1 to {source.quantity}.
                    </p>
                  )}
                </form>
              );
            })}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 justify-self-end"
          onClick={() => changeOpen(false)}
        >
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
