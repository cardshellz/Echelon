import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
  movePreviewPackingItems,
  previewPackingAllocations,
  previewPackingItemContext,
  summarizePreviewPacking,
  type PreviewPackingMoveCommand,
  type PreviewPackingMoveDestination,
  type PreviewPackingMoveResult,
} from "@/lib/customer-return-packing";

export interface CustomerReturnMoveRequest {
  sourceParcelKey: number | null;
  lineId?: string;
  destination?: PreviewPackingMoveDestination;
  removeSource?: boolean;
}

interface MoveDraft {
  selected: boolean;
  quantity: string;
  quantityEdited: boolean;
}

function moveError(
  kind: Exclude<PreviewPackingMoveResult["kind"], "updated">,
): string {
  switch (kind) {
    case "invalid_context":
      return "Your box contents changed. Close this window and check your boxes.";
    case "invalid_quantity":
      return "Check the quantities you want to move.";
    case "box_limit":
      return "You have reached the box limit. Choose an existing box.";
    case "unchanged":
      return "Choose a different box to move these items.";
  }
}

function boxQuantity(parcel: PreviewParcelDraft | undefined): number | null {
  if (!parcel) return 0;
  let total = 0;
  for (const item of parcel.items) {
    const quantity = readPreviewQuantity(item.quantity);
    if (quantity === null || quantity > Number.MAX_SAFE_INTEGER - total)
      return null;
    total += quantity;
  }
  return total;
}

export function CustomerReturnMoveItemsDialog({
  order,
  selections,
  parcels,
  request,
  busy,
  onClose,
  onApply,
  onCloseAutoFocus,
}: {
  order: CustomerReturnFlowOrder;
  selections: PreviewSelections;
  parcels: PreviewParcelDraft[];
  request: CustomerReturnMoveRequest;
  busy: boolean;
  onClose: () => void;
  onApply: (command: PreviewPackingMoveCommand) => PreviewPackingMoveResult;
  onCloseAutoFocus: () => void;
}) {
  const id = useId();
  const allocations = previewPackingAllocations(selections, parcels);
  const sources = allocations.ok
    ? allocations.sources.filter(
        (source) => source.fromParcelKey === request.sourceParcelKey,
      )
    : [];
  const sourceIndex = parcels.findIndex(
    (parcel) => parcel.key === request.sourceParcelKey,
  );
  const sourceName =
    request.sourceParcelKey === null
      ? "Items not in a box"
      : `Box ${sourceIndex + 1}`;
  const sourceQuantity = sources.reduce(
    (total, source) => total + source.quantity,
    0,
  );
  const contextValid =
    allocations.ok &&
    sources.length > 0 &&
    (request.sourceParcelKey === null || sourceIndex >= 0) &&
    (!request.removeSource || request.sourceParcelKey !== null) &&
    (request.lineId === undefined ||
      sources.some((source) => source.lineId === request.lineId)) &&
    sources.every((source) =>
      order.lines.some((line) => line.id === source.lineId),
    );
  const summary = summarizePreviewPacking(selections, parcels);
  const targets = parcels.filter(
    (parcel) => parcel.key !== request.sourceParcelKey,
  );
  const canCreateBox =
    contextValid &&
    !request.removeSource &&
    summary.canAddBox &&
    (request.sourceParcelKey === null
      ? sourceQuantity > 0
      : sourceQuantity > 1);
  const [destinationValue, setDestinationValue] = useState(() => {
    const preferred = request.destination;
    if (
      preferred?.kind === "existing" &&
      targets.some((parcel) => parcel.key === preferred.parcelKey)
    ) {
      return `box-${preferred.parcelKey}`;
    }
    if (preferred?.kind === "new" && canCreateBox) return "new";
    return targets.length ? `box-${targets[0].key}` : canCreateBox ? "new" : "";
  });
  const [drafts, setDrafts] = useState(
    () =>
      new Map<string, MoveDraft>(
        sources.map((source) => [
          source.lineId,
          {
            selected: Boolean(
              request.removeSource || request.lineId === source.lineId,
            ),
            quantity: String(
              destinationValue === "new" &&
                request.sourceParcelKey !== null &&
                source.quantity === sourceQuantity
                ? 1
                : source.quantity,
            ),
            quantityEdited: false,
          },
        ]),
      ),
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const destinationParcel = targets.find(
    (parcel) => `box-${parcel.key}` === destinationValue,
  );
  const destination: PreviewPackingMoveDestination | null =
    destinationValue === "new"
      ? canCreateBox
        ? { kind: "new" }
        : null
      : destinationParcel
        ? { kind: "existing", parcelKey: destinationParcel.key }
        : null;
  const selected = sources.flatMap((source) => {
    const draft = request.removeSource
      ? { selected: true, quantity: String(source.quantity) }
      : drafts.get(source.lineId);
    return draft?.selected
      ? [{ source, quantity: readPreviewQuantity(draft.quantity) }]
      : [];
  });
  const validQuantities =
    selected.length > 0 &&
    selected.every(
      ({ source, quantity }) =>
        quantity !== null && quantity > 0 && quantity <= source.quantity,
    );
  const movingQuantity = validQuantities
    ? selected.reduce((total, item) => total + item.quantity!, 0)
    : null;
  const wouldOnlyReplaceBox =
    destination?.kind === "new" &&
    request.sourceParcelKey !== null &&
    movingQuantity === sourceQuantity;
  const command: PreviewPackingMoveCommand | null =
    contextValid && validQuantities && destination && !wouldOnlyReplaceBox
      ? {
          destination,
          items: selected.map(({ source, quantity }) => ({
            lineId: source.lineId,
            fromParcelKey: source.fromParcelKey,
            quantity: quantity!,
          })),
        }
      : null;
  const preview = command
    ? movePreviewPackingItems(order, selections, parcels, command)
    : null;
  const previewError = !contextValid
    ? "These items are no longer available. Close this window and check your boxes."
    : wouldOnlyReplaceBox
      ? `Leave at least one item in ${sourceName}, or choose an existing box.`
      : preview && preview.kind !== "updated"
        ? moveError(preview.kind)
        : null;
  const error = applyError ?? previewError;
  const ready = !busy && command !== null && preview?.kind === "updated";
  const destinationIndex = parcels.findIndex(
    (parcel) => parcel.key === destinationParcel?.key,
  );
  const destinationName =
    destination?.kind === "new" ? "New box" : `Box ${destinationIndex + 1}`;
  const title = request.removeSource
    ? `Remove ${sourceName}`
    : request.sourceParcelKey === null
      ? "Add items to a box"
      : `Move items from ${sourceName}`;
  const action = request.removeSource
    ? "Remove box and move items"
    : destination?.kind === "new"
      ? "Create box and move"
      : "Move items";

  function updateDraft(lineId: string, patch: Partial<MoveDraft>) {
    setDrafts((current) => {
      const next = new Map(current);
      next.set(lineId, {
        selected: false,
        quantity: "1",
        quantityEdited: false,
        ...next.get(lineId),
        ...patch,
      });
      return next;
    });
    setApplyError(null);
  }

  function changeDestination(value: string) {
    setDestinationValue(value);
    setApplyError(null);
    if (
      value !== "new" ||
      !canCreateBox ||
      request.sourceParcelKey === null ||
      sources.length !== 1
    ) {
      return;
    }
    const source = sources[0];
    setDrafts((current) => {
      const draft = current.get(source.lineId);
      if (
        !draft?.selected ||
        draft.quantityEdited ||
        readPreviewQuantity(draft.quantity) !== source.quantity
      ) {
        return current;
      }
      // A new box should split this untouched default, not replace its donor.
      // Explicit quantity edits remain the customer's choice across destinations.
      const next = new Map(current);
      next.set(source.lineId, { ...draft, quantity: "1" });
      return next;
    });
  }

  function apply() {
    if (!ready || !command) return;
    try {
      const result = onApply(command);
      if (result.kind === "updated") onClose();
      else setApplyError(moveError(result.kind));
    } catch {
      console.error("RETURN_PACKING_MOVE_FAILED");
      setApplyError(
        "The move could not be completed. Close this window and check your boxes before trying again.",
      );
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {request.removeSource
              ? "All items in this box will move together. Choose the box they should go in."
              : "Choose the items, quantities, and box. Nothing changes until you confirm."}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-destination`}>Destination box</Label>
            <select
              id={`${id}-destination`}
              aria-label="Destination box"
              aria-describedby={error ? `${id}-error` : undefined}
              className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={destinationValue}
              disabled={busy || !contextValid}
              onChange={(event) => changeDestination(event.target.value)}
            >
              <option value="">Choose a box</option>
              {destinationValue && !destination && (
                <option value={destinationValue} disabled>
                  Destination unavailable
                </option>
              )}
              {targets.map((parcel) => (
                <option key={parcel.key} value={`box-${parcel.key}`}>
                  Box{" "}
                  {parcels.findIndex(
                    (candidate) => candidate.key === parcel.key,
                  ) + 1}
                </option>
              ))}
              {canCreateBox && <option value="new">New box</option>}
            </select>
          </div>
          {contextValid && (
            <div className="divide-y rounded-lg border">
              {sources.map((source, index) => {
                const line = order.lines.find(
                  (item) => item.id === source.lineId,
                )!;
                const description = describePreviewItem(order, line.id);
                const context = previewPackingItemContext(order, line.id);
                const draft = request.removeSource
                  ? { selected: true, quantity: String(source.quantity) }
                  : (drafts.get(source.lineId) ?? {
                      selected: false,
                      quantity: "1",
                      quantityEdited: false,
                    });
                const quantity = readPreviewQuantity(draft.quantity);
                const invalid =
                  draft.selected &&
                  (quantity === null ||
                    quantity < 1 ||
                    quantity > source.quantity);
                const helpId = `${id}-quantity-help-${index}`;
                return (
                  <div
                    key={line.id}
                    data-testid={`move-line-${line.id}`}
                    className="min-w-0 space-y-2 p-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-start gap-3">
                      <label
                        htmlFor={`${id}-select-${index}`}
                        className="flex min-h-11 min-w-0 flex-1 basis-36 items-start gap-2 py-1"
                      >
                        <input
                          id={`${id}-select-${index}`}
                          type="checkbox"
                          className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                          aria-label={`Select ${description.accessibleName} to move`}
                          checked={draft.selected}
                          disabled={busy || request.removeSource}
                          onChange={(event) =>
                            updateDraft(line.id, {
                              selected: event.target.checked,
                            })
                          }
                        />
                        <span className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
                          {line.title}
                          {context && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {context}
                            </span>
                          )}
                        </span>
                      </label>
                      <div className="max-w-full space-y-1">
                        <Label
                          htmlFor={`${id}-quantity-${index}`}
                          className="text-xs"
                        >
                          Quantity to move
                        </Label>
                        <Input
                          id={`${id}-quantity-${index}`}
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max={source.quantity}
                          step="1"
                          className="min-h-11 max-w-full text-center tabular-nums"
                          style={{
                            width: `calc(${Math.max(draft.quantity.length, 2)}ch + 2.5rem)`,
                          }}
                          aria-label={`Quantity of ${description.accessibleName} to move`}
                          aria-invalid={invalid || undefined}
                          aria-describedby={helpId}
                          disabled={
                            busy || request.removeSource || !draft.selected
                          }
                          value={draft.quantity}
                          onChange={(event) =>
                            updateDraft(line.id, {
                              quantity: event.target.value,
                              quantityEdited: true,
                            })
                          }
                        />
                      </div>
                    </div>
                    <p
                      id={helpId}
                      className={`break-words text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {invalid
                        ? `Enter a whole number from 1 to ${source.quantity}.`
                        : `${source.quantity} available`}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
          {error && (
            <p
              id={`${id}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {contextValid && !selected.length && (
            <p className="text-sm text-muted-foreground">
              Select at least one item to move.
            </p>
          )}
          {preview?.kind === "updated" && (
            <section
              aria-label="Move preview"
              aria-live="polite"
              className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm"
            >
              <p className="font-medium">Before → After</p>
              <dl className="space-y-1 tabular-nums">
                <div className="flex flex-wrap justify-between gap-x-3">
                  <dt>{sourceName}</dt>
                  <dd className="break-all">
                    {sourceQuantity} →{" "}
                    {request.sourceParcelKey === null
                      ? sourceQuantity - (movingQuantity ?? 0)
                      : (boxQuantity(
                          preview.parcels.find(
                            (parcel) => parcel.key === request.sourceParcelKey,
                          ),
                        ) ?? "Check quantity")}{" "}
                    items
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-x-3">
                  <dt>{destinationName}</dt>
                  <dd className="break-all">
                    {boxQuantity(destinationParcel) ?? "Check quantity"} →{" "}
                    {boxQuantity(
                      preview.parcels.find(
                        (parcel) => parcel.key === preview.destinationParcelKey,
                      ),
                    ) ?? "Check quantity"}{" "}
                    items
                  </dd>
                </div>
              </dl>
              {preview.removedParcelKeys.map((key) => (
                <p key={key} className="text-xs text-muted-foreground">
                  Box {parcels.findIndex((parcel) => parcel.key === key) + 1}{" "}
                  will be removed because all its items are moving.
                </p>
              ))}
              {destinationParcel &&
                destinationIndex !==
                  preview.parcels.findIndex(
                    (parcel) => parcel.key === preview.destinationParcelKey,
                  ) && (
                  <p className="text-xs text-muted-foreground">
                    {destinationName} will be shown as Box{" "}
                    {preview.parcels.findIndex(
                      (parcel) => parcel.key === preview.destinationParcelKey,
                    ) + 1}{" "}
                    after the empty box is removed.
                  </p>
                )}
            </section>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              disabled={!ready}
              aria-describedby={error ? `${id}-error` : undefined}
            >
              {action}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
