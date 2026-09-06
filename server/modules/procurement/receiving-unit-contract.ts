import { createHash } from "node:crypto";
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
}): ReceiptUnitPlan {
  const baseQty = receiptInteger(input.baseQty, "Expected pieces", true);
  receiptInteger(input.productId, "Product ID", true);
  const variants = input.variants.filter((variant) => variant.productId === input.productId && variant.isActive !== false);
  const preferred = input.preferredVariantId === null ? null : variants.find((variant) => variant.id === input.preferredVariantId);
  if (input.preferredVariantId !== null && !preferred) {
    throw new ReceivingUnitError("The recorded receive variant is missing, inactive, or belongs to another product. Review the product receive configuration.", 409, {
      code: "RECEIVING_VARIANT_REVIEW_REQUIRED", productId: input.productId, productVariantId: input.preferredVariantId,
    });
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
    throw new ReceivingUnitError("This quantity must be counted in pieces. Configure an active one-piece variant for this product before creating the receipt.", 409, {
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
    const base = BigInt(receiptInteger(line[field], field)) * BigInt(oldUnits);
    if (base % BigInt(newUnits) !== BigInt(0)) {
      throw new ReceivingUnitError(`The selected pack cannot represent ${field} exactly. Select a piece variant or a pack that preserves the recorded pieces.`, 409, {
        code: "RECEIVING_UNIT_CONVERSION_INEXACT", field,
      });
    }
    const count = base / BigInt(newUnits);
    if (count > BigInt(MAX_RECEIVING_QUANTITY)) {
      throw new ReceivingUnitError("The converted receipt count exceeds the supported quantity range.", 409, { code: "RECEIVING_UNIT_CONVERSION_OVERFLOW", field });
    }
    result[field] = Number(count);
  }
  return result;
}
