import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
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
  intent?: "drop" | "split";
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

function SplitBoxItemControl({
  accessibleName,
  sourceName,
  availableQuantity,
  draft,
  quantity,
  invalid,
  busy,
  helpId,
  onQuantityChange,
}: {
  accessibleName: string;
  sourceName: string;
  availableQuantity: number;
  draft: Pick<MoveDraft, "selected" | "quantity">;
  quantity: number | null;
  invalid: boolean;
  busy: boolean;
  helpId: string;
  onQuantityChange: (value: string) => void;
}) {
  const addButton = useRef<HTMLButtonElement>(null);
  const quantityInput = useRef<HTMLInputElement>(null);
  const wasSelected = useRef(draft.selected);
  const singleItem = availableQuantity === 1;

  useLayoutEffect(() => {
    if (wasSelected.current !== draft.selected && !singleItem) {
      // Add and the stepper replace each other; keep focus on the active control.
      if (draft.selected) {
        quantityInput.current?.focus();
        quantityInput.current?.select();
      } else {
        addButton.current?.focus();
      }
    }
    wasSelected.current = draft.selected;
  }, [draft.selected, singleItem]);

  if (singleItem || !draft.selected) {
    return (
      <Button
        ref={addButton}
        type="button"
        variant={draft.selected ? "default" : "outline"}
        className="min-h-11 w-28 shrink-0 gap-2"
        aria-label={
          draft.selected
            ? `Remove ${accessibleName} from new box`
            : `Add ${accessibleName} to new box`
        }
        aria-pressed={singleItem ? draft.selected : undefined}
        disabled={busy}
        onClick={() => onQuantityChange(draft.selected ? "0" : "1")}
      >
        {draft.selected ? (
          <Check aria-hidden="true" className="h-4 w-4" />
        ) : (
          <Plus aria-hidden="true" className="h-4 w-4" />
        )}
        {draft.selected ? "Added" : "Add"}
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-label={`${accessibleName}: quantity in new box`}
      className="max-w-full space-y-1 text-center"
    >
      <div className="flex max-w-full items-center rounded-md border border-input bg-background">
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-h-11 w-11 shrink-0 rounded-r-none p-0"
          aria-label={`Move one ${accessibleName} back to ${sourceName}`}
          disabled={busy || invalid || quantity === null}
          onClick={() => {
            if (quantity !== null) onQuantityChange(String(quantity - 1));
          }}
        >
          <Minus aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Input
          ref={quantityInput}
          type="number"
          inputMode="numeric"
          min="0"
          max={availableQuantity}
          step="1"
          className="h-11 min-h-11 w-14 min-w-0 rounded-none border-x border-y-0 px-1 text-center tabular-nums shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          aria-label={`Quantity of ${accessibleName} in new box`}
          aria-invalid={invalid || undefined}
          aria-describedby={`${helpId}-limit${invalid ? ` ${helpId}` : ""}`}
          disabled={busy}
          value={draft.quantity}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-h-11 w-11 shrink-0 rounded-l-none p-0"
          aria-label={`Add one ${accessibleName} to new box`}
          disabled={
            busy ||
            invalid ||
            quantity === null ||
            quantity >= availableQuantity
          }
          onClick={() => {
            if (quantity === null) return;
            // A disabled + button cannot retain keyboard focus at the limit.
            if (quantity + 1 === availableQuantity)
              quantityInput.current?.focus();
            onQuantityChange(String(quantity + 1));
          }}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
      <p id={`${helpId}-limit`} className="text-xs text-muted-foreground">
        of {availableQuantity}
      </p>
      {invalid && (
        <p
          id={helpId}
          role="alert"
          className="max-w-48 break-words text-xs text-destructive"
        >
          Enter a whole number from 0 to {availableQuantity}.
        </p>
      )}
    </div>
  );
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
  const isDrop = request.intent === "drop";
  const isSplit = request.intent === "split";
  const singleProduct =
    request.lineId !== undefined && !request.removeSource && !isSplit;
  const fixedDestination = isDrop || isSplit;
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
    (!isDrop ||
      (singleProduct &&
        request.destination !== undefined &&
        request.sourceParcelKey !== null)) &&
    (!isSplit || (!request.removeSource && request.sourceParcelKey !== null)) &&
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
    if (isSplit) return "new";
    if (isDrop) {
      return preferred?.kind === "new"
        ? "new"
        : preferred?.kind === "existing"
          ? `box-${preferred.parcelKey}`
          : "";
    }
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
              request.removeSource ||
                (!isSplit && request.lineId === source.lineId),
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
    : !destination && fixedDestination
      ? "This destination is no longer available. Close this window and choose another box."
      : wouldOnlyReplaceBox
        ? isSplit
          ? `Keep at least one item in ${sourceName}.`
          : fixedDestination
            ? `Leave at least one item in ${sourceName}.`
            : `Leave at least one item in ${sourceName}, or choose an existing box.`
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
    : isSplit
      ? "Pack a new box"
      : isDrop
        ? request.destination?.kind === "new"
          ? "Move to a new box"
          : destinationParcel
            ? `Move to ${destinationName}`
            : "Move items"
        : request.sourceParcelKey === null
          ? "Add items to a box"
          : `Move items from ${sourceName}`;
  const action = request.removeSource
    ? "Remove box and move items"
    : isSplit
      ? "Create box"
      : isDrop
        ? "Move items"
        : destination?.kind === "new"
          ? "Create box and move"
          : "Move items";
  const visibleSources = singleProduct
    ? sources.filter((source) => source.lineId === request.lineId)
    : sources;
  const showMoveTotals = !singleProduct && !isSplit && !isDrop;
  const splitQuantity = selected.length === 0 ? 0 : movingQuantity;
  const remainingSourceQuantity =
    splitQuantity === null ? null : sourceQuantity - splitQuantity;
  const destinationRenumbered =
    preview?.kind === "updated" &&
    destinationParcel !== undefined &&
    destinationIndex !==
      preview.parcels.findIndex(
        (parcel) => parcel.key === preview.destinationParcelKey,
      );

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
        className={`max-h-[85dvh] overflow-y-auto ${singleProduct ? "sm:max-w-md" : "sm:max-w-xl"}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={isDrop ? "sr-only" : undefined}>
            {request.removeSource
              ? "All items in this box will move together. Choose the box they should go in."
              : isSplit
                ? `Choose items from ${sourceName}.`
                : isDrop
                  ? "Choose how many to move."
                  : singleProduct
                    ? "Choose a box and how many to move."
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
          {!fixedDestination && (
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
          )}
          {contextValid && (
            <div
              className={`divide-y rounded-lg border ${isSplit ? "overflow-hidden" : ""}`}
            >
              {visibleSources.map((source, index) => {
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
                const product = (
                  <span className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
                    {line.title}
                    {context && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {context}
                      </span>
                    )}
                  </span>
                );
                if (isSplit) {
                  return (
                    <div
                      key={line.id}
                      data-testid={`move-line-${line.id}`}
                      className={`grid min-w-0 grid-cols-1 items-center gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4 ${draft.selected ? "bg-primary/5" : ""}`}
                    >
                      {product}
                      <div className="max-w-full justify-self-end">
                        <SplitBoxItemControl
                          accessibleName={description.accessibleName}
                          sourceName={sourceName}
                          availableQuantity={source.quantity}
                          draft={draft}
                          quantity={quantity}
                          invalid={invalid}
                          busy={busy}
                          helpId={helpId}
                          onQuantityChange={(value) => {
                            // Empty input is an unfinished edit, not a request to remove.
                            const deselect =
                              value !== "" && readPreviewQuantity(value) === 0;
                            updateDraft(line.id, {
                              selected: !deselect,
                              quantity: value,
                              quantityEdited: true,
                            });
                          }}
                        />
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={line.id}
                    data-testid={`move-line-${line.id}`}
                    className="min-w-0 space-y-2 p-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-start gap-3">
                      {singleProduct ? (
                        <div className="min-w-0 flex-1 basis-36 py-1">
                          {product}
                        </div>
                      ) : (
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
                          {product}
                        </label>
                      )}
                      {(!singleProduct || source.quantity > 1) && (
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
                      )}
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
          {!isSplit && contextValid && !selected.length && (
            <p className="text-sm text-muted-foreground">
              Select at least one item to move.
            </p>
          )}
          {!isDrop &&
            preview?.kind === "updated" &&
            (showMoveTotals ||
              preview.removedParcelKeys.length > 0 ||
              destinationRenumbered) && (
              <section
                aria-label="Move preview"
                aria-live="polite"
                className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm"
              >
                {showMoveTotals && (
                  <>
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
                                  (parcel) =>
                                    parcel.key === request.sourceParcelKey,
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
                              (parcel) =>
                                parcel.key === preview.destinationParcelKey,
                            ),
                          ) ?? "Check quantity"}{" "}
                          items
                        </dd>
                      </div>
                    </dl>
                  </>
                )}
                {preview.removedParcelKeys.map((key) => (
                  <p key={key} className="text-xs text-muted-foreground">
                    Box {parcels.findIndex((parcel) => parcel.key === key) + 1}{" "}
                    will be removed because all its items are moving.
                  </p>
                ))}
                {destinationRenumbered && (
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
          <div
            className={
              isSplit
                ? "flex flex-wrap items-center justify-between gap-4 border-t pt-4"
                : undefined
            }
          >
            {isSplit && contextValid && (
              <div
                role="status"
                aria-label="New box summary"
                aria-live="polite"
                aria-atomic="true"
                className="min-w-0 space-y-1 text-sm"
              >
                <p className="font-medium tabular-nums">
                  {splitQuantity === null
                    ? "Check item quantities"
                    : `${splitQuantity} ${splitQuantity === 1 ? "item" : "items"} in new box`}
                </p>
                {remainingSourceQuantity !== null && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {remainingSourceQuantity}{" "}
                    {remainingSourceQuantity === 1
                      ? "item stays"
                      : "items stay"}{" "}
                    in {sourceName}
                  </p>
                )}
              </div>
            )}
            <div
              className={
                isSplit
                  ? "ml-auto flex flex-wrap gap-2"
                  : "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
              }
            >
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
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
