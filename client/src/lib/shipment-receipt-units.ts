import { z } from "zod";
import { shipmentReceiptUnitSelectionsSchema, type ShipmentReceiptUnitSelection } from "@shared/procurement/shipment-receipt-plan";

const id = z.number().int().positive().max(2_147_483_647);
const variant = z.object({ id, sku: z.string().nullable(), name: z.string().nullable(), unitsPerVariant: id });
const receivePlan = z.object({
  productVariantId: id, unitsPerVariant: id, expectedQty: id, countsAsPieces: z.boolean(),
  preferredVariantId: id.nullable(), preferredUnitsPerVariant: id.nullable(),
});
const poDirectReceiveOptionSchema = z.object({
  allowed: z.boolean(), warning: z.string(), reason: z.string().nullable().optional(),
  blockedPurchaseOrderLineIds: z.array(id).optional(), custodyReceiptIds: z.array(id).optional(),
});
export type PoDirectReceiveOption = z.infer<typeof poDirectReceiveOptionSchema>;

export function parsePoDirectReceiveOption(value: unknown): PoDirectReceiveOption {
  const parsed = poDirectReceiveOptionSchema.safeParse(value);
  return parsed.success ? parsed.data : {
    allowed: false,
    warning: "Receiving options could not be verified. Refresh before creating a receipt.",
  };
}

export const shipmentReceiptResolutionSchema = z.object({
  shipmentId: id, shipmentNumber: z.string().nullable(), status: z.string().nullable(),
  purchaseOrderId: id, poNumber: z.string().nullable(), canCreateReceipt: z.boolean(),
  unresolvedCount: z.number().int().nonnegative(), lineCount: z.number().int().nonnegative(), issue: z.string().nullable(),
  receiptUnitSelections: shipmentReceiptUnitSelectionsSchema.optional(),
  receivedBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  remainingBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  qtyShipped: z.number().int().nonnegative().safe().nullable().optional(),
  custodyBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  heldBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  returnedBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  excessBaseQty: z.number().int().nonnegative().safe().nullable().optional(),
  custodyReceiptIds: z.array(id).optional(),
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
  if (resolution.lineCount !== resolution.lines.length || resolution.unresolvedCount !== resolution.lines.filter(line => line.blocking).length || resolution.canCreateReceipt && (resolution.lines.length === 0 || resolution.lines.some((line) => {
    const plan = line.receivePlan;
    return line.blocking || !plan || plan.productVariantId !== line.matchedVariant?.id ||
      plan.unitsPerVariant !== line.matchedVariant.unitsPerVariant || plan.countsAsPieces !== (plan.unitsPerVariant === 1) ||
      line.qtyShipped === null || BigInt(plan.expectedQty) * BigInt(plan.unitsPerVariant) !== BigInt(line.qtyShipped);
  }))) throw new Error("The receive-unit plan could not be verified against shipped pieces. Refresh before creating the receipt.");
  if (resolution.canCreateReceipt && resolution.receiptUnitSelections?.some(selection => {
    const line = resolution.lines.find(value => value.shipmentLineId === selection.shipmentLineId);
    return !line || selection.expectedBaseQty !== line.qtyShipped || selection.productVariantId !== line.receivePlan?.productVariantId || selection.unitsPerVariant !== line.receivePlan.unitsPerVariant;
  })) throw new Error("The reviewed configurations do not match the receipt plan. Refresh before creating the receipt.");
  return resolution;
}

export function requiresReceiptUnitReview(resolution: ShipmentReceiptPackResolution): boolean {
  return !resolution.canCreateReceipt || !!resolution.issue || !!resolution.receiptUnitSelections?.length || resolution.lines.some((line) => line.receivePlan?.countsAsPieces && (line.receivePlan.preferredUnitsPerVariant ?? 1) > 1);
}

export function receiptUnitDraftKey(scope: { shipmentId: number; purchaseOrderId: number }): string {
  return `shipment-receipt-units:${scope.shipmentId}:${scope.purchaseOrderId}`;
}

export function readReceiptUnitDraft(scope: { shipmentId: number; purchaseOrderId: number }): ShipmentReceiptUnitSelection[] {
  try {
    const result = shipmentReceiptUnitSelectionsSchema.safeParse(JSON.parse(sessionStorage.getItem(receiptUnitDraftKey(scope)) ?? "[]"));
    return result.success ? result.data : [];
  } catch { return []; }
}

export function saveReceiptUnitDraft(scope: { shipmentId: number; purchaseOrderId: number }, selections: ShipmentReceiptUnitSelection[]): void {
  sessionStorage.setItem(receiptUnitDraftKey(scope), JSON.stringify(shipmentReceiptUnitSelectionsSchema.parse(selections)));
}

export function clearReceiptUnitDraft(scope: { shipmentId: number; purchaseOrderId: number }): void {
  try { sessionStorage.removeItem(receiptUnitDraftKey(scope)); }
  catch (error) { console.warn("Receipt configuration draft cleanup failed", { shipmentId: scope.shipmentId, purchaseOrderId: scope.purchaseOrderId, error }); }
}

export async function fetchShipmentReceiptResolution(scope: { shipmentId: number; purchaseOrderId: number }, selections = readReceiptUnitDraft(scope)): Promise<ShipmentReceiptPackResolution> {
  const query = new URLSearchParams({ purchaseOrderId: String(scope.purchaseOrderId) });
  const response = await fetch(`/api/inbound-shipments/${scope.shipmentId}/receipt-pack-resolution${selections.length ? "" : `?${query}`}`,
    selections.length ? { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purchaseOrderId: scope.purchaseOrderId, receiptUnitSelections: shipmentReceiptUnitSelectionsSchema.parse(selections) }) } : undefined);
  const body = await response.json().catch(() => null);
  if (selections.length && response.status === 409 && body?.details?.code === "SHIPMENT_RECEIPT_SELECTION_SCOPE_CHANGED") {
    clearReceiptUnitDraft(scope);
    const latest = await fetchShipmentReceiptResolution(scope, []);
    return { ...latest, issue: "The remaining shipment lines changed. Previous configuration choices were cleared. Review the current items before creating a receipt." };
  }
  if (!response.ok) throw new Error(body?.error || "The receiving configurations could not be checked. Refresh and try again.");
  return parseShipmentReceiptResolution(body, scope);
}


export interface ShipmentReceiveCoverage {
  action?: string;
  receivable?: boolean;
  remainingBaseQty?: number | null;
  receivedBaseQty?: number | null;
  qtyShipped?: number | null;
  custodyBaseQty?: number | null;
  heldBaseQty?: number | null;
  returnedBaseQty?: number | null;
  excessBaseQty?: number | null;
  custodyReceiptIds?: number[];
}

export function shipmentCustodyReceiptIds(option: ShipmentReceiveCoverage): number[] {
  const parsed = z.array(id).safeParse(option.custodyReceiptIds);
  return parsed.success ? [...new Set(parsed.data)].sort((left, right) => left - right) : [];
}

/** Physical custody covers a shipment source without proving inventory receipt.
 * Older payloads can prove full receipt only with an exact accepted/shipped match. */
export function shipmentReceiveCoverageLabel(option: ShipmentReceiveCoverage): { fullyReceived: boolean; text: string } {
  const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const hasCustodyEvidence = [option.custodyBaseQty, option.heldBaseQty, option.returnedBaseQty].some(value => value !== undefined);
  const custody = hasCustodyEvidence ? option.custodyBaseQty : 0;
  const custodyKnown = !hasCustodyEvidence || valid(custody) && valid(option.heldBaseQty) && valid(option.returnedBaseQty)
    && BigInt(option.heldBaseQty) + BigInt(option.returnedBaseQty) === BigInt(custody);
  const review = { fullyReceived: false, text: "Receipt coverage needs review" };
  if (!valid(option.receivedBaseQty) || !valid(option.remainingBaseQty) || !valid(option.qtyShipped)
    || !custodyKnown || !valid(custody)
    || option.excessBaseQty !== undefined && !valid(option.excessBaseQty)) return review;
  const coveredBaseQty = BigInt(option.receivedBaseQty) + BigInt(custody);
  const shippedBaseQty = BigInt(option.qtyShipped);
  // Only the source owner can prove excess on one line alongside a fresh remainder on another.
  // Legacy payloads prove an exact total or net overage with zero remainder, never mixed-line excess.
  const aboveShippedQty = option.excessBaseQty !== undefined
    ? BigInt(option.excessBaseQty!)
    : coveredBaseQty > shippedBaseQty ? coveredBaseQty - shippedBaseQty : BigInt(0);
  if (coveredBaseQty + BigInt(option.remainingBaseQty) !== shippedBaseQty + aboveShippedQty) return review;
  const fullyReceived = option.action !== "open_existing_receipt" && !option.receivable
    && option.remainingBaseQty === 0 && custody === 0 && aboveShippedQty === BigInt(0)
    && option.qtyShipped > 0 && option.receivedBaseQty === option.qtyShipped;
  if (custody > 0 || aboveShippedQty > BigInt(0)) {
    const parts = [`${option.receivedBaseQty.toLocaleString("en-US")} pieces received into inventory`];
    if (option.heldBaseQty! > 0) parts.push(`${option.heldBaseQty!.toLocaleString("en-US")} held in quarantine`);
    if (option.returnedBaseQty! > 0) parts.push(`${option.returnedBaseQty!.toLocaleString("en-US")} returned to supplier`);
    parts.push(`${option.remainingBaseQty.toLocaleString("en-US")} pieces remaining to receive`);
    if (aboveShippedQty > BigInt(0)) parts.push(`${aboveShippedQty.toLocaleString("en-US")} pieces above shipped quantity`);
    return { fullyReceived: false, text: parts.join(" · ") };
  }
  const text = option.remainingBaseQty > 0
    ? option.remainingBaseQty.toLocaleString("en-US") + " of " + option.qtyShipped.toLocaleString("en-US") + " pieces remaining"
    : option.qtyShipped.toLocaleString("en-US") + " shipped pieces";
  return { fullyReceived, text };
}
