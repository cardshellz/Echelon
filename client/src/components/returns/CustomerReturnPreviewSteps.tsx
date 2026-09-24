import {
  ArrowLeft,
  ArrowRight,
  Check,
  Info,
  Loader2,
  Package,
  Plus,
  ShieldCheck,
  Trash2,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_RETURN_FLOW_PARCELS,
  type CustomerReturnFlowOrder,
  type CustomerReturnFlowReason,
  type CustomerReturnFlowReview,
} from "@shared/returns/customer-return-flow.contract";
import {
  describePreviewItem,
  readPreviewQuantity,
  type PreviewParcelDraft,
  type PreviewSelectionDraft,
  type PreviewSelections,
} from "@/lib/customer-return-preview";

export const previewSelectClass =
  "flex min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const reasons: { value: CustomerReturnFlowReason; label: string }[] = [
  { value: "no_longer_needed", label: "No longer needed" },
  { value: "ordered_by_mistake", label: "Ordered by mistake" },
  { value: "wrong_item", label: "Received the wrong item" },
  { value: "damaged", label: "Arrived damaged" },
  { value: "other", label: "Something else" },
];

export function PreviewError({ message }: { message: string | null }) {
  return message ? (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
    >
      {message}
    </div>
  ) : null;
}

export function PreviewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50/70 p-4 text-sm leading-relaxed text-slate-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-slate-200">
      <Info
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
      />
      <div>{children}</div>
    </div>
  );
}

export function PreviewPromises() {
  return (
    <div className="mt-8 grid gap-4 border-t pt-6 text-sm text-muted-foreground sm:grid-cols-2">
      <div className="flex items-start gap-3">
        <Truck aria-hidden="true" className="h-5 w-5 shrink-0" />
        <div>
          <p className="font-medium text-foreground">
            Free U.S. return shipping
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            One label for each return box.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0" />
        <div>
          <p className="font-medium text-foreground">
            Refunds reviewed after inspection
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            Our team handles approved refunds through Shopify.
          </p>
        </div>
      </div>
    </div>
  );
}

export function PreviewItems({
  order,
  drafts,
  onChange,
  onContinue,
  onBack,
}: {
  order: CustomerReturnFlowOrder;
  drafts: PreviewSelectionDraft[];
  onChange: (drafts: PreviewSelectionDraft[]) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const available = order.lines.some((line) => line.eligibleQuantity > 0);
  return (
    <div className="space-y-4">
      {order.message && <PreviewNote>{order.message}</PreviewNote>}
      {!order.lines.length && (
        <PreviewNote>
          There are no items available for return on this order.
        </PreviewNote>
      )}
      <div className="divide-y overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2 text-xs font-medium sm:px-4">
          <span>Items</span>
          <span className="text-muted-foreground">Quantity / available</span>
        </div>
        {order.lines.map((line, index) => {
          const description = describePreviewItem(order, line.id);
          const draft = drafts.find((item) => item.lineId === line.id)!;
          const selected = (readPreviewQuantity(draft.quantity) ?? 0) > 0;
          const disabled = line.eligibleQuantity === 0;
          const quantityId = `preview-quantity-${index}`;
          const reasonId = `preview-reason-${index}`;
          const helpId = `preview-line-help-${index}`;
          const availableId = `preview-line-available-${index}`;
          const messageId = `preview-line-message-${index}`;
          // The quantity denominator already shows ordinary availability. Keep
          // additional counts visible when they explain a restricted quantity.
          const showDetails =
            line.eligibleQuantity !== line.purchasedQuantity ||
            line.deliveredQuantity !== line.purchasedQuantity ||
            line.alreadyReturningQuantity !== 0 ||
            Boolean(line.message);
          return (
            <article
              key={line.id}
              data-testid={`preview-line-${line.id}`}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-x-3 gap-y-2 p-3 sm:grid-cols-[minmax(0,1fr)_11rem_6.5rem] sm:items-center sm:px-4 ${selected ? "bg-muted/20" : "bg-background"}`}
            >
              <div className="col-span-2 flex min-w-0 items-start gap-2.5 sm:col-span-1">
                <div
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
                >
                  <Package className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-medium leading-5">
                    {line.title}
                  </h3>
                  <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 break-words text-xs leading-4 text-muted-foreground">
                    <span className="min-w-0 break-words">
                      {description.context}
                    </span>
                    {line.sku && (
                      <span className="min-w-0 break-all text-[11px]">
                        {line.sku}
                      </span>
                    )}
                  </p>
                  <p
                    id={helpId}
                    className={
                      showDetails
                        ? "mt-1 text-xs leading-4 text-muted-foreground"
                        : "sr-only"
                    }
                  >
                    {line.purchasedQuantity} ordered · {line.deliveredQuantity}{" "}
                    confirmed delivered
                    {line.alreadyReturningQuantity !== null &&
                      line.alreadyReturningQuantity > 0 &&
                      ` · ${line.alreadyReturningQuantity} already in a return`}
                    {line.alreadyReturningQuantity === null && (
                      <span className="block">
                        Return history needs verification
                      </span>
                    )}
                  </p>
                  <p
                    id={availableId}
                    className={
                      disabled
                        ? "mt-1 text-xs font-medium text-muted-foreground"
                        : "sr-only"
                    }
                  >
                    {disabled
                      ? "Not available to return"
                      : `${line.eligibleQuantity} available to return`}
                  </p>
                  {line.message && (
                    <p
                      id={messageId}
                      className="mt-1 text-xs leading-4 text-muted-foreground"
                    >
                      {line.message}
                    </p>
                  )}
                </div>
              </div>
              <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1">
                <Label htmlFor={quantityId} className="sr-only">
                  Return quantity
                </Label>
                <div
                  className={`flex min-w-0 items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring ${disabled ? "opacity-50" : ""}`}
                >
                  <Input
                    id={quantityId}
                    aria-label={`Return quantity for ${description.accessibleName}`}
                    aria-describedby={`${availableId} ${helpId}${line.message ? ` ${messageId}` : ""}`}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={line.eligibleQuantity}
                    step="1"
                    className="h-11 min-w-0 flex-1 border-0 px-2 text-center tabular-nums shadow-none focus-visible:ring-0 sm:h-9"
                    value={draft.quantity}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(
                        drafts.map((item) =>
                          item.lineId === line.id
                            ? { ...item, quantity: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <span
                    aria-hidden="true"
                    className="max-w-[3rem] shrink-0 break-all py-1 pr-2 text-xs leading-4 tabular-nums text-muted-foreground"
                  >
                    / {line.eligibleQuantity}
                  </span>
                </div>
              </div>
              {selected && (
                <div className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1">
                  <Label htmlFor={reasonId} className="sr-only">
                    Reason (optional)
                  </Label>
                  <select
                    id={reasonId}
                    aria-label={`Reason for returning ${description.accessibleName} (optional)`}
                    className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9"
                    value={draft.reasonCode ?? ""}
                    title={
                      reasons.find((reason) => reason.value === draft.reasonCode)
                        ?.label ?? "Reason (optional)"
                    }
                    onChange={(event) =>
                      onChange(
                        drafts.map((item) =>
                          item.lineId === line.id
                            ? {
                                ...item,
                                reasonCode:
                                  reasons.find(
                                    (reason) =>
                                      reason.value === event.target.value,
                                  )?.value ?? null,
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="">Reason (optional)</option>
                    {reasons.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to order
        </Button>
        <Button className="min-h-11" disabled={!available} onClick={onContinue}>
          Continue to packing
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function PreviewPacking({
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
  function addBox() {
    const key = Math.max(0, ...parcels.map((parcel) => parcel.key)) + 1;
    onChange([
      ...parcels,
      {
        key,
        items: selections.map((item) => ({
          lineId: item.lineId,
          quantity: "0",
        })),
      },
    ]);
  }
  return (
    <div className="space-y-6">
      <PreviewNote>
        Items that arrived in separate shipments can go back together. Start
        with one box, or add another if you need more room.
      </PreviewNote>
      <div className="space-y-4">
        {parcels.map((parcel, index) => (
          <section
            key={parcel.key}
            data-testid={`preview-box-${index + 1}`}
            aria-labelledby={`preview-box-title-${parcel.key}`}
            className="min-w-0 rounded-xl border p-4 sm:p-5"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3
                id={`preview-box-title-${parcel.key}`}
                className="flex items-center gap-2 font-semibold"
              >
                <Package aria-hidden="true" className="h-5 w-5 text-primary" />
                Box {index + 1}
              </h3>
              {parcels.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove box ${index + 1}`}
                  className="min-h-11"
                  disabled={busy}
                  onClick={() =>
                    onChange(
                      parcels.filter(
                        (candidate) => candidate.key !== parcel.key,
                      ),
                    )
                  }
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
            <div className="space-y-4">
              {selections.map((selection, itemIndex) => {
                const line = order.lines.find(
                  (item) => item.id === selection.lineId,
                )!;
                const description = describePreviewItem(order, line.id);
                const quantityId = `preview-box-${parcel.key}-quantity-${itemIndex}`;
                return (
                  <div
                    key={line.id}
                    className="flex min-w-0 items-center gap-4"
                  >
                    <Label
                      htmlFor={quantityId}
                      className="min-w-0 flex-1 break-words font-normal leading-relaxed"
                    >
                      {line.title}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {description.context}
                      </span>
                    </Label>
                    <Input
                      id={quantityId}
                      aria-label={`Quantity of ${description.accessibleName} in box ${index + 1}`}
                      type="number"
                      min="0"
                      max={selection.quantity}
                      step="1"
                      inputMode="numeric"
                      className="min-h-11 w-20 shrink-0"
                      disabled={busy}
                      value={
                        parcel.items.find((item) => item.lineId === line.id)
                          ?.quantity ?? "0"
                      }
                      onChange={(event) =>
                        onChange(
                          parcels.map((candidate) =>
                            candidate.key === parcel.key
                              ? {
                                  ...candidate,
                                  items: candidate.items.map((item) =>
                                    item.lineId === line.id
                                      ? {
                                          ...item,
                                          quantity: event.target.value,
                                        }
                                      : item,
                                  ),
                                }
                              : candidate,
                          ),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <Button
        variant="outline"
        className="min-h-11 w-full border-dashed"
        disabled={busy || parcels.length >= MAX_RETURN_FLOW_PARCELS}
        onClick={addBox}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add another box
      </Button>
      <div className="space-y-2 rounded-xl bg-muted/60 p-4" aria-live="polite">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Packing checklist
        </p>
        {selections.map((selection) => {
          const line = order.lines.find(
            (item) => item.id === selection.lineId,
          )!;
          const description = describePreviewItem(order, line.id);
          const quantities = parcels.map((parcel) =>
            readPreviewQuantity(
              parcel.items.find((item) => item.lineId === line.id)?.quantity ??
                "0",
            ),
          );
          const total = quantities.some((quantity) => quantity === null)
            ? null
            : quantities.reduce<number>(
                (sum, quantity) => sum + (quantity ?? 0),
                0,
              );
          const matches = total === selection.quantity;
          return (
            <div
              key={selection.lineId}
              className="flex items-start gap-2 text-sm"
            >
              {matches ? (
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
              <span className="min-w-0 flex-1 break-words">
                {line.title}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {description.context}
                </span>
              </span>
              <span
                className={`shrink-0 text-xs leading-5 ${matches ? "text-emerald-700 dark:text-emerald-400" : "font-medium text-muted-foreground"}`}
              >
                {total === null || !Number.isSafeInteger(total)
                  ? "Check quantity"
                  : `${total} of ${selection.quantity} packed`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:justify-between">
        <Button variant="ghost" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to items
        </Button>
        <Button className="min-h-11" onClick={onContinue} disabled={busy}>
          {busy ? (
            <>
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin"
              />
              Checking your return…
            </>
          ) : (
            <>
              Review return
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export function PreviewReview({
  order,
  review,
  onBack,
}: {
  order: CustomerReturnFlowOrder;
  review: CustomerReturnFlowReview;
  onBack: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-muted/30 p-5">
        <p className="text-sm text-muted-foreground">Your return plan</p>
        <p className="mt-1 text-xl font-semibold">
          {review.selectedQuantity}{" "}
          {review.selectedQuantity === 1 ? "item" : "items"} ·{" "}
          {review.parcels.length}{" "}
          {review.parcels.length === 1 ? "box" : "boxes"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          A separate return label is needed for each box.
        </p>
      </div>
      <div className="space-y-4">
        {review.parcels.map((parcel) => (
          <section key={parcel.number} className="rounded-xl border p-5">
            <h3 className="mb-4 flex items-center gap-2 font-semibold">
              <Package aria-hidden="true" className="h-5 w-5 text-primary" />
              Box {parcel.number}
            </h3>
            <ul className="space-y-3">
              {parcel.items.map((item) => (
                <li
                  key={item.lineId}
                  className="flex items-start justify-between gap-4 text-sm"
                >
                  <span className="min-w-0 break-words">
                    {item.title}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {describePreviewItem(order, item.lineId).context}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    Qty {item.quantity}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="space-y-2 rounded-xl bg-muted/40 p-5">
        <h3 className="font-semibold">
          What happens after your return arrives?
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Our team inspects your items and reviews your refund. Any approved
          refund is issued through Shopify.
        </p>
      </div>
      <div className="space-y-3 border-t pt-6">
        <Button
          className="min-h-11 w-full"
          disabled
          aria-describedby="return-testing-status"
        >
          Get return labels
        </Button>
        <Button variant="ghost" className="min-h-11 w-full" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to packing
        </Button>
      </div>
    </div>
  );
}
