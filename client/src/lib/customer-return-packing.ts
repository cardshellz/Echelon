import {
  MAX_RETURN_FLOW_LINES,
  MAX_RETURN_FLOW_PARCELS,
  type CustomerReturnFlowOrder,
} from "@shared/returns/customer-return-flow.contract";
import {
  readPreviewQuantity,
  reconcilePreviewParcelSize,
  type PreviewParcelDraft,
} from "./customer-return-parcels";

type PackingSelections = readonly { lineId: string; quantity: number }[];
// Match the purchased-line identity bound in customer-return-flow.contract.ts.
const MAX_PACKING_LINE_ID_LENGTH = 255;

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

export interface PreviewPackingSource {
  lineId: string;
  fromParcelKey: number | null;
  quantity: number;
}

type PackingSources =
  | { ok: true; sources: PreviewPackingSource[] }
  | { ok: false };

/** Only proven, positive allocations can be offered as sources for another box. */
export function previewPackingSources(
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
  targetParcelKey: number,
): PackingSources {
  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    selections.length > MAX_RETURN_FLOW_LINES ||
    !Array.isArray(parcels) ||
    parcels.length === 0 ||
    parcels.length > MAX_RETURN_FLOW_PARCELS
  )
    return { ok: false };

  const allocations = new Map<
    string,
    { selected: number; packed: number; boxes: Map<number, number> }
  >();
  for (const selection of selections) {
    if (
      !selection ||
      typeof selection.lineId !== "string" ||
      selection.lineId.length === 0 ||
      selection.lineId.length > MAX_PACKING_LINE_ID_LENGTH ||
      allocations.has(selection.lineId) ||
      !Number.isSafeInteger(selection.quantity) ||
      selection.quantity <= 0
    )
      return { ok: false };
    allocations.set(selection.lineId, {
      selected: selection.quantity,
      packed: 0,
      boxes: new Map(),
    });
  }
  if (sumQuantities(selections.map((selection) => selection.quantity)) === null)
    return { ok: false };

  const parcelKeys = new Set<number>();
  for (const parcel of parcels) {
    if (
      !parcel ||
      !Number.isSafeInteger(parcel.key) ||
      parcel.key < 0 ||
      parcelKeys.has(parcel.key) ||
      !Array.isArray(parcel.items) ||
      parcel.items.length > MAX_RETURN_FLOW_LINES
    )
      return { ok: false };
    parcelKeys.add(parcel.key);
    const itemIds = new Set<string>();
    for (const item of parcel.items) {
      if (
        !item ||
        typeof item.quantity !== "string" ||
        itemIds.has(item.lineId)
      )
        return { ok: false };
      const allocation = allocations.get(item.lineId);
      const quantity = readPreviewQuantity(item.quantity);
      if (
        !allocation ||
        quantity === null ||
        quantity > allocation.selected - allocation.packed
      )
        return { ok: false };
      itemIds.add(item.lineId);
      allocation.packed += quantity;
      allocation.boxes.set(parcel.key, quantity);
    }
  }
  if (!parcelKeys.has(targetParcelKey)) return { ok: false };

  const sources: PreviewPackingSource[] = [];
  for (const [lineId, allocation] of allocations) {
    const unassigned = allocation.selected - allocation.packed;
    if (unassigned > 0)
      sources.push({ lineId, fromParcelKey: null, quantity: unassigned });
    for (const [fromParcelKey, quantity] of allocation.boxes) {
      if (fromParcelKey !== targetParcelKey && quantity > 0)
        sources.push({ lineId, fromParcelKey, quantity });
    }
  }
  return { ok: true, sources };
}

export interface PreviewPackingTransfer {
  lineId: string;
  fromParcelKey: number | null;
  toParcelKey: number;
  quantity: number;
}

type PackingTransferResult =
  | { kind: "updated"; parcels: PreviewParcelDraft[] }
  | { kind: "invalid_context" }
  | { kind: "invalid_quantity" };

/** Re-read current availability and update both allocations as one immutable edit. */
export function transferPreviewPackingQuantity(
  order: CustomerReturnFlowOrder,
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
  transfer: PreviewPackingTransfer,
): PackingTransferResult {
  if (!Number.isSafeInteger(transfer.quantity) || transfer.quantity <= 0)
    return { kind: "invalid_quantity" };
  const available = previewPackingSources(
    selections,
    parcels,
    transfer.toParcelKey,
  );
  if (
    !available.ok ||
    transfer.fromParcelKey === transfer.toParcelKey ||
    (transfer.fromParcelKey !== null &&
      !parcels.some((parcel) => parcel.key === transfer.fromParcelKey)) ||
    !selections.some((selection) => selection.lineId === transfer.lineId) ||
    new Set(order.lines.map((line) => line.id)).size !== order.lines.length ||
    selections.some(
      (selection) => !order.lines.some((line) => line.id === selection.lineId),
    )
  )
    return { kind: "invalid_context" };
  const source = available.sources.find(
    (candidate) =>
      candidate.lineId === transfer.lineId &&
      candidate.fromParcelKey === transfer.fromParcelKey,
  );
  if (!source || transfer.quantity > source.quantity)
    return { kind: "invalid_quantity" };

  return {
    kind: "updated",
    parcels: parcels.map((parcel) => {
      if (
        parcel.key !== transfer.toParcelKey &&
        parcel.key !== transfer.fromParcelKey
      )
        return parcel;
      // The complete plan was validated above, including missing entries as zero.
      // Moving an existing allocation (or unassigned remainder) keeps the target
      // at or below the validated safe selected quantity, so addition cannot overflow.
      const current = quantityInBox(parcel, transfer.lineId)!;
      const quantity = String(
        parcel.key === transfer.toParcelKey
          ? current + transfer.quantity
          : current - transfer.quantity,
      );
      const hasItem = parcel.items.some(
        (item) => item.lineId === transfer.lineId,
      );
      const items = hasItem
        ? parcel.items.map((item) =>
            item.lineId === transfer.lineId ? { ...item, quantity } : item,
          )
        : [...parcel.items, { lineId: transfer.lineId, quantity }];
      return reconcilePreviewParcelSize(order, { ...parcel, items });
    }),
  };
}

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
    variant,
  ];
  return parts.filter(Boolean).join(" · ") || null;
}
