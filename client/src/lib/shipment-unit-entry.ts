import { z } from "zod";
import { toBasePieces, convertUnitQuantity } from "@shared/procurement/unit-quantity";
import { shipmentUnitsSchema, type ShipmentUnits } from "@shared/procurement/shipment-unit-selection";

export type ShipmentQuantityDraft = {
  variantId: number | null;
  unitsPerVariant: number;
  quantity: string;
};

const positiveCount = z.number().int().positive().max(2_147_483_647);

export function parseShipmentUnits(value: unknown): ShipmentUnits | null {
  const parsed = shipmentUnitsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Existing base pieces remain authoritative when historical pack evidence is absent. */
export function shipmentQuantityDraft(pieces: number, units: ShipmentUnits | null): ShipmentQuantityDraft {
  const selected = units?.variants.find((variant) => variant.id === units.selectedVariantId);
  const factor = units?.unitsPerVariantSnapshot;
  if (positiveCount.safeParse(pieces).success && selected && factor !== null && factor !== undefined
    && selected.unitsPerVariant === factor && pieces % factor === 0) {
    return { variantId: selected.id, unitsPerVariant: factor, quantity: String(pieces / factor) };
  }
  return { variantId: null, unitsPerVariant: 1, quantity: String(pieces) };
}

export function selectShipmentQuantityUnit(draft: ShipmentQuantityDraft, variantId: number | null, units: ShipmentUnits | null): ShipmentQuantityDraft {
  const pieceVariant = units?.variants.filter((variant) => variant.unitsPerVariant === 1).sort((a, b) => a.id - b.id)[0];
  const selected = variantId === null ? pieceVariant : units?.variants.find((variant) => variant.id === variantId);
  if (variantId !== null && !selected) throw new Error("Refresh the available receive units before selecting this configuration.");
  const factor = selected?.unitsPerVariant ?? 1;
  let quantity = "";
  try { quantity = String(convertUnitQuantity(parseCount(draft.quantity), draft.unitsPerVariant, factor)); }
  catch { /* An inexact or incomplete draft must be explicitly counted in the new unit. */ }
  return { variantId: selected?.id ?? null, unitsPerVariant: factor, quantity };
}

function parseCount(raw: string): number {
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const parsed = positiveCount.safeParse(value);
  if (!parsed.success) throw new Error("Enter a positive whole quantity within the supported range.");
  return parsed.data;
}

export function shipmentQuantityPayload(draft: ShipmentQuantityDraft, units: ShipmentUnits | null, maximumPieces?: number) {
  const quantity = parseCount(draft.quantity);
  if (draft.variantId === null && draft.unitsPerVariant !== 1) throw new Error("Piece entry must use one piece per unit.");
  if (draft.variantId !== null) {
    const selected = units?.variants.find((variant) => variant.id === draft.variantId);
    if (!selected || selected.unitsPerVariant !== draft.unitsPerVariant) throw new Error("The selected receive unit changed. Refresh and review its pieces per unit.");
  }
  const qtyShipped = toBasePieces(quantity, draft.unitsPerVariant);
  if (maximumPieces !== undefined && qtyShipped > maximumPieces) {
    throw new Error(`The selected quantity is ${qtyShipped.toLocaleString("en-US")} pieces; only ${maximumPieces.toLocaleString("en-US")} pieces remain available.`);
  }
  return { qtyShipped, ...(draft.variantId === null ? {} : {
    unitSelection: { productVariantId: draft.variantId, unitsPerVariant: draft.unitsPerVariant, quantity },
  }) };
}

export function shipmentQuantityPreview(draft: ShipmentQuantityDraft, units: ShipmentUnits | null, maximumPieces?: number): { pieces: number | null; error: string | null } {
  try { return { pieces: shipmentQuantityPayload(draft, units, maximumPieces).qtyShipped, error: null }; }
  catch (cause) { return { pieces: null, error: cause instanceof Error ? cause.message : "Review the shipment quantity." }; }
}

/** Describe retained quantity evidence; live catalog factors never relabel history. */
export function shipmentRecordedUnitSummary(line: { qtyShipped?: unknown; shipmentUnits?: unknown }): string {
  const units = parseShipmentUnits(line.shipmentUnits);
  const factor = units?.unitsPerVariantSnapshot;
  if (!factor || !units?.selectedVariantId) return "Receive unit not recorded";
  if (factor === 1) return "Recorded in pieces";
  const pieces = positiveCount.safeParse(line.qtyShipped);
  if (!pieces.success || pieces.data % factor !== 0) return `Recorded receive unit: ${factor.toLocaleString("en-US")} pieces; piece count is not whole packs`;
  return `${(pieces.data / factor).toLocaleString("en-US")} × ${factor.toLocaleString("en-US")} pieces per receive unit`;
}
export function shipmentDimensionBasisLabel(line: { dimensionBasis?: unknown; cartonCount?: unknown }): "piece" | "carton" {
  if (line.dimensionBasis === "piece" || line.dimensionBasis === "carton") return line.dimensionBasis;
  return line.cartonCount !== null && line.cartonCount !== undefined ? "carton" : "piece";
}
