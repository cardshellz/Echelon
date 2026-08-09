/**
 * Dropship return fee engine (design spec D2 + D5; build spec B2).
 *
 * Pure domain logic: given the fault category, the accepted return lines with
 * their wholesale unit costs (from dropship_order_economics_snapshots), the
 * resolved fee schedule rows (B1 resolver), and the actual return label cost
 * from channel evidence, compute the settlement.
 *
 * Locked rules:
 * - Credit basis is the WHOLESALE cost actually debited, per accepted unit.
 *   NEVER retail price (D2 credit basis).
 * - Fault matrix (D2):
 *     card_shellz: product + original shipping credited; return label absorbed;
 *                  no restocking/processing fees.
 *     vendor/customer/marketplace: product credited; original shipping NOT
 *                  credited; vendor pays return label (actual cost); restocking
 *                  and processing per schedule.
 *     carrier: product + allocated shipping credited FROM POOL; no vendor
 *              debit; no fees.
 * - Fee amounts: flat_cents now; percent = percent of the wholesale line
 *   credit (D2). Percent math is integer cents with floor rounding — never
 *   floating point for money (coding standards rule 3/16).
 * - Netting (D5): fees net against the same-RMA credit first; any remainder
 *   may drive the vendor wallet negative. There is no insufficient-funds
 *   hard-fail in the return-fee path.
 */

export type DropshipReturnEngineFaultCategory =
  "card_shellz" | "vendor" | "customer" | "marketplace" | "carrier";

export interface DropshipReturnFeeScheduleRow {
  feeType: "restocking_fee" | "processing_fee" | "return_shipping_fee";
  amountType: "flat_cents" | "percent";
  /** flat_cents: integer cents. percent: 0-100. */
  amount: number;
  /** Responsibility selected for this fee independently of overall return fault. */
  responsibility: DropshipReturnEngineFaultCategory;
}

export interface DropshipReturnAcceptedLine {
  productVariantId: number | null;
  acceptedQuantity: number;
  /** Wholesale unit cost actually debited, from the economics snapshot. */
  wholesaleUnitCostCents: number;
}

export interface DropshipReturnSettlementInput {
  faultCategory: DropshipReturnEngineFaultCategory;
  acceptedLines: readonly DropshipReturnAcceptedLine[];
  /** Original outbound shipping the vendor was debited (economics snapshot). */
  originalShippingCents: number;
  /** Actual return label cost from RMA channel evidence, when known. */
  returnShippingActualCents: number | null;
  fees: {
    restockingFee: DropshipReturnFeeScheduleRow | null;
    processingFee: DropshipReturnFeeScheduleRow | null;
    returnShippingFee: DropshipReturnFeeScheduleRow | null;
  };
}

export interface DropshipReturnSettlement {
  /** Wholesale product credit for accepted units. */
  productCreditCents: number;
  /** Original outbound shipping credited back (card_shellz / carrier only). */
  originalShippingCreditCents: number;
  restockingFeeCents: number;
  processingFeeCents: number;
  /** Return shipping charged to the vendor (actual label cost). */
  returnShippingFeeCents: number;
  /** productCredit + originalShippingCredit (before fees). */
  grossCreditCents: number;
  /** restocking + processing + returnShipping charged to the vendor. */
  totalFeeCents: number;
  /** grossCredit - totalFee. Negative means the vendor owes the remainder. */
  netSettlementCents: number;
  /** Ledger credit type to use for the vendor-facing credit entry. */
  creditLedgerType: "return_credit" | "insurance_pool_credit";
  /** Structured breakdown persisted on the ledger entry metadata (jsonb). */
  breakdown: Record<string, unknown>;
}

/**
 * Compute the fee amount for one schedule row against a credit basis.
 * flat_cents: the amount as-is. percent: floor(basis * amount / 100).
 */
export function computeReturnFeeCents(
  row: DropshipReturnFeeScheduleRow,
  creditBasisCents: number,
): number {
  if (row.amountType === "flat_cents") {
    return Math.trunc(row.amount);
  }
  // percent: integer math only — multiply first, then floor-divide.
  return Math.floor((creditBasisCents * row.amount) / 100);
}

export function computeDropshipReturnSettlement(
  input: DropshipReturnSettlementInput,
): DropshipReturnSettlement {
  const productCreditCents = input.acceptedLines.reduce(
    (sum, line) => sum + line.wholesaleUnitCostCents * line.acceptedQuantity,
    0,
  );

  const creditsOriginalShipping =
    input.faultCategory === "card_shellz" || input.faultCategory === "carrier";
  const originalShippingCreditCents = creditsOriginalShipping
    ? input.originalShippingCents
    : 0;

  const restockingFeeCents = vendorPaysFee(input.fees.restockingFee)
    ? computeReturnFeeCents(
        input.fees.restockingFee as DropshipReturnFeeScheduleRow,
        productCreditCents,
      )
    : 0;
  const processingFeeCents = vendorPaysFee(input.fees.processingFee)
    ? computeReturnFeeCents(
        input.fees.processingFee as DropshipReturnFeeScheduleRow,
        productCreditCents,
      )
    : 0;
  const returnShippingFeeCents =
    vendorPaysFee(input.fees.returnShippingFee) &&
    input.returnShippingActualCents !== null
      ? input.returnShippingActualCents
      : 0;

  const grossCreditCents = productCreditCents + originalShippingCreditCents;
  const totalFeeCents =
    restockingFeeCents + processingFeeCents + returnShippingFeeCents;
  const netSettlementCents = grossCreditCents - totalFeeCents;

  return {
    productCreditCents,
    originalShippingCreditCents,
    restockingFeeCents,
    processingFeeCents,
    returnShippingFeeCents,
    grossCreditCents,
    totalFeeCents,
    netSettlementCents,
    creditLedgerType:
      input.faultCategory === "carrier"
        ? "insurance_pool_credit"
        : "return_credit",
    breakdown: {
      version: 1,
      faultCategory: input.faultCategory,
      acceptedLines: input.acceptedLines.map((line) => ({
        productVariantId: line.productVariantId,
        acceptedQuantity: line.acceptedQuantity,
        wholesaleUnitCostCents: line.wholesaleUnitCostCents,
        lineCreditCents: line.wholesaleUnitCostCents * line.acceptedQuantity,
      })),
      productCreditCents,
      originalShippingCreditCents,
      fees: {
        restocking: feeBreakdownEntry(
          input.fees.restockingFee,
          restockingFeeCents,
        ),
        processing: feeBreakdownEntry(
          input.fees.processingFee,
          processingFeeCents,
        ),
        returnShipping: {
          vendorPays: vendorPaysFee(input.fees.returnShippingFee),
          responsibility: input.fees.returnShippingFee?.responsibility ?? null,
          actualLabelCostCents: input.returnShippingActualCents,
          chargedCents: returnShippingFeeCents,
        },
      },
      grossCreditCents,
      totalFeeCents,
      netSettlementCents,
    },
  };
}

function vendorPaysFee(
  row: DropshipReturnFeeScheduleRow | null,
): row is DropshipReturnFeeScheduleRow {
  return (
    row !== null &&
    (row.responsibility === "vendor" ||
      row.responsibility === "customer" ||
      row.responsibility === "marketplace")
  );
}

function feeBreakdownEntry(
  row: DropshipReturnFeeScheduleRow | null,
  chargedCents: number,
): Record<string, unknown> {
  if (!row) {
    return { configured: false, chargedCents: 0 };
  }
  return {
    configured: true,
    amountType: row.amountType,
    amount: row.amount,
    responsibility: row.responsibility,
    vendorPays: vendorPaysFee(row),
    chargedCents,
  };
}
