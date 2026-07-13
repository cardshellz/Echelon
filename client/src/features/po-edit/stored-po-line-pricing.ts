import { centsToMills, millsToDollarString } from "@shared/utils/money";
import type { PoLinePricingInput } from "@shared/utils/po-line-pricing";
import {
  createEmptyPoLinePricingDraft,
  createPerPiecePricingDraft,
  type PoLinePricingEditorDraft,
} from "./PoLinePricingEditor";

export type StoredPoLinePricing = {
  pricingBasis?: string | null;
  orderQty?: number | null;
  unitCostMills?: number | null;
  unitCostCents?: number | null;
  purchaseUom?: string | null;
  purchaseUomQuantity?: number | null;
  piecesPerPurchaseUom?: number | null;
  quotedUnitCostMills?: number | null;
  quotedTotalCents?: number | null;
};

export type StoredPoLinePricingDraft = {
  draft: PoLinePricingEditorDraft;
  requiresLegacyConfirmation: boolean;
};

/** Catalog pack size follows the supplier's quote, never the warehouse's receive-as variant. */
export function vendorCatalogPackSizeForPricing(
  pricing: Exclude<PoLinePricingInput, { basis: "extended_total" }>,
): number {
  return pricing.basis === "per_purchase_uom" ? pricing.piecesPerUom : 1;
}

function positiveIntegerString(value: unknown): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : "";
}

function nonnegativeMillsString(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? millsToDollarString(parsed)
    : "";
}

function nonnegativeCentsString(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return "";
  const wholeDollars = Math.floor(parsed / 100);
  return `${wholeDollars}.${String(parsed % 100).padStart(2, "0")}`;
}

/**
 * Rehydrates the vendor-facing quote stored on a PO line without deriving a
 * new quote basis from its normalized per-piece cost.
 *
 * Legacy rows are the sole exception: their original quote was never stored.
 * They receive a per-piece convenience draft, but callers must require an
 * explicit operator confirmation before persisting it.
 */
export function createStoredPoLinePricingDraft(
  line: StoredPoLinePricing,
): StoredPoLinePricingDraft {
  const orderQty = positiveIntegerString(line.orderQty);

  if (line.pricingBasis === "per_piece") {
    return {
      draft: createEmptyPoLinePricingDraft({
        basis: "per_piece",
        quantityPieces: orderQty,
        unitPriceDollars: nonnegativeMillsString(line.quotedUnitCostMills),
      }),
      requiresLegacyConfirmation: false,
    };
  }

  if (line.pricingBasis === "per_purchase_uom") {
    return {
      draft: createEmptyPoLinePricingDraft({
        basis: "per_purchase_uom",
        purchaseUom:
          typeof line.purchaseUom === "string" ? line.purchaseUom : "",
        uomQuantity: positiveIntegerString(line.purchaseUomQuantity),
        piecesPerUom: positiveIntegerString(line.piecesPerPurchaseUom),
        pricePerUomDollars: nonnegativeMillsString(line.quotedUnitCostMills),
      }),
      requiresLegacyConfirmation: false,
    };
  }

  if (line.pricingBasis === "extended_total") {
    return {
      draft: createEmptyPoLinePricingDraft({
        basis: "extended_total",
        quantityPieces: orderQty,
        quotedTotalDollars: nonnegativeCentsString(line.quotedTotalCents),
      }),
      requiresLegacyConfirmation: false,
    };
  }

  const normalizedMills = line.unitCostMills == null
    ? Number.NaN
    : Number(line.unitCostMills);
  const fallbackMills = Number.isSafeInteger(normalizedMills) && normalizedMills >= 0
    ? normalizedMills
    : centsToMills(Number(line.unitCostCents ?? 0));

  return {
    draft: createPerPiecePricingDraft(
      Number.isSafeInteger(Number(line.orderQty)) && Number(line.orderQty) > 0
        ? Number(line.orderQty)
        : 1,
      Number.isSafeInteger(fallbackMills) && fallbackMills >= 0
        ? fallbackMills
        : 0,
    ),
    requiresLegacyConfirmation: true,
  };
}
