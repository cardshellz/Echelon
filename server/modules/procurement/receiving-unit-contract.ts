import { createHash } from "node:crypto";
import { convertUnitQuantity, UnitQuantityError } from "@shared/procurement/unit-quantity";
import { canonicalJson } from "@shared/utils/canonical-json";

export const MAX_RECEIVING_QUANTITY = 2_147_483_647;

export class ReceivingUnitError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly details: Record<string, unknown>) {
    super(message);
    this.name = "ReceivingUnitError";
  }
}

export function receiptInteger(value: unknown, field: string, positive = false): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < (positive ? 1 : 0) || value > MAX_RECEIVING_QUANTITY) {
    throw new ReceivingUnitError(`${field} must be a ${positive ? "positive" : "nonnegative"} whole number within the supported quantity range.`, 400, {
      code: "INVALID_RECEIVING_UNIT_QUANTITY", field,
    });
  }
  return value;
}

export interface ReceiptVariant {
  id: number;
  productId: number;
  unitsPerVariant: number;
  isActive?: boolean | null;
  sku?: string | null;
  name?: string | null;
}

export interface ReceiptUnitPlan {
  productVariantId: number;
  unitsPerVariant: number;
  expectedQty: number;
  countsAsPieces: boolean;
  preferredVariantId: number | null;
  preferredUnitsPerVariant: number | null;
  selectedVariantSku?: string | null;
}

/** Cartons describe packing, not the contents of each carton. A nondivisible
 * piece total is counted entirely in a real piece variant; do not invent a
 * pack factor or assert an unobserved distribution of full and loose packs.
 */
export function planReceiptUnits(input: {
  baseQty: number;
  productId: number;
  preferredVariantId: number | null;
  recordedPreferredUnits?: number | null;
  variants: readonly ReceiptVariant[];
  selection?: { productVariantId: number; unitsPerVariant: number };
  requireConfiguredUnit?: boolean;
}): ReceiptUnitPlan {
  const baseQty = receiptInteger(input.baseQty, "Expected pieces", true);
  receiptInteger(input.productId, "Product ID", true);
  const variants = input.variants.filter((variant) => variant.productId === input.productId && variant.isActive !== false);
  const preferred = input.preferredVariantId === null ? null : variants.find((variant) => variant.id === input.preferredVariantId);
  if (input.selection) {
    receiptInteger(input.selection.productVariantId, "Selected receive variant", true);
    receiptInteger(input.selection.unitsPerVariant, "Reviewed pieces per receiving unit", true);
    const selected = variants.find(variant => variant.id === input.selection!.productVariantId);
    if (!selected) throw new ReceivingUnitError("The chosen receiving unit is inactive, missing, or belongs to another product. Choose an active unit for this product.", 409,
      { code: "RECEIVING_VARIANT_REVIEW_REQUIRED", productId: input.productId, productVariantId: input.selection.productVariantId });
    const units = receiptInteger(selected.unitsPerVariant, "Pieces per receiving unit", true);
    if (units !== input.selection.unitsPerVariant) throw new ReceivingUnitError("The chosen unit's pack size changed. Refresh and review its current piece count.", 409,
      { code: "RECEIVING_UNIT_SOURCE_CHANGED", productId: input.productId, productVariantId: selected.id });
    if (baseQty % units !== 0) throw new ReceivingUnitError("The chosen receiving unit cannot represent these pieces as a whole count. Choose a smaller pack or a piece unit.", 409,
      { code: "RECEIVING_UNIT_SELECTION_INEXACT", productId: input.productId, productVariantId: selected.id, expectedBaseQty: baseQty });
    return { productVariantId: selected.id, unitsPerVariant: units, expectedQty: baseQty / units,
      countsAsPieces: units === 1, preferredVariantId: preferred?.id ?? null,
      preferredUnitsPerVariant: preferred?.unitsPerVariant ?? null, selectedVariantSku: selected.sku ?? null };
  }
  if (input.preferredVariantId !== null && !preferred) {
    throw new ReceivingUnitError("The recorded receive variant is missing, inactive, or belongs to another product. Review the product receive configuration.", 409, {
      code: "RECEIVING_VARIANT_REVIEW_REQUIRED", productId: input.productId, productVariantId: input.preferredVariantId,
    });
  }
  // Legacy PO-direct callers retain their piece fallback. A shipment's setup
  // screen must ask which configuration arrived, even when a piece SKU exists.
  if (input.requireConfiguredUnit && !preferred) {
    throw new ReceivingUnitError(variants.length
      ? "Choose the product configuration that actually arrived. No receiving configuration was saved on this shipment or purchase line."
      : "This product has no active receiving configuration. Add its actual configuration before creating the receipt.", 409,
    { code: variants.length ? "RECEIVING_VARIANT_SELECTION_REQUIRED" : "RECEIVING_VARIANT_REQUIRED", productId: input.productId });
  }
  const preferredUnits = preferred ? receiptInteger(preferred.unitsPerVariant, "Receive pack size", true) : null;
  if (preferredUnits !== null && input.recordedPreferredUnits != null && receiptInteger(input.recordedPreferredUnits, "Recorded receive pack size", true) !== preferredUnits) {
    throw new ReceivingUnitError("The catalog pack size differs from the purchase's recorded receive pack. Review the source configuration before creating the receipt.", 409, {
      code: "RECEIVING_UNIT_SOURCE_CHANGED", productId: input.productId, productVariantId: input.preferredVariantId,
    });
  }
  const selected = preferred && preferredUnits !== null && baseQty % preferredUnits === 0
    ? preferred
    : [...variants].filter((variant) => variant.unitsPerVariant === 1).sort((a, b) => a.id - b.id)[0];
  if (!selected) {
    if (!variants.length) throw new ReceivingUnitError("This product has no active receiving unit. Set up a unit in the product catalog, then return to this receipt.", 409,
      { code: "RECEIVING_VARIANT_REQUIRED", productId: input.productId, expectedBaseQty: baseQty });
    if (!preferred || variants.some(variant => Number.isInteger(variant.unitsPerVariant) && variant.unitsPerVariant > 0 && baseQty % variant.unitsPerVariant === 0)) {
      throw new ReceivingUnitError("Choose how to count this product when receiving. Existing packs can be used when their count represents the remaining pieces exactly.", 409,
        { code: "RECEIVING_VARIANT_SELECTION_REQUIRED", productId: input.productId, expectedBaseQty: baseQty });
    }
    throw new ReceivingUnitError("No active configuration can represent these pieces as a whole count. Add the configuration that actually arrived, or a piece unit if the goods will be counted individually.", 409, {
      code: "RECEIVING_PIECE_VARIANT_REQUIRED", productId: input.productId, expectedBaseQty: baseQty,
    });
  }
  receiptInteger(selected.id, "Receive variant ID", true);
  const units = receiptInteger(selected.unitsPerVariant, "Receive pack size", true);
  return {
    productVariantId: selected.id,
    unitsPerVariant: units,
    expectedQty: baseQty / units,
    countsAsPieces: units === 1,
    preferredVariantId: preferred?.id ?? null,
    preferredUnitsPerVariant: preferredUnits,
  };
}

export interface ReceiptUnitLine {
  id: number;
  productVariantId?: number | null;
  productId?: number | null;
  receivingOrderId?: number;
  purchaseOrderLineId?: number | null;
  inboundShipmentLineId?: number | null;
  unitsPerVariantSnapshot?: number | null;
  expectedQty: number;
  receivedQty: number;
  damagedQty: number;
  updatedAt?: Date | string;
}

export function receivingUnitVersion(line: ReceiptUnitLine): string {
  return createHash("sha256").update(canonicalJson({
    id: line.id, receivingOrderId: line.receivingOrderId ?? null,
    productVariantId: line.productVariantId ?? null, productId: line.productId ?? null,
    purchaseOrderLineId: line.purchaseOrderLineId ?? null, inboundShipmentLineId: line.inboundShipmentLineId ?? null,
    unitsPerVariantSnapshot: line.unitsPerVariantSnapshot ?? null,
    expectedQty: line.expectedQty, receivedQty: line.receivedQty, damagedQty: line.damagedQty,
    updatedAt: line.updatedAt ?? null,
  })).digest("hex");
}

export function withReceivingUnitVersion<T extends ReceiptUnitLine>(line: T): T & { unitVersion: string } {
  return { ...line, unitVersion: receivingUnitVersion(line) };
}

export function convertReceiptCounts(line: Pick<ReceiptUnitLine, "expectedQty" | "receivedQty" | "damagedQty">, oldUnits: number, newUnits: number): Pick<ReceiptUnitLine, "expectedQty" | "receivedQty" | "damagedQty"> {
  receiptInteger(oldUnits, "Recorded receive pack size", true);
  receiptInteger(newUnits, "Selected receive pack size", true);
  const result = { expectedQty: 0, receivedQty: 0, damagedQty: 0 };
  for (const field of ["expectedQty", "receivedQty", "damagedQty"] as const) {
    try {
      result[field] = convertUnitQuantity(receiptInteger(line[field], field), oldUnits, newUnits);
    } catch (error) {
      if (!(error instanceof UnitQuantityError)) throw error;
      if (error.code === "UNIT_QUANTITY_INEXACT") throw new ReceivingUnitError(
        `The selected pack cannot represent ${field} exactly. Select a piece variant or a pack that preserves the recorded pieces.`, 409,
        { code: "RECEIVING_UNIT_CONVERSION_INEXACT", field });
      throw new ReceivingUnitError("The converted receipt count exceeds the supported quantity range.", 409,
        { code: "RECEIVING_UNIT_CONVERSION_OVERFLOW", field });
    }
  }
  return result;
}
