import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const variant = z.object({ id, sku: z.string().nullable(), name: z.string().nullable(), unitsPerVariant: id });
const receivePlan = z.object({
  productVariantId: id, unitsPerVariant: id, expectedQty: id, countsAsPieces: z.boolean(),
  preferredVariantId: id.nullable(), preferredUnitsPerVariant: id.nullable(),
});
export const shipmentReceiptResolutionSchema = z.object({
  shipmentId: id, shipmentNumber: z.string().nullable(), status: z.string().nullable(),
  purchaseOrderId: id, poNumber: z.string().nullable(), canCreateReceipt: z.boolean(),
  unresolvedCount: z.number().int().nonnegative(), lineCount: z.number().int().nonnegative(), issue: z.string().nullable(),
  lines: z.array(z.object({
    shipmentLineId: id.nullable(), purchaseOrderLineId: id.nullable(), sku: z.string().nullable(),
    productId: id.nullable(), productName: z.string().nullable(), qtyShipped: id.nullable(),
    cartonCount: id.nullable(), unitsPerCarton: z.number().nullable(), status: z.string(), blocking: z.boolean(),
    issue: z.string().nullable(), matchedVariant: variant.nullable(), activeVariants: z.array(variant),
    receivePlan: receivePlan.nullish(),
  })),
});
export type ShipmentReceiptPackResolution = z.infer<typeof shipmentReceiptResolutionSchema>;
export type ShipmentReceiptPackResolutionLine = ShipmentReceiptPackResolution["lines"][number];

export function parseShipmentReceiptResolution(value: unknown, expected: { shipmentId: number; purchaseOrderId: number }): ShipmentReceiptPackResolution {
  const result = shipmentReceiptResolutionSchema.safeParse(value);
  if (!result.success) throw new Error("The receive-unit check was incomplete. Refresh before creating the receipt.");
  const resolution = result.data;
  if (resolution.shipmentId !== expected.shipmentId || resolution.purchaseOrderId !== expected.purchaseOrderId) {
    throw new Error("The receive-unit check belongs to a different shipment or purchase order. Refresh before continuing.");
  }
  if (resolution.lineCount !== resolution.lines.length || resolution.canCreateReceipt && (resolution.lines.length === 0 || resolution.lines.some((line) => {
    const plan = line.receivePlan;
    return line.blocking || !plan || plan.productVariantId !== line.matchedVariant?.id ||
      plan.unitsPerVariant !== line.matchedVariant.unitsPerVariant || plan.countsAsPieces !== (plan.unitsPerVariant === 1) ||
      line.qtyShipped === null || BigInt(plan.expectedQty) * BigInt(plan.unitsPerVariant) !== BigInt(line.qtyShipped);
  }))) throw new Error("The receive-unit plan could not be verified against shipped pieces. Refresh before creating the receipt.");
  return resolution;
}

export function requiresReceiptUnitReview(resolution: ShipmentReceiptPackResolution): boolean {
  return !resolution.canCreateReceipt || resolution.lines.some((line) => line.receivePlan?.countsAsPieces && (line.receivePlan.preferredUnitsPerVariant ?? 1) > 1);
}


/** Unknown receipt coverage is distinct from a proven zero remaining quantity. */
export function shipmentReceiveCoverageLabel(option: { action?: string; receivable?: boolean; remainingBaseQty?: number | null; receivedBaseQty?: number | null; qtyShipped?: number | null }) {
  const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const known = valid(option.remainingBaseQty) && valid(option.receivedBaseQty);
  const fullyReceived = option.action !== "open_existing_receipt" && !option.receivable && known && option.remainingBaseQty === 0 && option.receivedBaseQty! > 0;
  const text = !known ? "Receipt coverage needs review"
    : option.remainingBaseQty! > 0
      ? option.remainingBaseQty!.toLocaleString("en-US") + (valid(option.qtyShipped) ? " of " + option.qtyShipped.toLocaleString("en-US") : "") + " pieces remaining"
      : valid(option.qtyShipped) ? option.qtyShipped.toLocaleString("en-US") + " shipped pieces" : "Shipped pieces unavailable";
  return { fullyReceived, text };
}
