import { z } from "zod";

export interface ReceivingUnitLine {
  id: number;
  receivingOrderId: number;
  productVariantId: number | null;
  productId: number | null;
  expectedQty: number;
  receivedQty: number;
  damagedQty: number;
  unitsPerVariantSnapshot?: number | null;
  inboundShipmentLineId?: number | null;
  unitVersion?: string;
}

const positiveId = z.number().int().positive().max(2_147_483_647);
const countSchema = z.number().int().nonnegative().max(2_147_483_647);
const unitVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function recordedReceivingFactor(line: ReceivingUnitLine): number | null {
  const result = positiveId.safeParse(line.unitsPerVariantSnapshot);
  return result.success ? result.data : null;
}

export function receivingBaseQuantity(count: number, factor: number | null): string | null {
  if (!countSchema.safeParse(count).success || !positiveId.safeParse(factor).success) return null;
  return (BigInt(count) * BigInt(factor!)).toLocaleString("en-US");
}

export function receivingUnitDescription(line: ReceivingUnitLine): string {
  const factor = recordedReceivingFactor(line);
  return factor === null ? "Receive unit needs confirmation" : factor === 1 ? "Pieces" : `Receive units of ${factor.toLocaleString("en-US")} pieces`;
}

function expectedVersion(line: ReceivingUnitLine): string {
  const result = unitVersionSchema.safeParse(line.unitVersion);
  if (!result.success) throw new Error("The receipt unit version is missing. Load the latest receipt before changing this line.");
  return result.data;
}

export function receivingVariantChange(line: ReceivingUnitLine, variantId: number, confirmLegacyUnit = false, expectedUnitsPerVariant?: number) {
  positiveId.parse(variantId);
  const factor = recordedReceivingFactor(line);
  if (factor === null && !confirmLegacyUnit) throw new Error("Confirm what the existing counts mean before changing the receive unit.");
  if (factor === null && line.productVariantId !== null && variantId !== line.productVariantId) {
    throw new Error("Confirm the current variant's count basis before selecting a different variant.");
  }
  return {
    productVariantId: variantId,
    expectedUnitVersion: expectedVersion(line),
    ...(confirmLegacyUnit && factor === null ? { confirmLegacyUnit: true, expectedUnitsPerVariant: receivingSelectedFactor(expectedUnitsPerVariant) } : {}),
  };
}

/** A blank/decimal/negative draft is an error, never a coerced count or fallback. */
export function receivingCountChange(line: ReceivingUnitLine, draft: string | undefined) {
  if (recordedReceivingFactor(line) === null) throw new Error("Confirm the receive unit before saving counts.");
  const candidate = draft === undefined ? line.receivedQty
    : /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : NaN;
  const parsed = countSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Enter a whole received quantity from 0 to 2,147,483,647.");
  return { receivedQty: parsed.data, expectedUnitVersion: expectedVersion(line) };
}

export function receivingAddQuantity(raw: string): number {
  const result = positiveId.safeParse(/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!result.success) throw new Error("Enter a positive whole quantity from 1 to 2,147,483,647.");
  return result.data;
}

export function receivingCompleteAllCommand(lines: ReceivingUnitLine[]) {
  if (lines.length === 0) throw new Error("There are no receipt lines to count.");
  return { expectedUnitVersions: lines.map((line) => {
    if (recordedReceivingFactor(line) === null) throw new Error("Confirm every receive unit before completing counts.");
    positiveId.parse(line.id);
    countSchema.parse(line.expectedQty); countSchema.parse(line.receivedQty); countSchema.parse(line.damagedQty);
    return { lineId: line.id, unitVersion: expectedVersion(line) };
  }) };
}

const mutationLineSchema = z.object({
  id: positiveId, receivingOrderId: positiveId, productId: positiveId.nullable(), productVariantId: positiveId.nullable(),
  expectedQty: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  receivedQty: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  damagedQty: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  unitsPerVariantSnapshot: positiveId.nullable(), inboundShipmentLineId: positiveId.nullish(),
  unitVersion: z.string().regex(/^[a-f0-9]{64}$/), status: z.string(),
  sku: z.string().nullable(), productName: z.string().nullable(),
  putawayLocationId: positiveId.nullable(), putawayComplete: z.number().int(),
  unitCost: z.number().int().safe().nullable(), notes: z.string().nullable(), purchaseOrderLineId: positiveId.nullable(),
}).passthrough();

export function parseReceivingLineMutation(value: unknown, expected: { id: number; receivingOrderId: number; updates: Record<string, unknown> }) {
  const result = mutationLineSchema.safeParse(value);
  if (!result.success || result.data.id !== expected.id || result.data.receivingOrderId !== expected.receivingOrderId ||
      "productVariantId" in expected.updates && result.data.productVariantId !== expected.updates.productVariantId ||
      "receivedQty" in expected.updates && result.data.receivedQty !== expected.updates.receivedQty) {
    throw new Error("The line may have saved, but its response could not be verified. Load the latest receipt before continuing.");
  }
  return result.data;
}

/** Bind a new or explicitly confirmed count basis to the factor the operator saw. */
export function receivingSelectedFactor(value: unknown): number {
  const result = positiveId.safeParse(value);
  if (!result.success) throw new Error("Refresh and reselect the SKU to confirm its current pieces per receive unit.");
  return result.data;
}
