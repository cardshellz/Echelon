import {
  MAX_RETURN_FLOW_PARCELS,
  type CustomerReturnFlowOrder,
} from "@shared/returns/customer-return-flow.contract";
import {
  readPreviewQuantity,
  reconcilePreviewParcelSize,
  type PreviewParcelDraft,
} from "./customer-return-parcels";

type PackingSelections = readonly { lineId: string; quantity: number }[];

function sumQuantities(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (
      value === null ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - total
    )
      return null;
    total += value;
  }
  return total;
}

function quantityInBox(
  parcel: PreviewParcelDraft,
  lineId: string,
): number | null {
  const items = parcel.items.filter((item) => item.lineId === lineId);
  return items.length > 1
    ? null
    : readPreviewQuantity(items[0]?.quantity ?? "0");
}

/** Count selected purchased units, not product options or original order ordinals. */
export function summarizePreviewPacking(
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
) {
  const selectedIds = new Set(selections.map((item) => item.lineId));
  const validSelections =
    selections.length > 0 &&
    selectedIds.size === selections.length &&
    selections.every(
      (item) => Number.isSafeInteger(item.quantity) && item.quantity > 0,
    );
  const selectedQuantity = validSelections
    ? sumQuantities(selections.map((item) => item.quantity))
    : null;
  const lines = selections.map((selection) => ({
    lineId: selection.lineId,
    selectedQuantity: selection.quantity,
    packedQuantity: sumQuantities(
      parcels.map((parcel) => quantityInBox(parcel, selection.lineId)),
    ),
  }));
  const validContents =
    new Set(parcels.map((parcel) => parcel.key)).size === parcels.length &&
    parcels.every(
      (parcel) =>
        new Set(parcel.items.map((item) => item.lineId)).size ===
          parcel.items.length &&
        parcel.items.every(
          (item) =>
            selectedIds.has(item.lineId) &&
            readPreviewQuantity(item.quantity) !== null,
        ),
    );
  const packedQuantity = validContents
    ? sumQuantities(lines.map((line) => line.packedQuantity))
    : null;
  const emptyBoxNumbers = parcels.flatMap((parcel, index) =>
    sumQuantities(
      parcel.items.map((item) => readPreviewQuantity(item.quantity)),
    ) === 0
      ? [index + 1]
      : [],
  );
  const maximumBoxes = Math.min(MAX_RETURN_FLOW_PARCELS, selectedQuantity ?? 0);
  const quantitiesMatch =
    validSelections &&
    validContents &&
    packedQuantity !== null &&
    lines.every((line) => line.packedQuantity === line.selectedQuantity);
  return {
    lines,
    selectedQuantity,
    packedQuantity,
    emptyBoxNumbers,
    maximumBoxes,
    canAddBox: maximumBoxes > parcels.length,
    ready:
      quantitiesMatch &&
      parcels.length > 0 &&
      parcels.length <= maximumBoxes &&
      emptyBoxNumbers.length === 0,
  };
}

export type PreviewPackingSummary = ReturnType<typeof summarizePreviewPacking>;

/** A unit already assigned to another box cannot be assigned a second time. */
export function previewParcelQuantityLimit(
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
  parcelKey: number,
  lineId: string,
): number | null {
  const matches = selections.filter((item) => item.lineId === lineId);
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0].quantity) ||
    matches[0].quantity <= 0 ||
    parcels.filter((parcel) => parcel.key === parcelKey).length !== 1
  )
    return null;
  const elsewhere = sumQuantities(
    parcels
      .filter((parcel) => parcel.key !== parcelKey)
      .map((parcel) => quantityInBox(parcel, lineId)),
  );
  return elsewhere === null
    ? null
    : Math.max(0, matches[0].quantity - elsewhere);
}

type QuantityEdit =
  | { kind: "updated"; parcels: PreviewParcelDraft[] }
  | { kind: "already_assigned"; maximum: number }
  | { kind: "invalid_context" };

export function changePreviewPackingQuantity(
  order: CustomerReturnFlowOrder,
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
  parcelKey: number,
  lineId: string,
  raw: string,
): QuantityEdit {
  const target = parcels.filter((parcel) => parcel.key === parcelKey);
  if (
    target.length !== 1 ||
    target[0].items.filter((item) => item.lineId === lineId).length !== 1 ||
    !selections.some((item) => item.lineId === lineId) ||
    !order.lines.some((line) => line.id === lineId)
  ) {
    return { kind: "invalid_context" };
  }
  const quantity = readPreviewQuantity(raw);
  const maximum = previewParcelQuantityLimit(
    selections,
    parcels,
    parcelKey,
    lineId,
  );
  // Keep invalid drafts visible for correction; zero always lets the customer
  // clear an allocation even if another box currently contains invalid input.
  if (quantity !== null && quantity > 0) {
    if (maximum === null) return { kind: "invalid_context" };
    if (quantity > maximum) return { kind: "already_assigned", maximum };
  }
  return {
    kind: "updated",
    parcels: parcels.map((parcel) =>
      parcel.key !== parcelKey
        ? parcel
        : reconcilePreviewParcelSize(order, {
            ...parcel,
            items: parcel.items.map((item) =>
              item.lineId === lineId ? { ...item, quantity: raw } : item,
            ),
          }),
    ),
  };
}

export function previewPackingItemContext(
  order: CustomerReturnFlowOrder,
  lineId: string,
): string | null {
  const index = order.lines.findIndex((line) => line.id === lineId);
  if (index < 0)
    throw new Error("The item could not be identified. Find the order again.");
  const line = order.lines[index];
  const variant = line.variant || null;
  const sameDisplay = order.lines.filter(
    (candidate) =>
      candidate.title === line.title && (candidate.variant || null) === variant,
  );
  const parts = [
    sameDisplay.length > 1 ? `Order item ${index + 1}` : null,
    variant ? `Option: ${variant}` : null,
  ];
  return parts.filter(Boolean).join(" · ") || null;
}
