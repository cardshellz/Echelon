import type { SupplierSourcingOption } from "@shared/procurement/supplier-sourcing";
import { computeLineTotalCentsFromMills, formatMills } from "@shared/utils/money";
import { rfqMoneyAsInput } from "@/lib/rfq-quote-form";
import {
  DECISION_NOTE_MIN_LENGTH,
  controlAckKey,
  exceedReasonValid,
  exceedsSuggestion,
  poLineFlagged,
  rfqLineNeedsApproval,
  type ConfirmPoLineInput,
  type ConfirmRfqLineInput,
} from "./reorderEngine";

export const SOLO_FAST_TRACK_DECISION_NOTE =
  "Reviewed and approved by solo buyer via Buying Desk";

export interface AnnotatedSupplierOption {
  option: SupplierSourcingOption;
  isSelected: boolean;
  isBestPrice: boolean;
  isFastestLeadTime: boolean;
  formattedUnitCost: string | null;
  formattedPackQuote: string | null;
  estimatedLineTotalCents: number | null;
  formattedLineTotal: string | null;
  moqLabel: string;
  incrementLabel: string;
  tierSummaries: Array<{ label: string; isActive: boolean }>;
  quoteStatus: {
    label: string;
    tone: "green" | "amber" | "red" | "gray";
  };
}

/**
 * Currency-safe unit/extended money formatting: never emits "$" for non-USD
 * currencies (or when currencyCodeOnly is true) so foreign-currency quote views
 * remain strictly currency-honest.
 */
export function formatOptionMills(
  mills: number,
  currency: string | null,
  currencyCodeOnly = false,
): string {
  if (currency === "USD" && !currencyCodeOnly) {
    return formatMills(mills);
  }
  const numeric = rfqMoneyAsInput(mills, 4);
  return currency ? `${numeric} ${currency}` : numeric;
}

export function formatOptionCents(
  cents: number,
  currency: string | null,
  currencyCodeOnly = false,
): string {
  const absDollars = Math.abs(cents) / 100;
  const formatted =
    absDollars >= 100 || cents % 100 === 0
      ? Math.round(cents / 100).toLocaleString("en-US")
      : (cents / 100).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  if (currency === "USD" && !currencyCodeOnly) {
    return `$${formatted}`;
  }
  return currency ? `${formatted} ${currency}` : formatted;
}

export function rankAndAnnotateSupplierOptions(
  options: readonly SupplierSourcingOption[],
  selectedVendorProductId: number | null | undefined,
  asOfIsoDate?: string,
  currencyCodeOnly = false,
): AnnotatedSupplierOption[] {
  if (options.length === 0) return [];

  // Only compare prices within the same known currency (USD-first in Echelon)
  // among eligible options that have a verified/estimated unit cost.
  const eligibleUsdCosts = options
    .filter(
      (opt) =>
        opt.eligible &&
        (opt.currency === "USD" || opt.tier?.priceList.currency === "USD") &&
        opt.estimatedUnitCostMills !== null,
    )
    .map((opt) => opt.estimatedUnitCostMills!);

  const minUsdMills =
    eligibleUsdCosts.length >= 2 ? Math.min(...eligibleUsdCosts) : null;

  const eligibleLeadTimes = options
    .filter((opt) => opt.eligible)
    .map((opt) => opt.leadTimeDays);
  const distinctLeadTimes = new Set(eligibleLeadTimes);
  const minLeadTime =
    eligibleLeadTimes.length >= 2 && distinctLeadTimes.size >= 2
      ? Math.min(...eligibleLeadTimes)
      : null;

  return options.map((option) => {
    const currency = option.tier?.priceList.currency ?? option.currency ?? null;
    const isSelected =
      selectedVendorProductId !== null &&
      selectedVendorProductId !== undefined &&
      option.vendorProductId === selectedVendorProductId;

    const isBestPrice =
      minUsdMills !== null &&
      option.eligible &&
      currency === "USD" &&
      option.estimatedUnitCostMills === minUsdMills;

    const isFastestLeadTime =
      minLeadTime !== null &&
      option.eligible &&
      option.leadTimeDays === minLeadTime;

    const formattedUnitCost =
      option.estimatedUnitCostMills !== null
        ? `${formatOptionMills(option.estimatedUnitCostMills, currency, currencyCodeOnly)}/pc`
        : null;

    const priceList = option.tier?.priceList ?? null;
    const formattedPackQuote =
      option.tier &&
      priceList &&
      priceList.basis === "per_purchase_uom" &&
      priceList.purchaseUom &&
      priceList.piecesPerPurchaseUom
        ? `${formatOptionMills(option.tier.unitCostMills, priceList.currency, currencyCodeOnly)} / ${priceList.purchaseUom} (${priceList.piecesPerPurchaseUom.toLocaleString("en-US")} pc)`
        : null;

    let estimatedLineTotalCents: number | null = null;
    if (option.proposedPieces > 0) {
      if (option.tier && option.tier.evaluatedPieces === option.proposedPieces) {
        estimatedLineTotalCents = option.tier.totalProductCostCents;
      } else if (option.estimatedUnitCostMills !== null) {
        estimatedLineTotalCents = computeLineTotalCentsFromMills(
          option.estimatedUnitCostMills,
          option.proposedPieces,
        );
      }
    }

    const formattedLineTotal =
      estimatedLineTotalCents !== null
        ? formatOptionCents(estimatedLineTotalCents, currency, currencyCodeOnly)
        : null;

    const moqLabel =
      option.minimumOrderPieces !== null && option.minimumOrderPieces > 0
        ? `MOQ ${option.minimumOrderPieces.toLocaleString("en-US")} pc`
        : "No MOQ";

    const incrementLabel =
      option.orderIncrementPieces > 1
        ? `Mult ${option.orderIncrementPieces.toLocaleString("en-US")} pc`
        : "1 pc increments";

    const tierSummaries: Array<{ label: string; isActive: boolean }> = priceList
      ? priceList.tiers.map((tier, idx) => {
          const unitLabel =
            priceList.basis === "per_purchase_uom" && priceList.purchaseUom
              ? priceList.purchaseUom
              : "pc";
          return {
            label: `${tier.minimumQuantity.toLocaleString("en-US")}+ ${unitLabel}: ${formatOptionMills(tier.unitCostMills, priceList.currency, currencyCodeOnly)}`,
            isActive: option.tier?.tierIndex === idx,
          };
        })
      : [];

    const quoteStatus = resolveOptionQuoteStatus(option, asOfIsoDate);

    return {
      option,
      isSelected,
      isBestPrice,
      isFastestLeadTime,
      formattedUnitCost,
      formattedPackQuote,
      estimatedLineTotalCents,
      formattedLineTotal,
      moqLabel,
      incrementLabel,
      tierSummaries,
      quoteStatus,
    };
  });
}

function resolveOptionQuoteStatus(
  option: SupplierSourcingOption,
  asOfIsoDate?: string,
): AnnotatedSupplierOption["quoteStatus"] {
  if (!option.eligible) {
    const reason =
      option.rejectionReasons.length > 0
        ? option.rejectionReasons.join(", ").replaceAll("_", " ")
        : "Ineligible";
    return { label: `Rejected: ${reason}`, tone: "red" };
  }
  if (option.pricingReviewReasons.length > 0) {
    const reason = option.pricingReviewReasons.join(", ").replaceAll("_", " ");
    return { label: `Review: ${reason}`, tone: "amber" };
  }
  if (option.tier) {
    const validUntil = option.tier.priceList.validUntil;
    if (asOfIsoDate && validUntil < asOfIsoDate) {
      return { label: `Expired ${validUntil}`, tone: "red" };
    }
    return { label: `Valid thru ${validUntil}`, tone: "green" };
  }
  if (option.estimatedUnitCostMills !== null) {
    return { label: "Catalog estimate", tone: "amber" };
  }
  return { label: "Quote needed", tone: "gray" };
}

/**
 * Deep-link into the streamlined PurchaseOrderEdit composer (/purchase-orders/new)
 * with vendor and (when known) variant preselected.
 */
export function buildNewEditablePoHref(input: {
  vendorId: number;
  productVariantId?: number | null;
}): string {
  const params = new URLSearchParams();
  params.set("vendor_id", String(input.vendorId));
  if (
    typeof input.productVariantId === "number" &&
    Number.isSafeInteger(input.productVariantId) &&
    input.productVariantId > 0
  ) {
    params.set("variant_ids", String(input.productVariantId));
  }
  return `/purchase-orders/new?${params.toString()}`;
}

/**
 * True when Stage 2 (confirm) has at least one control checkbox, sourcing
 * exception checkbox, or flagged decision-note requirement that can be
 * satisfied in 1 click by a solo buyer.
 */
export function hasPendingSoloConfirmRequirements(input: {
  poLines: readonly ConfirmPoLineInput[];
  rfqLines: readonly ConfirmRfqLineInput[];
  acknowledgedControlKeys: ReadonlySet<string>;
  approvedExceptionIds: ReadonlySet<string>;
  note: string;
}): boolean {
  for (const line of input.poLines) {
    for (const control of line.controls) {
      if (!input.acknowledgedControlKeys.has(controlAckKey(line.recommendationId, control.code))) {
        return true;
      }
    }
    if (
      exceedsSuggestion(line.pieces, line.suggestedOrderPieces) &&
      exceedReasonValid(line.exceedReason) &&
      !input.approvedExceptionIds.has(line.recommendationId)
    ) {
      return true;
    }
  }
  for (const line of input.rfqLines) {
    if (
      rfqLineNeedsApproval(line.pieces, line.baselinePieces) &&
      exceedReasonValid(line.exceedReason) &&
      !input.approvedExceptionIds.has(line.recommendationId)
    ) {
      return true;
    }
  }
  const anyFlagged = input.poLines.some((line) =>
    poLineFlagged(line.controls.length, line.pieces, line.suggestedOrderPieces),
  );
  if (anyFlagged && input.note.trim().length < DECISION_NOTE_MIN_LENGTH) {
    return true;
  }
  return false;
}

/**
 * Produces the next acknowledgement sets + audit note for 1-click Solo Fast-Track
 * confirmation in the Order Builder while preserving every server evidence field.
 */
export function buildSoloConfirmAcknowledgement(input: {
  poLines: readonly ConfirmPoLineInput[];
  rfqLines: readonly ConfirmRfqLineInput[];
  currentAckedControls: ReadonlySet<string>;
  currentApprovedExceptions: ReadonlySet<string>;
  currentNote: string;
}): {
  ackedControls: Set<string>;
  approvedExceptions: Set<string>;
  decisionNote: string;
} {
  const ackedControls = new Set(input.currentAckedControls);
  const approvedExceptions = new Set(input.currentApprovedExceptions);

  for (const line of input.poLines) {
    for (const control of line.controls) {
      ackedControls.add(controlAckKey(line.recommendationId, control.code));
    }
    if (
      exceedsSuggestion(line.pieces, line.suggestedOrderPieces) &&
      exceedReasonValid(line.exceedReason)
    ) {
      approvedExceptions.add(line.recommendationId);
    }
  }

  for (const line of input.rfqLines) {
    if (
      rfqLineNeedsApproval(line.pieces, line.baselinePieces) &&
      exceedReasonValid(line.exceedReason)
    ) {
      approvedExceptions.add(line.recommendationId);
    }
  }

  const anyFlagged = input.poLines.some((line) =>
    poLineFlagged(line.controls.length, line.pieces, line.suggestedOrderPieces),
  );
  const decisionNote =
    input.currentNote.trim().length >= DECISION_NOTE_MIN_LENGTH
      ? input.currentNote
      : anyFlagged
        ? SOLO_FAST_TRACK_DECISION_NOTE
        : input.currentNote;

  return { ackedControls, approvedExceptions, decisionNote };
}
