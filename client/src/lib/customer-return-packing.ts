import {
  MAX_RETURN_FLOW_LINES,
  MAX_RETURN_FLOW_PARCELS,
  type CustomerReturnFlowOrder,
} from "@shared/returns/customer-return-flow.contract";
import {
  initialPreviewParcelSize,
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

export type PreviewPackingAllocationsResult =
  | { ok: true; sources: PreviewPackingSource[] }
  | { ok: false };

interface PackingAllocation {
  selected: number;
  packed: number;
  boxes: Map<number, number>;
}

interface ValidPackingPlan {
  allocations: Map<string, PackingAllocation>;
  parcelKeys: Set<number>;
  selectedQuantity: number;
}

/** Validate once before deriving available pools or preparing an atomic move. */
function readPackingPlan(
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
): ValidPackingPlan | null {
  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    selections.length > MAX_RETURN_FLOW_LINES ||
    !Array.isArray(parcels) ||
    parcels.length === 0 ||
    parcels.length > MAX_RETURN_FLOW_PARCELS
  )
    return null;

  const allocations = new Map<string, PackingAllocation>();
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
      return null;
    allocations.set(selection.lineId, {
      selected: selection.quantity,
      packed: 0,
      boxes: new Map(),
    });
  }
  const selectedQuantity = sumQuantities(
    selections.map((selection) => selection.quantity),
  );
  if (selectedQuantity === null) return null;

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
      return null;
    parcelKeys.add(parcel.key);
    const itemIds = new Set<string>();
    for (const item of parcel.items) {
      if (
        !item ||
        typeof item.quantity !== "string" ||
        itemIds.has(item.lineId)
      )
        return null;
      const allocation = allocations.get(item.lineId);
      const quantity = readPreviewQuantity(item.quantity);
      if (
        !allocation ||
        quantity === null ||
        quantity > allocation.selected - allocation.packed
      )
        return null;
      itemIds.add(item.lineId);
      allocation.packed += quantity;
      allocation.boxes.set(parcel.key, quantity);
    }
  }
  return { allocations, parcelKeys, selectedQuantity };
}

function packingSources(plan: ValidPackingPlan): PreviewPackingSource[] {
  const sources: PreviewPackingSource[] = [];
  for (const [lineId, allocation] of plan.allocations) {
    const unassigned = allocation.selected - allocation.packed;
    if (unassigned > 0)
      sources.push({ lineId, fromParcelKey: null, quantity: unassigned });
    for (const [fromParcelKey, quantity] of allocation.boxes) {
      if (quantity > 0) sources.push({ lineId, fromParcelKey, quantity });
    }
  }
  return sources;
}

/** All positive pools, including selected units not yet assigned to a box. */
export function previewPackingAllocations(
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
): PreviewPackingAllocationsResult {
  const plan = readPackingPlan(selections, parcels);
  return plan ? { ok: true, sources: packingSources(plan) } : { ok: false };
}

export interface PreviewPackingMoveItem {
  lineId: string;
  fromParcelKey: number | null;
  quantity: number;
}

export type PreviewPackingMoveDestination =
  | { kind: "existing"; parcelKey: number }
  | { kind: "new" };

export interface PreviewPackingMoveCommand {
  items: readonly PreviewPackingMoveItem[];
  destination: PreviewPackingMoveDestination;
}

export type PreviewPackingMoveResult =
  | {
      kind: "updated";
      parcels: PreviewParcelDraft[];
      destinationParcelKey: number;
      removedParcelKeys: number[];
    }
  | { kind: "invalid_context" }
  | { kind: "invalid_quantity" }
  | { kind: "box_limit" }
  | { kind: "unchanged" };

// At most one entry for each purchased line in each box and its unassigned pool.
const MAX_PACKING_MOVE_ITEMS =
  MAX_RETURN_FLOW_LINES * (MAX_RETURN_FLOW_PARCELS + 1);

function unusedParcelKey(parcelKeys: ReadonlySet<number>): number {
  // There are at most 20 existing keys. Finding a free positive key is bounded
  // and cannot overflow even if an existing key is Number.MAX_SAFE_INTEGER.
  let key = 1;
  while (parcelKeys.has(key)) key += 1;
  return key;
}

/** Pure preview/commit: either the complete move succeeds or no plan is returned. */
export function movePreviewPackingItems(
  order: CustomerReturnFlowOrder,
  selections: PackingSelections,
  parcels: readonly PreviewParcelDraft[],
  command: PreviewPackingMoveCommand,
): PreviewPackingMoveResult {
  const plan = readPackingPlan(selections, parcels);
  if (
    !plan ||
    !command ||
    !Array.isArray(command.items) ||
    command.items.length > MAX_PACKING_MOVE_ITEMS ||
    !command.destination ||
    !["existing", "new"].includes(command.destination.kind) ||
    new Set(order.lines.map((line) => line.id)).size !== order.lines.length ||
    selections.some(
      (selection) => !order.lines.some((line) => line.id === selection.lineId),
    )
  )
    return { kind: "invalid_context" };
  if (command.items.length === 0) return { kind: "invalid_quantity" };

  const isNew = command.destination.kind === "new";
  const destinationParcelKey =
    command.destination.kind === "existing"
      ? command.destination.parcelKey
      : unusedParcelKey(plan.parcelKeys);
  if (!isNew && !plan.parcelKeys.has(destinationParcelKey))
    return { kind: "invalid_context" };

  const credits = new Map<string, number>();
  const debits = new Map<number, Map<string, number>>();
  const seen = new Set<string>();
  let hasUnassigned = false;
  for (const item of command.items) {
    if (!item) return { kind: "invalid_context" };
    const allocation = plan.allocations.get(item.lineId);
    if (
      !allocation ||
      item.fromParcelKey === destinationParcelKey ||
      (item.fromParcelKey !== null && !plan.parcelKeys.has(item.fromParcelKey))
    )
      return { kind: "invalid_context" };
    const sourceKey = JSON.stringify([item.fromParcelKey, item.lineId]);
    if (seen.has(sourceKey)) return { kind: "invalid_context" };
    seen.add(sourceKey);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)
      return { kind: "invalid_quantity" };
    const available =
      item.fromParcelKey === null
        ? allocation.selected - allocation.packed
        : (allocation.boxes.get(item.fromParcelKey) ?? 0);
    if (item.quantity > available) return { kind: "invalid_quantity" };
    const incoming = sumQuantities([
      credits.get(item.lineId) ?? 0,
      item.quantity,
    ]);
    if (incoming === null) return { kind: "invalid_quantity" };
    credits.set(item.lineId, incoming);
    if (item.fromParcelKey === null) {
      hasUnassigned = true;
    } else {
      const fromBox =
        debits.get(item.fromParcelKey) ?? new Map<string, number>();
      fromBox.set(item.lineId, item.quantity);
      debits.set(item.fromParcelKey, fromBox);
    }
  }

  const changedItems = new Map<number, PreviewParcelDraft["items"]>();
  const removedParcelKeys: number[] = [];
  for (const parcel of parcels) {
    if (parcel.key !== destinationParcelKey && !debits.has(parcel.key))
      continue;
    // Canonical purchased-line ordering also makes the result independent of
    // command item order. Each final quantity is bounded by its selected total.
    const items = selections.flatMap(({ lineId }) => {
      const allocation = plan.allocations.get(lineId)!;
      const current = allocation.boxes.get(parcel.key) ?? 0;
      const outgoing = debits.get(parcel.key)?.get(lineId) ?? 0;
      const incoming =
        parcel.key === destinationParcelKey ? (credits.get(lineId) ?? 0) : 0;
      const quantity = current - outgoing + incoming;
      return quantity > 0 ? [{ lineId, quantity: String(quantity) }] : [];
    });
    if (debits.has(parcel.key) && items.length === 0)
      removedParcelKeys.push(parcel.key);
    else changedItems.set(parcel.key, items);
  }

  // Replacing the identity of one completely emptied donor does not split or
  // combine any contents. Keep that box and let the customer change its size.
  if (
    isNew &&
    !hasUnassigned &&
    debits.size === 1 &&
    removedParcelKeys.length === 1
  )
    return { kind: "unchanged" };
  const finalCount =
    parcels.length - removedParcelKeys.length + (isNew ? 1 : 0);
  if (finalCount > Math.min(MAX_RETURN_FLOW_PARCELS, plan.selectedQuantity))
    return { kind: "box_limit" };

  const removed = new Set(removedParcelKeys);
  const nextParcels = parcels.flatMap((parcel) => {
    if (removed.has(parcel.key)) return [];
    const items = changedItems.get(parcel.key);
    // Reconcile once, using final contents rather than intermediate transfers.
    return [
      items ? reconcilePreviewParcelSize(order, { ...parcel, items }) : parcel,
    ];
  });
  if (isNew) {
    const items = selections.flatMap(({ lineId }) => {
      const quantity = credits.get(lineId) ?? 0;
      return quantity > 0 ? [{ lineId, quantity: String(quantity) }] : [];
    });
    nextParcels.push({
      key: destinationParcelKey,
      items,
      size: initialPreviewParcelSize(order, items),
    });
  }
  return {
    kind: "updated",
    parcels: nextParcels,
    destinationParcelKey,
    removedParcelKeys,
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
