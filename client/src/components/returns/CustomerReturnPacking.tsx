import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Loader2,
  Package,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  describePreviewItem,
  type PreviewSelections,
} from "@/lib/customer-return-preview";
import {
  previewParcelProductWeight,
  readPreviewQuantity,
  type PreviewParcelDraft,
} from "@/lib/customer-return-parcels";
import {
  changePreviewPackingQuantity,
  movePreviewPackingItems,
  previewPackingAllocations,
  previewPackingItemContext,
  summarizePreviewPacking,
  type PreviewPackingMoveCommand,
  type PreviewPackingMoveDestination,
  type PreviewPackingMoveResult,
} from "@/lib/customer-return-packing";
import { CustomerReturnBoxContents } from "./CustomerReturnBoxContents";
import { CustomerReturnPackingSummary } from "./CustomerReturnPackingSummary";
import { CustomerReturnParcelDetails } from "./CustomerReturnParcelDetails";
import {
  CustomerReturnMoveItemsDialog,
  type CustomerReturnMoveRequest,
} from "./CustomerReturnMoveItemsDialog";

const RETURN_ITEM_DRAG_TYPE = "application/x-echelon-return-item";
type DraggedItem = { sourceParcelKey: number; lineId: string };
type DialogFocus = { boxKey: number } | { trigger: HTMLElement };
type PackingNotice = {
  text: string;
  after: PreviewParcelDraft[];
  before?: PreviewParcelDraft[];
};

export function CustomerReturnPacking({
  order,
  selections,
  parcels,
  busy,
  onChange,
  onContinue,
  onBack,
}: {
  order: CustomerReturnFlowOrder;
  selections: PreviewSelections;
  parcels: PreviewParcelDraft[];
  busy: boolean;
  onChange: (parcels: PreviewParcelDraft[]) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const boxesHeading = useRef<HTMLHeadingElement>(null);

  const boxHeadings = useRef(new Map<number, HTMLHeadingElement>());
  const unassignedActions = useRef(new Map<string, HTMLButtonElement>());
  const pendingUnassignedFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const lineId = pendingUnassignedFocus.current;
    if (lineId === null) return;
    (unassignedActions.current.get(lineId) ?? boxesHeading.current)?.focus();
    pendingUnassignedFocus.current = null;
  }, [parcels]);
  const focusAfterDialog = useRef<DialogFocus | null>(null);
  const dragSource = useRef<DraggedItem | null>(null);
  const dragTrigger = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<DraggedItem | null>(null);
  const [overBox, setOverBox] = useState<number | "new" | null>(null);
  const [request, setRequest] = useState<CustomerReturnMoveRequest | null>(
    null,
  );
  const [notice, setNotice] = useState<PackingNotice | null>(null);
  const summary = summarizePreviewPacking(selections, parcels);
  const allocations = previewPackingAllocations(selections, parcels);
  const sources = allocations.ok ? allocations.sources : [];
  const unassigned = sources.filter((source) => source.fromParcelKey === null);
  const currentNotice = notice?.after === parcels ? notice : null;
  const weightNeedsVerification = parcels.some(
    (parcel) =>
      previewParcelProductWeight(order, parcel).status === "unverified",
  );
  const boxNumber = (key: number) =>
    parcels.findIndex((parcel) => parcel.key === key) + 1;
  const unitsInBox = (key: number) =>
    sources
      .filter((source) => source.fromParcelKey === key)
      .reduce((total, source) => total + source.quantity, 0);
  const canSplit = (key: number) =>
    allocations.ok && summary.canAddBox && unitsInBox(key) > 1;
  const canMove = (key: number) =>
    allocations.ok &&
    unitsInBox(key) > 0 &&
    (parcels.length > 1 || canSplit(key));

  function openMove(next: CustomerReturnMoveRequest, trigger: HTMLElement) {
    if (busy) return;
    focusAfterDialog.current = { trigger };
    setRequest(next);
  }
  function restoreDialogFocus() {
    const target = focusAfterDialog.current;
    if (target && "boxKey" in target) {
      (boxHeadings.current.get(target.boxKey) ?? boxesHeading.current)?.focus();
    } else if (target?.trigger.isConnected) {
      target.trigger.focus();
    } else {
      boxesHeading.current?.focus();
    }
    focusAfterDialog.current = null;
  }
  function applyMove(
    command: PreviewPackingMoveCommand,
  ): PreviewPackingMoveResult {
    if (busy) return { kind: "invalid_context" };
    const result = movePreviewPackingItems(order, selections, parcels, command);
    if (result.kind !== "updated") return result;
    const moved = command.items.reduce(
      (total, item) => total + item.quantity,
      0,
    );
    const destination =
      result.parcels.findIndex(
        (parcel) => parcel.key === result.destinationParcelKey,
      ) + 1;
    setNotice({
      text: `Moved ${moved} ${moved === 1 ? "item" : "items"} to Box ${destination}.${result.removedParcelKeys.length ? " Empty source boxes were removed." : ""}`,
      before: parcels,
      after: result.parcels,
    });
    focusAfterDialog.current = { boxKey: result.destinationParcelKey };
    onChange(result.parcels);
    return result;
  }
  function setAside(parcel: PreviewParcelDraft, lineId: string) {
    if (busy) return;
    const result = changePreviewPackingQuantity(
      order,
      selections,
      parcels,
      parcel.key,
      lineId,
      "0",
    );
    if (result.kind !== "updated") {
      setNotice({
        text: "Check the quantities in your boxes before removing this item.",
        after: parcels,
      });
      return;
    }
    const title = order.lines.find((line) => line.id === lineId)!.title;
    setNotice({
      text: `${title} is ready to add to another box.`,
      before: parcels,
      after: result.parcels,
    });
    pendingUnassignedFocus.current = lineId;
    onChange(result.parcels);
  }
  function removeBox(parcel: PreviewParcelDraft, trigger: HTMLElement) {
    if (busy || parcels.length <= 1) return;
    const empty = parcel.items.every(
      (item) => readPreviewQuantity(item.quantity) === 0,
    );
    if (!empty) {
      openMove({ sourceParcelKey: parcel.key, removeSource: true }, trigger);
      return;
    }
    const next = parcels.filter((candidate) => candidate.key !== parcel.key);
    setNotice({
      text: `Removed empty Box ${boxNumber(parcel.key)}.`,
      before: parcels,
      after: next,
    });
    onChange(next);
    boxesHeading.current?.focus();
  }
  function undo() {
    if (busy || !currentNotice?.before) return;
    onChange(currentNotice.before);
    setNotice({ text: "Change undone.", after: currentNotice.before });
    boxesHeading.current?.focus();
  }
  function clearDrag() {
    dragSource.current = null;
    dragTrigger.current = null;
    setDragging(null);
    setOverBox(null);
  }
  function startDrag(
    event: DragEvent<HTMLButtonElement>,
    parcelKey: number,
    lineId: string,
  ) {
    if (
      busy ||
      !canMove(parcelKey) ||
      !sources.some(
        (source) =>
          source.fromParcelKey === parcelKey && source.lineId === lineId,
      )
    ) {
      event.preventDefault();
      return;
    }
    const item = { sourceParcelKey: parcelKey, lineId };
    // A private in-memory origin is required as well as the MIME marker: external
    // drops cannot invent an allocation or invoke the move action.
    dragSource.current = item;
    dragTrigger.current = event.currentTarget;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(RETURN_ITEM_DRAG_TYPE, JSON.stringify(item));
    setDragging(item);
  }
  function canDrop(event: DragEvent<HTMLElement>, destination: number | "new") {
    const source = dragSource.current;
    if (
      busy ||
      !source ||
      !event.dataTransfer.types.includes(RETURN_ITEM_DRAG_TYPE)
    )
      return false;
    if (
      !sources.some(
        (item) =>
          item.fromParcelKey === source.sourceParcelKey &&
          item.lineId === source.lineId,
      )
    )
      return false;
    return destination === "new"
      ? canSplit(source.sourceParcelKey)
      : destination !== source.sourceParcelKey &&
          parcels.some((parcel) => parcel.key === destination);
  }
  function dragOver(
    event: DragEvent<HTMLElement>,
    destination: number | "new",
  ) {
    if (!canDrop(event, destination)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOverBox(destination);
  }
  function drop(event: DragEvent<HTMLElement>, destination: number | "new") {
    if (!canDrop(event, destination)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = dragSource.current!;
    const trigger = dragTrigger.current;
    if (
      event.dataTransfer.getData(RETURN_ITEM_DRAG_TYPE) !==
        JSON.stringify(source) ||
      !trigger
    ) {
      clearDrag();
      return;
    }
    const target: PreviewPackingMoveDestination =
      destination === "new"
        ? { kind: "new" }
        : { kind: "existing", parcelKey: destination };
    openMove({ ...source, destination: target }, trigger);
    clearDrag();
  }

  return (
    <div className="space-y-5">
      <CustomerReturnPackingSummary
        order={order}
        summary={summary}
        boxCount={parcels.length}
        busy={busy}
        onChangeItems={onBack}
      />
      {unassigned.length > 0 && (
        <section
          data-testid="packing-unassigned"
          aria-labelledby="unassigned-items-title"
          className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-800 dark:bg-amber-950/20"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="unassigned-items-title" className="text-sm font-semibold">
              Items to pack
            </h2>
            {unassigned.length > 1 && (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={busy}
                onClick={(event) =>
                  openMove({ sourceParcelKey: null }, event.currentTarget)
                }
              >
                Add items to a box
              </Button>
            )}
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            These items are still in your return. Choose a box for them.
          </p>
          <div className="divide-y">
            {unassigned.map((item) => {
              const line = order.lines.find(
                (candidate) => candidate.id === item.lineId,
              )!;
              const description = describePreviewItem(order, line.id);
              const context = previewPackingItemContext(order, line.id);
              return (
                <div
                  key={line.id}
                  data-testid={`unassigned-item-${line.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0 flex-1 basis-40 text-sm">
                    <p className="break-words font-medium">{line.title}</p>
                    {context && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {context}
                      </p>
                    )}
                  </div>
                  <span className="text-sm tabular-nums">
                    {item.quantity} to pack
                  </span>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    ref={(element) => {
                      if (element)
                        unassignedActions.current.set(line.id, element);
                      else unassignedActions.current.delete(line.id);
                    }}
                    aria-label={`Add ${description.accessibleName} to a box`}
                    onClick={(event) =>
                      openMove(
                        { sourceParcelKey: null, lineId: line.id },
                        event.currentTarget,
                      )
                    }
                  >
                    Add to box
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section
        aria-labelledby="return-boxes-title"
        data-testid="packing-boxes"
        className="space-y-4"
      >
        <div>
          <h2
            ref={boxesHeading}
            tabIndex={-1}
            id="return-boxes-title"
            className="font-semibold"
          >
            Your boxes
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.selectedQuantity === 1
              ? "One item, one box. Check the box size, then review your return."
              : "Use Move to split items into a new box or move them between boxes."}
          </p>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {currentNotice && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <p className="min-w-0 flex-1 break-words">{currentNotice.text}</p>
              {currentNotice.before && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy}
                  onClick={undo}
                >
                  <Undo2 aria-hidden="true" className="h-4 w-4" /> Undo
                </Button>
              )}
            </div>
          )}
        </div>
        {parcels.map((parcel, index) => (
          <section
            key={parcel.key}
            data-testid={`preview-box-${index + 1}`}
            aria-labelledby={`preview-box-title-${parcel.key}`}
            onDragOver={(event) => dragOver(event, parcel.key)}
            onDragLeave={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              )
                setOverBox(null);
            }}
            onDrop={(event) => drop(event, parcel.key)}
            className={`min-w-0 rounded-xl border p-4 transition-colors sm:p-5 ${overBox === parcel.key ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "bg-background"}`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3
                ref={(element) => {
                  if (element) boxHeadings.current.set(parcel.key, element);
                  else boxHeadings.current.delete(parcel.key);
                }}
                tabIndex={-1}
                id={`preview-box-title-${parcel.key}`}
                className="flex items-center gap-2 font-semibold"
              >
                <Package aria-hidden="true" className="h-5 w-5 text-primary" />{" "}
                Box {index + 1}
              </h3>
              <div className="flex flex-wrap items-center gap-1">
                {canMove(parcel.key) && (
                  <Button
                    variant="ghost"
                    className="min-h-11 px-2"
                    disabled={busy}
                    aria-label={`Move items from box ${index + 1}`}
                    onClick={(event) =>
                      openMove(
                        { sourceParcelKey: parcel.key },
                        event.currentTarget,
                      )
                    }
                  >
                    <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />{" "}
                    Move items
                  </Button>
                )}
                {parcels.length > 1 && (
                  <Button
                    variant="ghost"
                    className="min-h-11 px-2"
                    disabled={busy}
                    aria-label={`Remove box ${index + 1}`}
                    onClick={(event) => removeBox(parcel, event.currentTarget)}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" /> Remove box
                  </Button>
                )}
              </div>
            </div>
            {dragging && dragging.sourceParcelKey !== parcel.key && (
              <p className="mb-3 text-xs font-medium text-primary">
                Drop here to choose how many to move.
              </p>
            )}
            <CustomerReturnParcelDetails
              order={order}
              parcel={parcel}
              boxNumber={index + 1}
              busy={busy}
              onChange={(next) =>
                onChange(
                  parcels.map((candidate) =>
                    candidate.key === parcel.key ? next : candidate,
                  ),
                )
              }
            />
            <CustomerReturnBoxContents
              order={order}
              selections={selections}
              parcel={parcel}
              boxNumber={index + 1}
              busy={busy}
              canMove={canMove(parcel.key)}
              onMove={(lineId, trigger) =>
                openMove({ sourceParcelKey: parcel.key, lineId }, trigger)
              }
              onSetAside={(lineId) => setAside(parcel, lineId)}
              onDragStart={(event, lineId) =>
                startDrag(event, parcel.key, lineId)
              }
              onDragEnd={clearDrag}
            />
          </section>
        ))}
        {dragging && canSplit(dragging.sourceParcelKey) && (
          <div
            data-testid="packing-new-box-drop"
            onDragOver={(event) => dragOver(event, "new")}
            onDrop={(event) => drop(event, "new")}
            onDragLeave={() => setOverBox(null)}
            className={`flex items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-sm font-medium ${overBox === "new" ? "border-primary bg-primary/10" : "border-primary/40 bg-primary/5"}`}
          >
            <Plus aria-hidden="true" className="h-5 w-5" /> Drop here to pack a
            new box
          </div>
        )}
      </section>
      <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:justify-between">
        <Button variant="ghost" className="min-h-11" onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" /> Back to
          items
        </Button>
        <Button
          className="min-h-11"
          onClick={onContinue}
          disabled={busy || weightNeedsVerification || !summary.ready}
        >
          {busy ? (
            <>
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin"
              />{" "}
              Checking your return…
            </>
          ) : (
            <>
              Review return{" "}
              <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
      {request && (
        <CustomerReturnMoveItemsDialog
          order={order}
          selections={selections}
          parcels={parcels}
          request={request}
          busy={busy}
          onApply={applyMove}
          onClose={() => setRequest(null)}
          onCloseAutoFocus={restoreDialogFocus}
        />
      )}
    </div>
  );
}
