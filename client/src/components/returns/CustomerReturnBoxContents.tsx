import type { DragEvent } from "react";
import { ArrowRightLeft, GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  describePreviewItem,
  type PreviewSelections,
} from "@/lib/customer-return-preview";
import {
  readPreviewQuantity,
  type PreviewParcelDraft,
} from "@/lib/customer-return-parcels";
import { previewPackingItemContext } from "@/lib/customer-return-packing";

export function CustomerReturnBoxContents({
  order,
  selections,
  parcel,
  boxNumber,
  busy,
  canMove,
  onMove,
  onSetAside,
  onDragStart,
  onDragEnd,
}: {
  order: CustomerReturnFlowOrder;
  selections: PreviewSelections;
  parcel: PreviewParcelDraft;
  boxNumber: number;
  busy: boolean;
  canMove: boolean;
  onMove: (lineId: string, trigger: HTMLElement) => void;
  onSetAside: (lineId: string) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, lineId: string) => void;
  onDragEnd: () => void;
}) {
  const contents = selections.flatMap((selection) => {
    const quantity = readPreviewQuantity(
      parcel.items.find((item) => item.lineId === selection.lineId)?.quantity ??
        "0",
    );
    return quantity === null || quantity > 0
      ? [{ ...selection, packed: quantity }]
      : [];
  });
  return contents.length === 0 ? (
    <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
      This box is empty. Move items here from another box, or add items from
      Items to pack.
    </p>
  ) : (
    <div className="divide-y">
      {contents.map((item) => {
        const line = order.lines.find(
          (candidate) => candidate.id === item.lineId,
        )!;
        const description = describePreviewItem(order, line.id);
        const context = previewPackingItemContext(order, line.id);
        return (
          <div
            key={line.id}
            data-testid={`packing-item-${parcel.key}-${line.id}`}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1 basis-40">
              <p className="break-words text-sm font-medium leading-5">
                {line.title}
              </p>
              {context && (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {context}
                </p>
              )}
              {item.packed === null && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  Remove this entry and add it again to correct its quantity.
                </p>
              )}
            </div>
            <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
              <div className="min-w-0 px-2 text-right text-xs">
                <span className="block break-all font-medium tabular-nums">
                  {item.packed === null
                    ? "Check quantity"
                    : `${item.packed} of ${item.quantity}`}
                </span>
                <span className="text-muted-foreground">in this box</span>
              </div>
              {canMove && item.packed !== null && (
                <Button
                  variant="outline"
                  className="min-h-11 px-3 [@media(pointer:fine)]:cursor-grab [@media(pointer:fine)]:active:cursor-grabbing"
                  disabled={busy}
                  draggable={!busy}
                  aria-label={`Move ${description.accessibleName} from box ${boxNumber}`}
                  title="Drag to another box, or click to choose a box"
                  onClick={(event) => onMove(line.id, event.currentTarget)}
                  onDragStart={(event) => onDragStart(event, line.id)}
                  onDragEnd={onDragEnd}
                >
                  <GripVertical
                    aria-hidden="true"
                    className="hidden h-3.5 w-3.5 [@media(pointer:fine)]:block"
                  />
                  <ArrowRightLeft
                    aria-hidden="true"
                    className="h-3.5 w-3.5 [@media(pointer:fine)]:hidden"
                  />
                  Move
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={busy}
                aria-label={`Remove ${description.accessibleName} from box ${boxNumber}`}
                title="Remove from this box"
                onClick={() => onSetAside(line.id)}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
