import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  calculateCustomerReturnProductWeight,
  customerReturnDimensionsSchema,
  type CustomerReturnDimensions,
} from "@shared/returns/customer-return-parcel";
import {
  dimensionInputToMm,
  formatDimensionInches,
} from "@shared/shipping/dimensions";

export type PreviewParcelSize =
  | { kind: "unselected" }
  | { kind: "original"; originalBoxId: string; automatic: boolean }
  | {
      kind: "custom";
      lengthInches: string;
      widthInches: string;
      heightInches: string;
      originalDimensions: CustomerReturnDimensions | null;
    };

export interface PreviewParcelDraft {
  key: number;
  items: { lineId: string; quantity: string }[];
  size: PreviewParcelSize;
}

export function readPreviewQuantity(value: string): number | null {
  if (value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function customPreviewParcelSize(
  dimensions: CustomerReturnDimensions | null = null,
): Extract<PreviewParcelSize, { kind: "custom" }> {
  return {
    kind: "custom",
    lengthInches: formatDimensionInches(dimensions?.lengthMm),
    widthInches: formatDimensionInches(dimensions?.widthMm),
    heightInches: formatDimensionInches(dimensions?.heightMm),
    originalDimensions: dimensions,
  };
}

export function originalBoxCoversItems(
  option: CustomerReturnFlowOrder["boxOptions"][number],
  items: readonly { lineId: string; quantity: string }[],
): boolean {
  let hasItems = false;
  for (const item of items) {
    const quantity = readPreviewQuantity(item.quantity);
    if (quantity === null) return false;
    if (quantity === 0) continue;
    hasItems = true;
    const source = option.items.find((entry) => entry.lineId === item.lineId);
    if (!source || quantity > source.quantity) return false;
  }
  return hasItems;
}

export function initialPreviewParcelSize(
  order: CustomerReturnFlowOrder,
  items: PreviewParcelDraft["items"],
): PreviewParcelSize {
  const candidates = order.boxOptions.filter((option) =>
    originalBoxCoversItems(option, items),
  );
  if (candidates.length === 1) {
    return {
      kind: "original",
      originalBoxId: candidates[0].id,
      automatic: true,
    };
  }
  return order.boxOptions.length
    ? { kind: "unselected" }
    : customPreviewParcelSize();
}

/** Suggest only a unique covering size; never replace a customer's deliberate choice. */
export function reconcilePreviewParcelSize(
  order: CustomerReturnFlowOrder,
  parcel: PreviewParcelDraft,
): PreviewParcelDraft {
  if (parcel.size.kind === "unselected") {
    const suggested = initialPreviewParcelSize(order, parcel.items);
    return suggested.kind === "original"
      ? { ...parcel, size: suggested }
      : parcel;
  }
  if (parcel.size.kind !== "original" || !parcel.size.automatic) return parcel;
  const boxId = parcel.size.originalBoxId;
  const source = order.boxOptions.find((option) => option.id === boxId);
  if (source && originalBoxCoversItems(source, parcel.items)) return parcel;
  return {
    ...parcel,
    size: order.boxOptions.length
      ? { kind: "unselected" }
      : customPreviewParcelSize(),
  };
}

export function readPreviewParcelDimensions(
  order: CustomerReturnFlowOrder,
  parcel: PreviewParcelDraft,
): { dimensions: CustomerReturnDimensions; originalBoxId: string | null } {
  if (parcel.size.kind === "unselected")
    throw new Error("Choose a box size or enter your box dimensions.");
  if (parcel.size.kind === "original") {
    const boxId = parcel.size.originalBoxId;
    const source = order.boxOptions.find((option) => option.id === boxId);
    if (
      !source ||
      (parcel.size.automatic && !originalBoxCoversItems(source, parcel.items))
    ) {
      throw new Error(
        "The original box size could not be verified. Choose your box size again.",
      );
    }
    return {
      dimensions: customerReturnDimensionsSchema.parse(source.dimensions),
      originalBoxId: source.id,
    };
  }
  const { size } = parcel;
  const dimensions = {
    lengthMm: dimensionInputToMm(
      size.lengthInches,
      "Length",
      size.originalDimensions?.lengthMm,
    ),
    widthMm: dimensionInputToMm(
      size.widthInches,
      "Width",
      size.originalDimensions?.widthMm,
    ),
    heightMm: dimensionInputToMm(
      size.heightInches,
      "Height",
      size.originalDimensions?.heightMm,
    ),
  };
  if (Object.values(dimensions).some((value) => value === null)) {
    throw new Error(
      "Enter the length, width, and height of your box in inches.",
    );
  }
  return {
    dimensions: customerReturnDimensionsSchema.parse(dimensions),
    originalBoxId: null,
  };
}

export type PreviewParcelWeight =
  | { status: "empty" | "invalid" | "unverified"; weightGrams: null }
  | { status: "ready"; weightGrams: number };

export function previewParcelProductWeight(
  order: CustomerReturnFlowOrder,
  parcel: Pick<PreviewParcelDraft, "items">,
): PreviewParcelWeight {
  const items: {
    quantity: number;
    unitWeightGrams: number | null | undefined;
  }[] = [];
  const seen = new Set<string>();
  for (const item of parcel.items) {
    const quantity = readPreviewQuantity(item.quantity);
    const line = order.lines.find((entry) => entry.id === item.lineId);
    if (quantity === null || !line || seen.has(item.lineId))
      return { status: "invalid", weightGrams: null };
    seen.add(item.lineId);
    if (quantity > 0)
      items.push({ quantity, unitWeightGrams: line.unitWeightGrams });
  }
  if (!items.length) return { status: "empty", weightGrams: null };
  const weightGrams = calculateCustomerReturnProductWeight(items);
  return weightGrams === null
    ? { status: "unverified", weightGrams: null }
    : { status: "ready", weightGrams };
}

export function formatPreviewDimensions(
  dimensions: CustomerReturnDimensions,
): string {
  return `${formatDimensionInches(dimensions.lengthMm)} × ${formatDimensionInches(dimensions.widthMm)} × ${formatDimensionInches(dimensions.heightMm)} in`;
}
