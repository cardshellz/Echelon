/**
 * Quote-aware purchase-order line pricing.
 *
 * Vendor quotes remain authoritative in the form in which they were issued.
 * This module normalizes those quotes to base-piece mills for inventory and
 * COGS without losing the exact extended economics. All arithmetic is done in
 * BigInt; numbers cross the boundary only after a safe-integer check.
 */

export const PO_LINE_PRICING_BASES = [
  "per_piece",
  "per_purchase_uom",
  "extended_total",
] as const;

export const MILLS_PER_CENT = 100;

export type PoLinePricingBasis = (typeof PO_LINE_PRICING_BASES)[number];

export type PerPiecePricingInput = {
  basis: "per_piece";
  quantityPieces: number;
  unitCostMills: number;
};

export type PerPurchaseUomPricingInput = {
  basis: "per_purchase_uom";
  purchaseUom: string;
  uomQuantity: number;
  piecesPerUom: number;
  quotedCostMillsPerUom: number;
};

export type ExtendedTotalPricingInput = {
  basis: "extended_total";
  quantityPieces: number;
  quotedTotalCents: number;
};

export type PoLinePricingInput =
  | PerPiecePricingInput
  | PerPurchaseUomPricingInput
  | ExtendedTotalPricingInput;

export type NormalizedPoLinePricing = {
  pricingBasis: PoLinePricingBasis;
  orderQty: number;
  purchaseUom: string | null;
  purchaseUomQuantity: number | null;
  piecesPerPurchaseUom: number | null;
  quotedUnitCostMills: number | null;
  quotedTotalCents: number | null;
  unitCostMills: number;
  unitCostCents: number;
  totalProductCostCents: number;
  /**
   * Exact quote mills minus normalized per-piece mills times order quantity.
   * This is signed because half-up normalization can round either direction.
   */
  pricingRemainderMills: number;
  quotedExtendedMills: number;
};

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MILLS_PER_CENT_BIGINT = BigInt(MILLS_PER_CENT);

function requireNonnegativeSafeInteger(field: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function requirePositiveSafeInteger(field: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return BigInt(value);
}

function requirePurchaseUom(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError("purchaseUom must be a non-empty string");
  }
  const normalized = value.trim();
  if (normalized.length > 50) {
    throw new RangeError("purchaseUom must be at most 50 characters");
  }
  return normalized;
}

/**
 * Divide with deterministic half-up rounding. For signed numerators, a tie
 * rounds away from zero; pricing inputs currently exercise the non-negative
 * branch, while keeping the primitive safe for signed reconciliation math.
 */
function signedRoundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new RangeError("round-half-up division requires a positive denominator");
  }

  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded =
    remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;

  return negative ? -rounded : rounded;
}

function toSafeInteger(field: string, value: bigint, signed = false): number {
  const minimum = signed ? -MAX_SAFE_INTEGER_BIGINT : BigInt(0);
  if (value < minimum || value > MAX_SAFE_INTEGER_BIGINT) {
    throw new RangeError(`${field} exceeds the safe integer range`);
  }
  return Number(value);
}

function normalizeExactQuote(params: {
  pricingBasis: PoLinePricingBasis;
  orderQty: bigint;
  purchaseUom: string | null;
  purchaseUomQuantity: bigint | null;
  piecesPerPurchaseUom: bigint | null;
  quotedUnitCostMills: bigint | null;
  quotedTotalCents: bigint | null;
  quotedExtendedMills: bigint;
}): NormalizedPoLinePricing {
  // Validate the two multiplicative results before deriving anything from
  // them so overflow is reported at its source, not at a downstream mirror.
  const orderQty = toSafeInteger("orderQty", params.orderQty);
  const quotedExtendedMills = toSafeInteger(
    "quotedExtendedMills",
    params.quotedExtendedMills,
  );
  const unitCostMills = signedRoundHalfUpDiv(
    params.quotedExtendedMills,
    params.orderQty,
  );
  const unitCostCents = signedRoundHalfUpDiv(
    unitCostMills,
    MILLS_PER_CENT_BIGINT,
  );
  const totalProductCostCents =
    params.quotedTotalCents ??
    signedRoundHalfUpDiv(params.quotedExtendedMills, MILLS_PER_CENT_BIGINT);
  const pricingRemainderMills =
    params.quotedExtendedMills - unitCostMills * params.orderQty;

  return {
    pricingBasis: params.pricingBasis,
    orderQty,
    purchaseUom: params.purchaseUom,
    purchaseUomQuantity:
      params.purchaseUomQuantity === null
        ? null
        : toSafeInteger("purchaseUomQuantity", params.purchaseUomQuantity),
    piecesPerPurchaseUom:
      params.piecesPerPurchaseUom === null
        ? null
        : toSafeInteger("piecesPerPurchaseUom", params.piecesPerPurchaseUom),
    quotedUnitCostMills:
      params.quotedUnitCostMills === null
        ? null
        : toSafeInteger("quotedUnitCostMills", params.quotedUnitCostMills),
    quotedTotalCents:
      params.quotedTotalCents === null
        ? null
        : toSafeInteger("quotedTotalCents", params.quotedTotalCents),
    unitCostMills: toSafeInteger("unitCostMills", unitCostMills),
    unitCostCents: toSafeInteger("unitCostCents", unitCostCents),
    totalProductCostCents: toSafeInteger(
      "totalProductCostCents",
      totalProductCostCents,
    ),
    pricingRemainderMills: toSafeInteger(
      "pricingRemainderMills",
      pricingRemainderMills,
      true,
    ),
    quotedExtendedMills,
  };
}

export function normalizePoLinePricing(
  input: PoLinePricingInput,
): NormalizedPoLinePricing {
  if (input === null || typeof input !== "object") {
    throw new RangeError("pricing input must be an object");
  }

  switch (input.basis) {
    case "per_piece": {
      const orderQty = requirePositiveSafeInteger(
        "quantityPieces",
        input.quantityPieces,
      );
      const quotedUnitCostMills = requireNonnegativeSafeInteger(
        "unitCostMills",
        input.unitCostMills,
      );

      return normalizeExactQuote({
        pricingBasis: input.basis,
        orderQty,
        purchaseUom: null,
        purchaseUomQuantity: null,
        piecesPerPurchaseUom: null,
        quotedUnitCostMills,
        quotedTotalCents: null,
        quotedExtendedMills: quotedUnitCostMills * orderQty,
      });
    }

    case "per_purchase_uom": {
      const purchaseUom = requirePurchaseUom(input.purchaseUom);
      const purchaseUomQuantity = requirePositiveSafeInteger(
        "uomQuantity",
        input.uomQuantity,
      );
      const piecesPerPurchaseUom = requirePositiveSafeInteger(
        "piecesPerUom",
        input.piecesPerUom,
      );
      const quotedUnitCostMills = requireNonnegativeSafeInteger(
        "quotedCostMillsPerUom",
        input.quotedCostMillsPerUom,
      );

      return normalizeExactQuote({
        pricingBasis: input.basis,
        orderQty: purchaseUomQuantity * piecesPerPurchaseUom,
        purchaseUom,
        purchaseUomQuantity,
        piecesPerPurchaseUom,
        quotedUnitCostMills,
        quotedTotalCents: null,
        quotedExtendedMills: quotedUnitCostMills * purchaseUomQuantity,
      });
    }

    case "extended_total": {
      const orderQty = requirePositiveSafeInteger(
        "quantityPieces",
        input.quantityPieces,
      );
      const quotedTotalCents = requireNonnegativeSafeInteger(
        "quotedTotalCents",
        input.quotedTotalCents,
      );

      return normalizeExactQuote({
        pricingBasis: input.basis,
        orderQty,
        purchaseUom: null,
        purchaseUomQuantity: null,
        piecesPerPurchaseUom: null,
        quotedUnitCostMills: null,
        quotedTotalCents,
        quotedExtendedMills: quotedTotalCents * MILLS_PER_CENT_BIGINT,
      });
    }

    default:
      throw new RangeError(
        `unsupported pricing basis: ${String((input as { basis?: unknown }).basis)}`,
      );
  }
}
