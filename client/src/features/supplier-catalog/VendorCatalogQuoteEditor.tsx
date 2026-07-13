import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
  type PerPiecePricingInput,
  type PerPurchaseUomPricingInput,
} from "@shared/utils/po-line-pricing";
import {
  dollarsToMills,
  formatMills,
  millsToDollarString,
} from "@shared/utils/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type VendorCatalogQuoteBasis = "per_piece" | "per_purchase_uom";

export type VendorCatalogQuoteSnapshot = {
  pricingBasis?: string | null;
  purchaseUom?: string | null;
  piecesPerPurchaseUom?: number | null;
  quotedUnitCostMills?: number | null;
  unitCostMills?: number | null;
  unitCostCents?: number | null;
  quoteReference?: string | null;
  quotedAt?: string | Date | null;
  quoteValidUntil?: string | null;
};

export type VendorCatalogQuoteDraft = {
  state: "explicit" | "review_required";
  reviewReason: "legacy_unknown" | "incomplete_explicit" | null;
  basis: VendorCatalogQuoteBasis;
  unitPriceDollars: string;
  purchaseUom: string;
  piecesPerUom: string;
  pricePerUomDollars: string;
  quoteReference: string;
  quotedAt: string;
  quoteValidUntil: string;
  legacyNormalizedMills: number | null;
};

export type VendorCatalogQuotePricing =
  | PerPiecePricingInput
  | PerPurchaseUomPricingInput;

export type VendorCatalogQuoteWrite = {
  pricing?: VendorCatalogQuotePricing;
  quoteReference?: string | null;
  quotedAt?: string;
  quoteValidUntil?: string | null;
};

export type VendorCatalogQuoteEvaluation = {
  pricing: VendorCatalogQuotePricing | null;
  normalized: NormalizedPoLinePricing | null;
  error: string | null;
};

const PG_INTEGER_MAX = 2_147_483_647;

function localDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateOnly(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value == null ? "" : String(value).slice(0, 10);
}

function timestampString(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value == null || String(value).trim() === "") return null;
  return String(value);
}

function realDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizedLegacyMills(snapshot: VendorCatalogQuoteSnapshot): number | null {
  const mills = snapshot.unitCostMills != null
    ? Number(snapshot.unitCostMills)
    : snapshot.unitCostCents != null
      ? Number(snapshot.unitCostCents) * 100
      : null;
  return mills != null && Number.isSafeInteger(mills) && mills >= 0 ? mills : null;
}

function safeQuotedMills(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const mills = Number(value);
  return Number.isSafeInteger(mills) && mills >= 0 ? mills : null;
}

function explicitDraftDefaults(quotedAt: string): VendorCatalogQuoteDraft {
  return {
    state: "explicit",
    reviewReason: null,
    basis: "per_piece",
    unitPriceDollars: "",
    purchaseUom: "case",
    piecesPerUom: "1",
    pricePerUomDollars: "",
    quoteReference: "",
    quotedAt,
    quoteValidUntil: "",
    legacyNormalizedMills: null,
  };
}

export function createNewVendorCatalogQuoteDraft(
  quotedAt: Date = new Date(),
): VendorCatalogQuoteDraft {
  return explicitDraftDefaults(localDateOnly(quotedAt));
}

export function createVendorCatalogQuoteDraft(
  snapshot: VendorCatalogQuoteSnapshot,
): VendorCatalogQuoteDraft {
  const shared = {
    quoteReference: snapshot.quoteReference ?? "",
    quotedAt: dateOnly(snapshot.quotedAt),
    quoteValidUntil: dateOnly(snapshot.quoteValidUntil),
    legacyNormalizedMills: normalizedLegacyMills(snapshot),
  };

  if (snapshot.pricingBasis === "per_piece") {
    const quotedMills = safeQuotedMills(snapshot.quotedUnitCostMills);
    if (quotedMills !== null) {
      return {
        ...explicitDraftDefaults(shared.quotedAt),
        ...shared,
        basis: "per_piece",
        unitPriceDollars: millsToDollarString(quotedMills),
      };
    }
  }

  if (snapshot.pricingBasis === "per_purchase_uom") {
    const quotedMills = safeQuotedMills(snapshot.quotedUnitCostMills);
    const pieces = Number(snapshot.piecesPerPurchaseUom);
    const purchaseUom = snapshot.purchaseUom?.trim() ?? "";
    if (
      quotedMills !== null &&
      Number.isInteger(pieces) &&
      pieces > 0 &&
      pieces <= PG_INTEGER_MAX &&
      purchaseUom.length > 0
    ) {
      return {
        ...explicitDraftDefaults(shared.quotedAt),
        ...shared,
        basis: "per_purchase_uom",
        purchaseUom,
        piecesPerUom: String(pieces),
        pricePerUomDollars: millsToDollarString(quotedMills),
      };
    }
  }

  return {
    ...explicitDraftDefaults(""),
    ...shared,
    state: "review_required",
    reviewReason:
      snapshot.pricingBasis === "legacy_unknown" || !snapshot.pricingBasis
        ? "legacy_unknown"
        : "incomplete_explicit",
  };
}

export function beginVendorCatalogQuoteReview(
  draft: VendorCatalogQuoteDraft,
  quotedAt: Date = new Date(),
): VendorCatalogQuoteDraft {
  // A legacy normalized cost is deliberately not copied into either quote
  // amount. The operator must identify how the supplier actually quoted it.
  return {
    ...explicitDraftDefaults(localDateOnly(quotedAt)),
    quoteReference: draft.quoteReference,
    quoteValidUntil: draft.quoteValidUntil,
    legacyNormalizedMills: draft.legacyNormalizedMills,
  };
}

function positivePgInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > PG_INTEGER_MAX) {
    throw new Error(`${label} must be between 1 and ${PG_INTEGER_MAX.toLocaleString("en-US")}.`);
  }
  return parsed;
}

function fourDecimalMills(value: string, label: string): number {
  if (!/^\d+(?:\.\d{0,4})?$/.test(value)) {
    throw new Error(`${label} must be a dollar amount with up to 4 decimal places.`);
  }
  return dollarsToMills(value);
}

export function evaluateVendorCatalogQuoteDraft(
  draft: VendorCatalogQuoteDraft,
  evaluatedAt: Date = new Date(),
): VendorCatalogQuoteEvaluation {
  if (draft.state === "review_required") {
    return {
      pricing: null,
      normalized: null,
      error: "Review the supplier's original quote basis before replacing this catalog price.",
    };
  }

  try {
    if (!realDateOnly(draft.quotedAt)) {
      throw new Error("Quote date is required and must be a real date.");
    }
    if (draft.quotedAt > localDateOnly(evaluatedAt)) {
      throw new Error("Quote date cannot be in the future.");
    }
    if (draft.quoteValidUntil) {
      if (!realDateOnly(draft.quoteValidUntil)) {
        throw new Error("Valid-until date must be a real date.");
      }
      if (draft.quoteValidUntil < draft.quotedAt) {
        throw new Error("Valid-until date cannot be earlier than the quote date.");
      }
    }
    if (draft.quoteReference.trim().length > 255) {
      throw new Error("Quote reference must be 255 characters or fewer.");
    }

    let pricing: VendorCatalogQuotePricing;
    if (draft.basis === "per_piece") {
      pricing = {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: fourDecimalMills(draft.unitPriceDollars, "Price per piece"),
      };
    } else {
      const purchaseUom = draft.purchaseUom.trim();
      if (!purchaseUom) throw new Error("Purchase UOM is required.");
      if (purchaseUom.length > 50) throw new Error("Purchase UOM must be 50 characters or fewer.");
      pricing = {
        basis: "per_purchase_uom",
        purchaseUom,
        uomQuantity: 1,
        piecesPerUom: positivePgInteger(draft.piecesPerUom, "Pieces per purchase UOM"),
        quotedCostMillsPerUom: fourDecimalMills(
          draft.pricePerUomDollars,
          "Price per purchase UOM",
        ),
      };
    }

    return {
      pricing,
      normalized: normalizePoLinePricing(pricing),
      error: null,
    };
  } catch (error) {
    return {
      pricing: null,
      normalized: null,
      error: error instanceof Error ? error.message : "Enter a valid reusable supplier quote.",
    };
  }
}

function pricingFromSnapshot(
  snapshot: VendorCatalogQuoteSnapshot,
): VendorCatalogQuotePricing | null {
  const quotedMills = safeQuotedMills(snapshot.quotedUnitCostMills);
  if (quotedMills === null) return null;
  if (snapshot.pricingBasis === "per_piece") {
    return { basis: "per_piece", quantityPieces: 1, unitCostMills: quotedMills };
  }
  if (snapshot.pricingBasis === "per_purchase_uom") {
    const purchaseUom = snapshot.purchaseUom?.trim() ?? "";
    const piecesPerUom = Number(snapshot.piecesPerPurchaseUom);
    if (!purchaseUom || !Number.isInteger(piecesPerUom) || piecesPerUom <= 0) return null;
    return {
      basis: "per_purchase_uom",
      purchaseUom,
      uomQuantity: 1,
      piecesPerUom,
      quotedCostMillsPerUom: quotedMills,
    };
  }
  return null;
}

function samePricing(
  left: VendorCatalogQuotePricing,
  right: VendorCatalogQuotePricing,
): boolean {
  if (left.basis !== right.basis) return false;
  if (left.basis === "per_piece" && right.basis === "per_piece") {
    return left.unitCostMills === right.unitCostMills;
  }
  if (left.basis === "per_purchase_uom" && right.basis === "per_purchase_uom") {
    return left.purchaseUom === right.purchaseUom &&
      left.piecesPerUom === right.piecesPerUom &&
      left.quotedCostMillsPerUom === right.quotedCostMillsPerUom;
  }
  return false;
}

/**
 * Build only the quote fields that are safe to send.
 *
 * - New or reviewed mappings always send explicit reusable pricing.
 * - Non-price edits to an existing mapping return an empty object.
 * - Metadata-only corrections send only the changed metadata and therefore
 *   never refresh quotedAt as a side effect.
 */
export function buildVendorCatalogQuoteWrite(
  draft: VendorCatalogQuoteDraft,
  original?: VendorCatalogQuoteSnapshot | null,
  evaluatedAt: Date = new Date(),
): VendorCatalogQuoteWrite {
  if (draft.state === "review_required") {
    if (original) return {};
    throw new Error("Review and enter an explicit reusable supplier quote.");
  }

  const evaluation = evaluateVendorCatalogQuoteDraft(draft, evaluatedAt);
  if (!evaluation.pricing) {
    throw new Error(evaluation.error ?? "Enter a valid reusable supplier quote.");
  }

  const originalPricing = original ? pricingFromSnapshot(original) : null;
  const economicsChanged = !originalPricing || !samePricing(evaluation.pricing, originalPricing);
  const quoteReference = draft.quoteReference.trim() || null;
  const quoteValidUntil = draft.quoteValidUntil || null;

  if (!original || !originalPricing || economicsChanged) {
    const originalQuotedAt = timestampString(original?.quotedAt);
    const quotedAt = originalQuotedAt && dateOnly(original?.quotedAt) === draft.quotedAt
      ? originalQuotedAt
      : draft.quotedAt;
    return {
      pricing: evaluation.pricing,
      quoteReference,
      quotedAt,
      quoteValidUntil,
    };
  }

  const write: VendorCatalogQuoteWrite = {};
  if (quoteReference !== (original.quoteReference?.trim() || null)) {
    write.quoteReference = quoteReference;
  }
  if (draft.quotedAt !== dateOnly(original.quotedAt)) {
    write.quotedAt = draft.quotedAt;
  }
  if (quoteValidUntil !== (dateOnly(original.quoteValidUntil) || null)) {
    write.quoteValidUntil = quoteValidUntil;
  }
  return write;
}

export type VendorCatalogQuoteSummary = {
  amount: string;
  detail: string;
  reviewRequired: boolean;
};

export function formatVendorCatalogQuoteSummary(
  snapshot: VendorCatalogQuoteSnapshot,
): VendorCatalogQuoteSummary {
  const pricing = pricingFromSnapshot(snapshot);
  if (pricing?.basis === "per_piece") {
    return {
      amount: `${formatMills(pricing.unitCostMills)} per piece`,
      detail: snapshot.quoteReference ? `Quote ${snapshot.quoteReference}` : "Reusable supplier quote",
      reviewRequired: false,
    };
  }
  if (pricing?.basis === "per_purchase_uom") {
    const normalized = normalizePoLinePricing(pricing);
    return {
      amount: `${formatMills(pricing.quotedCostMillsPerUom)} per ${pricing.purchaseUom}`,
      detail: `${pricing.piecesPerUom.toLocaleString()} pieces per ${pricing.purchaseUom} · ${formatMills(normalized.unitCostMills)} per piece`,
      reviewRequired: false,
    };
  }

  const legacyMills = normalizedLegacyMills(snapshot);
  return {
    amount: legacyMills === null ? "No verified quote" : `${formatMills(legacyMills)} normalized cost`,
    detail: snapshot.pricingBasis === "legacy_unknown" || !snapshot.pricingBasis
      ? "Quote basis unknown — review required"
      : "Stored quote is incomplete — review required",
    reviewRequired: true,
  };
}

function moneyInput(onChange: (next: string) => void) {
  return (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (next === "" || /^\d*(?:\.\d{0,4})?$/.test(next)) onChange(next);
  };
}

export function VendorCatalogQuoteEditor({
  value,
  onChange,
  className = "",
}: {
  value: VendorCatalogQuoteDraft;
  onChange: (next: VendorCatalogQuoteDraft) => void;
  className?: string;
}) {
  const set = <K extends keyof VendorCatalogQuoteDraft>(
    key: K,
    next: VendorCatalogQuoteDraft[K],
  ) => onChange({ ...value, [key]: next });

  if (value.state === "review_required") {
    return (
      <div className={`rounded-md border border-amber-300 bg-amber-50 p-3 space-y-3 ${className}`}>
        <div>
          <div className="font-medium text-amber-900">Supplier quote review required</div>
          <p className="text-xs text-amber-800 mt-1">
            {value.reviewReason === "legacy_unknown"
              ? "This legacy mapping has a normalized cost but no recorded quote basis. It will remain unchanged unless you replace it with a verified quote."
              : "This mapping claims an explicit quote basis but is missing required quote details. Review it before replacing the stored economics."}
          </p>
          {value.legacyNormalizedMills !== null && (
            <p className="text-xs text-amber-900 mt-2 font-mono">
              Existing normalized cost: {formatMills(value.legacyNormalizedMills)} per piece
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(beginVendorCatalogQuoteReview(value))}
        >
          Review and replace quote
        </Button>
      </div>
    );
  }

  const evaluation = evaluateVendorCatalogQuoteDraft(value);
  const normalized = evaluation.normalized;

  return (
    <div className={`space-y-4 rounded-md border p-3 ${className}`}>
      <div>
        <div className="font-medium">Reusable supplier quote</div>
        <p className="text-xs text-muted-foreground mt-1">
          Record the quote exactly as the supplier issued it. Echelon derives the normalized per-piece cost.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Quote basis *</Label>
        <Select
          value={value.basis}
          onValueChange={(basis) => set("basis", basis as VendorCatalogQuoteBasis)}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="per_piece">Price per piece</SelectItem>
            <SelectItem value="per_purchase_uom">Price per case or pack</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value.basis === "per_piece" ? (
        <div className="space-y-2">
          <Label>Price per piece ($) *</Label>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="2.6320"
            value={value.unitPriceDollars}
            onChange={moneyInput((next) => set("unitPriceDollars", next))}
          />
          <p className="text-xs text-muted-foreground">Up to four decimal places</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Purchase UOM *</Label>
            <Input
              value={value.purchaseUom}
              onChange={(event) => set("purchaseUom", event.target.value)}
              placeholder="case, pack, carton..."
            />
          </div>
          <div className="space-y-2">
            <Label>Pieces per purchase UOM *</Label>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={value.piecesPerUom}
              onChange={(event) => set("piecesPerUom", event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Price per purchase UOM ($) *</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="63.1700"
              value={value.pricePerUomDollars}
              onChange={moneyInput((next) => set("pricePerUomDollars", next))}
            />
            <p className="text-xs text-muted-foreground">Up to four decimal places</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label>Quote reference</Label>
          <Input
            maxLength={255}
            value={value.quoteReference}
            onChange={(event) => set("quoteReference", event.target.value)}
            placeholder="Quote # or email"
          />
        </div>
        <div className="space-y-2">
          <Label>Quote date *</Label>
          <Input
            type="date"
            value={value.quotedAt}
            onChange={(event) => set("quotedAt", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Valid until</Label>
          <Input
            type="date"
            min={value.quotedAt || undefined}
            value={value.quoteValidUntil}
            onChange={(event) => set("quoteValidUntil", event.target.value)}
          />
        </div>
      </div>

      {normalized ? (
        <div className="rounded-md bg-muted/40 p-3 text-sm" aria-live="polite">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            <span className="text-muted-foreground">Supplier quote</span>
            <span className="text-right font-mono">
              {value.basis === "per_piece"
                ? `${formatMills(normalized.quotedUnitCostMills)} per piece`
                : `${formatMills(normalized.quotedUnitCostMills)} per ${normalized.purchaseUom}`}
            </span>
            {value.basis === "per_purchase_uom" && (
              <>
                <span className="text-muted-foreground">Purchase UOM contains</span>
                <span className="text-right">{normalized.orderQty.toLocaleString()} pieces</span>
              </>
            )}
            <span className="font-medium">Normalized cost</span>
            <span className="text-right font-mono font-medium">{formatMills(normalized.unitCostMills)} per piece</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-amber-700" aria-live="polite">{evaluation.error}</p>
      )}
    </div>
  );
}
