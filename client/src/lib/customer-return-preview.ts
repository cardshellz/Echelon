import { z } from "zod";
import {
  customerReturnFlowReviewInputSchema,
  type CustomerReturnFlowOrder,
  type CustomerReturnFlowReason,
  type CustomerReturnFlowReview,
  type CustomerReturnFlowReviewInput,
} from "@shared/returns/customer-return-flow.contract";

export interface PreviewSelectionDraft {
  lineId: string;
  quantity: string;
  reasonCode: CustomerReturnFlowReason | null;
}
export interface PreviewParcelDraft {
  key: number;
  items: { lineId: string; quantity: string }[];
}
export type PreviewSelections = CustomerReturnFlowReviewInput["selections"];
export type PreviewValidation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function normalizedPreviewReference(value: string): string {
  return value.trim().replace(/^#\s*/, "").trim();
}

export function describePreviewItem(
  order: CustomerReturnFlowOrder,
  lineId: string,
): { context: string; accessibleName: string } {
  // Use the original order position, never the selected subset or parcel order.
  // Identical titles, variants and SKUs must remain distinguishable throughout.
  const index = order.lines.findIndex((line) => line.id === lineId);
  if (index < 0) {
    throw new Error("The item could not be identified. Find the order again.");
  }
  const line = order.lines[index];
  return {
    context: `Item ${index + 1}${line.variant ? ` · ${line.variant}` : ""}`,
    accessibleName: `item ${index + 1}: ${line.title}${line.variant ? ` (${line.variant})` : ""}`,
  };
}

export function initialPreviewSelections(
  order: CustomerReturnFlowOrder,
): PreviewSelectionDraft[] {
  return order.lines.map((line) => ({
    lineId: line.id,
    quantity: "0",
    reasonCode: null,
  }));
}

export function readPreviewQuantity(value: string): number | null {
  if (value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validatePreviewSelections(
  order: CustomerReturnFlowOrder,
  drafts: readonly PreviewSelectionDraft[],
): PreviewValidation<PreviewSelections> {
  const selections: PreviewSelections = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const line = order.lines.find((candidate) => candidate.id === draft.lineId);
    const quantity = readPreviewQuantity(draft.quantity);
    if (!line || seen.has(draft.lineId))
      return invalid("The item selection changed. Find the order again.");
    seen.add(draft.lineId);
    if (quantity === null)
      return invalid("Enter whole quantities of zero or more.");
    if (quantity > line.eligibleQuantity)
      return invalid(
        `Choose no more than ${line.eligibleQuantity} for ${line.title}.`,
      );
    if (quantity > 0)
      selections.push({
        lineId: line.id,
        quantity,
        reasonCode: draft.reasonCode,
      });
  }
  if (!selections.length)
    return invalid("Choose at least one available item to continue.");
  return { ok: true, value: selections };
}

export function samePreviewQuantities(
  left: readonly PreviewSelectionDraft[],
  right: readonly PreviewSelectionDraft[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((draft) => {
    const next = right.find((candidate) => candidate.lineId === draft.lineId);
    const previousQuantity = readPreviewQuantity(draft.quantity);
    return (
      previousQuantity !== null &&
      next !== undefined &&
      previousQuantity === readPreviewQuantity(next.quantity)
    );
  });
}

export function singlePreviewParcel(
  selections: PreviewSelections,
): PreviewParcelDraft[] {
  return [
    {
      key: 1,
      items: selections.map((item) => ({
        lineId: item.lineId,
        quantity: String(item.quantity),
      })),
    },
  ];
}

export function buildPreviewReviewInput(
  order: CustomerReturnFlowOrder,
  selections: PreviewSelections,
  parcels: readonly PreviewParcelDraft[],
): PreviewValidation<CustomerReturnFlowReviewInput> {
  const totals = new Map<string, number>();
  const parcelInputs: CustomerReturnFlowReviewInput["parcels"] = [];
  for (const [index, parcel] of parcels.entries()) {
    const items: CustomerReturnFlowReviewInput["parcels"][number]["items"] = [];
    const seen = new Set<string>();
    for (const item of parcel.items) {
      const quantity = readPreviewQuantity(item.quantity);
      if (quantity === null)
        return invalid(`Enter whole quantities in box ${index + 1}.`);
      if (
        !selections.some((selection) => selection.lineId === item.lineId) ||
        seen.has(item.lineId)
      ) {
        return invalid("The box contents changed. Select your items again.");
      }
      seen.add(item.lineId);
      if (quantity > 0) items.push({ lineId: item.lineId, quantity });
      const total = (totals.get(item.lineId) ?? 0) + quantity;
      if (!Number.isSafeInteger(total))
        return invalid("The box quantities are too large.");
      totals.set(item.lineId, total);
    }
    if (!items.length)
      return invalid(`Add an item to box ${index + 1}, or remove that box.`);
    parcelInputs.push({ items });
  }
  for (const selection of selections) {
    if ((totals.get(selection.lineId) ?? 0) !== selection.quantity) {
      const title =
        order.lines.find((line) => line.id === selection.lineId)?.title ??
        "this item";
      return invalid(
        `Assign exactly ${selection.quantity} of ${title} across your boxes.`,
      );
    }
  }
  const parsed = customerReturnFlowReviewInputSchema.safeParse({
    sourceRevision: order.sourceRevision,
    orderReference: order.orderReference,
    selections,
    parcels: parcelInputs,
  });
  if (!parsed.success)
    return invalid(
      "Check the selected items and box quantities, then try again.",
    );
  return { ok: true, value: parsed.data };
}

export function assertReturnFlowOrderMatches(
  order: CustomerReturnFlowOrder,
  reference: string,
): void {
  if (
    normalizedPreviewReference(order.orderReference) !==
      normalizedPreviewReference(reference) ||
    new Set(order.lines.map((line) => line.id)).size !== order.lines.length ||
    order.lines.some(
      (line) =>
        line.deliveredQuantity > line.purchasedQuantity ||
        (line.alreadyReturningQuantity === null
          ? line.eligibleQuantity !== 0
          : line.alreadyReturningQuantity > line.purchasedQuantity ||
            line.eligibleQuantity >
              Math.min(
                line.deliveredQuantity,
                line.purchasedQuantity - line.alreadyReturningQuantity,
              )),
    )
  ) {
    throw new Error(
      "The order response could not be verified. Please try again.",
    );
  }
}

export function assertPreviewReviewMatches(
  review: CustomerReturnFlowReview,
  input: CustomerReturnFlowReviewInput,
): void {
  const total = input.selections.reduce(
    (sum, selection) => sum + selection.quantity,
    0,
  );
  if (
    !Number.isSafeInteger(total) ||
    review.orderReference !== input.orderReference ||
    review.sourceRevision !== input.sourceRevision ||
    review.selectedQuantity !== total ||
    review.parcels.length !== input.parcels.length
  ) {
    throw new Error(
      "The review response did not match your selection. Please try again.",
    );
  }
  for (const [index, parcel] of review.parcels.entries()) {
    const expected = input.parcels[index];
    if (
      parcel.number !== index + 1 ||
      parcel.items.length !== expected.items.length ||
      new Set(parcel.items.map((item) => item.lineId)).size !==
        parcel.items.length ||
      parcel.items.some(
        (item) =>
          !expected.items.some(
            (candidate) =>
              candidate.lineId === item.lineId &&
              candidate.quantity === item.quantity,
          ),
      )
    ) {
      throw new Error(
        "The review response did not match your boxes. Please try again.",
      );
    }
  }
}

export class PreviewAccessError extends Error {}
export class ReturnSourceChangedError extends Error {}

export async function readPreviewResponse<T extends z.ZodTypeAny>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  if (response.status === 401 || response.status === 403)
    throw new PreviewAccessError(
      "Admin access is required. Sign in with an authorized admin account and try again.",
    );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({
          code: z.string().max(100).optional(),
          message: z.string().min(1).max(500),
        }),
      })
      .safeParse(body);
    if (
      response.status === 409 &&
      error.success &&
      error.data.error.code === "RETURN_LIVE_REVIEW_CHANGED"
    ) {
      throw new ReturnSourceChangedError(
        "Your order's return availability changed. Find the order again to review the current items and quantities.",
      );
    }
    throw new Error(
      error.success
        ? error.data.error.message
        : "The returns portal could not be loaded. Please try again.",
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      "The returns response could not be verified. Please try again.",
    );
  return parsed.data;
}

function invalid(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
