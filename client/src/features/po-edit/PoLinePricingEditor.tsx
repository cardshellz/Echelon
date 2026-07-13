import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
  type PoLinePricingBasis,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import {
  dollarsToCents,
  dollarsToMills,
  formatMills,
  millsToDollarString,
} from "@shared/utils/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

export type PoLinePricingEditorDraft = {
  basis: PoLinePricingBasis;
  quantityPieces: string;
  unitPriceDollars: string;
  purchaseUom: string;
  uomQuantity: string;
  piecesPerUom: string;
  pricePerUomDollars: string;
  quotedTotalDollars: string;
};

export type PoLinePricingEvaluation = {
  pricing: PoLinePricingInput | null;
  normalized: NormalizedPoLinePricing | null;
  error: string | null;
};

const PG_INTEGER_MAX = 2_147_483_647;

export function createEmptyPoLinePricingDraft(
  initial?: Partial<PoLinePricingEditorDraft>,
): PoLinePricingEditorDraft {
  return {
    basis: "per_piece",
    quantityPieces: "1",
    unitPriceDollars: "",
    purchaseUom: "case",
    uomQuantity: "1",
    piecesPerUom: "1",
    pricePerUomDollars: "",
    quotedTotalDollars: "",
    ...initial,
  };
}

export function createPerPiecePricingDraft(
  quantityPieces: number,
  unitCostMills: number,
): PoLinePricingEditorDraft {
  return createEmptyPoLinePricingDraft({
    basis: "per_piece",
    quantityPieces: String(quantityPieces),
    unitPriceDollars: millsToDollarString(unitCostMills),
  });
}

export type VendorCatalogPricingSnapshot = {
  pricingBasis?: string | null;
  purchaseUom?: string | null;
  piecesPerPurchaseUom?: number | null;
  quotedUnitCostMills?: number | null;
  unitCostMills?: number | null;
  unitCostCents?: number | null;
  moq?: number | null;
  quotedAt?: string | Date | null;
  quoteValidUntil?: string | null;
};

export type VendorCatalogQuoteStatus =
  | "usable"
  | "legacy"
  | "unverified"
  | "future"
  | "expired"
  | "stale";

/**
 * Client-side catalog freshness hint. The server repeats this decision using
 * its own clock while holding the catalog row lock; this helper prevents the
 * editor from presenting a known stale quote as trusted automation.
 */
export function vendorCatalogQuoteStatus(
  entry: VendorCatalogPricingSnapshot,
  evaluatedAt: Date = new Date(),
): VendorCatalogQuoteStatus {
  if (entry.pricingBasis !== "per_piece" && entry.pricingBasis !== "per_purchase_uom") {
    return "legacy";
  }
  const quotedAt = entry.quotedAt instanceof Date
    ? entry.quotedAt
    : new Date(String(entry.quotedAt ?? ""));
  if (Number.isNaN(quotedAt.getTime())) return "unverified";
  if (quotedAt.getTime() > evaluatedAt.getTime() + 5 * 60 * 1_000) return "future";

  const today = evaluatedAt.toISOString().slice(0, 10);
  if (entry.quoteValidUntil != null) {
    const validUntil = String(entry.quoteValidUntil).slice(0, 10);
    const parsedValidUntil = new Date(`${validUntil}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(validUntil) ||
      Number.isNaN(parsedValidUntil.getTime()) ||
      parsedValidUntil.toISOString().slice(0, 10) !== validUntil
    ) {
      return "unverified";
    }
    return validUntil < today ? "expired" : "usable";
  }

  return evaluatedAt.getTime() - quotedAt.getTime() > 365 * 24 * 60 * 60 * 1_000
    ? "stale"
    : "usable";
}

export function isVendorCatalogQuoteReusable(
  entry: VendorCatalogPricingSnapshot,
  evaluatedAt?: Date,
): boolean {
  return vendorCatalogQuoteStatus(entry, evaluatedAt) === "usable";
}

function catalogMills(entry: VendorCatalogPricingSnapshot): number {
  if (entry.quotedUnitCostMills != null) return Number(entry.quotedUnitCostMills);
  if (entry.unitCostMills != null) return Number(entry.unitCostMills);
  return Number(entry.unitCostCents ?? 0) * 100;
}

/** Build an editor draft from the vendor-facing basis stored on a catalog row. */
export function createVendorCatalogPricingDraft(
  entry: VendorCatalogPricingSnapshot,
): PoLinePricingEditorDraft {
  const minimumPieces = Math.max(1, Number(entry.moq) || 1);
  if (entry.pricingBasis === "per_purchase_uom") {
    const piecesPerUom = Math.max(1, Number(entry.piecesPerPurchaseUom) || 1);
    return createEmptyPoLinePricingDraft({
      basis: "per_purchase_uom",
      purchaseUom: entry.purchaseUom?.trim() || "case",
      uomQuantity: String(Math.max(1, Math.ceil(minimumPieces / piecesPerUom))),
      piecesPerUom: String(piecesPerUom),
      pricePerUomDollars: millsToDollarString(catalogMills(entry)),
    });
  }

  if (entry.pricingBasis === "per_piece") {
    return createPerPiecePricingDraft(minimumPieces, catalogMills(entry));
  }

  // A legacy normalized cost is not evidence that the supplier quoted per
  // piece. Keep the amount blank so choosing a legacy catalog row cannot
  // silently manufacture quote provenance; the operator must identify and
  // enter the original quote basis and amount.
  return createEmptyPoLinePricingDraft({
    basis: "per_piece",
    quantityPieces: String(minimumPieces),
    unitPriceDollars: "",
  });
}

export function formatVendorCatalogQuote(
  entry: VendorCatalogPricingSnapshot,
): string {
  const amount = formatMills(catalogMills(entry));
  if (entry.pricingBasis !== "per_piece" && entry.pricingBasis !== "per_purchase_uom") {
    return `${amount} normalized cost (quote basis unknown)`;
  }
  return entry.pricingBasis === "per_purchase_uom"
    ? `${amount} per ${entry.purchaseUom?.trim() || "purchase UOM"}`
    : `${amount} per piece`;
}

export function receiveConfigurationQuantitySummary(
  quantityPieces: number,
  unitsPerVariant: number,
): string {
  const pieces = Math.max(0, Math.floor(Number(quantityPieces) || 0));
  const receiveUnits = Math.max(1, Math.floor(Number(unitsPerVariant) || 1));
  if (receiveUnits === 1) {
    return `${pieces.toLocaleString()} individual ${pieces === 1 ? "piece" : "pieces"}`;
  }

  const fullConfigurations = Math.floor(pieces / receiveUnits);
  const loosePieces = pieces % receiveUnits;
  const parts: string[] = [];
  if (fullConfigurations > 0) {
    parts.push(
      `${fullConfigurations.toLocaleString()} full ${fullConfigurations === 1 ? "configuration" : "configurations"} at ${receiveUnits.toLocaleString()} pieces each`,
    );
  }
  if (loosePieces > 0) {
    parts.push(`${loosePieces.toLocaleString()} loose ${loosePieces === 1 ? "piece" : "pieces"}`);
  }
  return parts.join(" plus ") || "0 pieces";
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > PG_INTEGER_MAX) {
    throw new Error(`${label} must be between 1 and ${PG_INTEGER_MAX.toLocaleString("en-US")}.`);
  }
  return parsed;
}

function requiredMoney(
  value: string,
  decimalPlaces: 2 | 4,
  label: string,
): number {
  const pattern = decimalPlaces === 4
    ? /^\d+(?:\.\d{0,4})?$/
    : /^\d+(?:\.\d{0,2})?$/;
  if (!value || !pattern.test(value)) {
    throw new Error(`${label} must be a dollar amount with up to ${decimalPlaces} decimal places.`);
  }
  return decimalPlaces === 4 ? dollarsToMills(value) : dollarsToCents(value);
}

export function evaluatePoLinePricingDraft(
  draft: PoLinePricingEditorDraft,
): PoLinePricingEvaluation {
  try {
    let pricing: PoLinePricingInput;
    if (draft.basis === "per_piece") {
      pricing = {
        basis: "per_piece",
        quantityPieces: positiveInteger(draft.quantityPieces, "Ordered pieces"),
        unitCostMills: requiredMoney(
          draft.unitPriceDollars,
          4,
          "Price per piece",
        ),
      };
    } else if (draft.basis === "per_purchase_uom") {
      if (!draft.purchaseUom.trim()) {
        throw new Error("Purchase UOM is required.");
      }
      pricing = {
        basis: "per_purchase_uom",
        purchaseUom: draft.purchaseUom.trim(),
        uomQuantity: positiveInteger(draft.uomQuantity, "Purchase UOM quantity"),
        piecesPerUom: positiveInteger(draft.piecesPerUom, "Pieces per purchase UOM"),
        quotedCostMillsPerUom: requiredMoney(
          draft.pricePerUomDollars,
          4,
          "Price per purchase UOM",
        ),
      };
    } else {
      pricing = {
        basis: "extended_total",
        quantityPieces: positiveInteger(draft.quantityPieces, "Quoted pieces"),
        quotedTotalCents: requiredMoney(
          draft.quotedTotalDollars,
          2,
          "Quoted total",
        ),
      };
    }

    const normalized = normalizePoLinePricing(pricing);
    if (normalized.orderQty > PG_INTEGER_MAX) {
      throw new Error(`Ordered pieces must not exceed ${PG_INTEGER_MAX.toLocaleString("en-US")}.`);
    }

    return { pricing, normalized, error: null };
  } catch (error) {
    return {
      pricing: null,
      normalized: null,
      error: error instanceof Error ? error.message : "Enter a valid vendor quote.",
    };
  }
}

export function changePoLinePricingQuantity(
  draft: PoLinePricingEditorDraft,
  quantityPieces: string,
): PoLinePricingEditorDraft {
  return {
    ...draft,
    quantityPieces,
    ...(draft.basis === "extended_total" && quantityPieces !== draft.quantityPieces
      ? { quotedTotalDollars: "" }
      : {}),
  };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyInput(
  value: string,
  decimalPlaces: 2 | 4,
  onChange: (next: string) => void,
) {
  return (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    const pattern = decimalPlaces === 4
      ? /^\d*(?:\.\d{0,4})?$/
      : /^\d*(?:\.\d{0,2})?$/;
    if (next === "" || pattern.test(next)) onChange(next);
  };
}

function quoteSummary(
  draft: PoLinePricingEditorDraft,
  normalized: NormalizedPoLinePricing,
): string {
  if (draft.basis === "per_piece") {
    return `${formatMills(normalized.quotedUnitCostMills)} per piece x ${normalized.orderQty.toLocaleString()}`;
  }
  if (draft.basis === "per_purchase_uom") {
    return `${formatMills(normalized.quotedUnitCostMills)} per ${normalized.purchaseUom} x ${normalized.purchaseUomQuantity?.toLocaleString()}`;
  }
  return `${formatCents(normalized.quotedTotalCents ?? 0)} for ${normalized.orderQty.toLocaleString()} pieces`;
}

export function PoLinePricingEditor({
  value,
  onChange,
  receiveConfiguration,
  className = "",
}: {
  value: PoLinePricingEditorDraft;
  onChange: (next: PoLinePricingEditorDraft) => void;
  receiveConfiguration?: {
    label?: string | null;
    unitsPerVariant?: number | null;
  };
  className?: string;
}) {
  const evaluation = evaluatePoLinePricingDraft(value);
  const normalized = evaluation.normalized;
  const set = <K extends keyof PoLinePricingEditorDraft>(
    key: K,
    next: PoLinePricingEditorDraft[K],
  ) => onChange({ ...value, [key]: next });
  const setQuantityPieces = (next: string) => {
    onChange(changePoLinePricingQuantity(value, next));
  };
  const receiveUnits = Math.max(1, Number(receiveConfiguration?.unitsPerVariant) || 1);
  const receiveConfigSummary = normalized
    ? receiveConfigurationQuantitySummary(normalized.orderQty, receiveUnits)
    : null;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="space-y-2">
        <Label>How did the vendor quote this? *</Label>
        <Select
          value={value.basis}
          onValueChange={(basis) => set("basis", basis as PoLinePricingBasis)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per_piece">Price per item</SelectItem>
            <SelectItem value="per_purchase_uom">Price per case or pack</SelectItem>
            <SelectItem value="extended_total">Total for a quoted quantity</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Enter the quote exactly as the supplier gave it. Echelon normalizes the cost automatically.
        </p>
      </div>

      {value.basis === "per_piece" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Ordered pieces *</Label>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={value.quantityPieces}
              onChange={(event) => setQuantityPieces(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Price per piece ($) *</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="2.6320"
              value={value.unitPriceDollars}
              onChange={moneyInput(value.unitPriceDollars, 4, (next) => set("unitPriceDollars", next))}
            />
            <p className="text-xs text-muted-foreground">Up to four decimal places</p>
          </div>
        </div>
      )}

      {value.basis === "per_purchase_uom" && (
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
            <Label>Number of purchase UOMs *</Label>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={value.uomQuantity}
              onChange={(event) => set("uomQuantity", event.target.value)}
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
          <div className="space-y-2">
            <Label>Price per purchase UOM ($) *</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="63.1700"
              value={value.pricePerUomDollars}
              onChange={moneyInput(value.pricePerUomDollars, 4, (next) => set("pricePerUomDollars", next))}
            />
            <p className="text-xs text-muted-foreground">Up to four decimal places</p>
          </div>
        </div>
      )}

      {value.basis === "extended_total" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Quoted pieces *</Label>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={value.quantityPieces}
              onChange={(event) => setQuantityPieces(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Quoted total ($) *</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="263.17"
              value={value.quotedTotalDollars}
              onChange={moneyInput(value.quotedTotalDollars, 2, (next) => set("quotedTotalDollars", next))}
            />
            <p className="text-xs text-muted-foreground">Exact supplier total for this quantity</p>
          </div>
        </div>
      )}

      {normalized ? (
        <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm" aria-live="polite">
          <div className="font-medium">Pricing summary</div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            <span className="text-muted-foreground">Ordered pieces</span>
            <span className="text-right font-mono">{normalized.orderQty.toLocaleString()}</span>
            <span className="text-muted-foreground">Vendor quote</span>
            <span className="text-right">{quoteSummary(value, normalized)}</span>
            <span className="text-muted-foreground">Normalized cost</span>
            <span className="text-right font-mono">{formatMills(normalized.unitCostMills)} per piece</span>
            <span className="font-medium">Product total</span>
            <span className="text-right font-mono font-medium">{formatCents(normalized.totalProductCostCents)}</span>
          </div>
          {normalized.pricingRemainderMills !== 0 && (
            <p className="text-xs text-muted-foreground">
              The supplier total cannot divide evenly by piece; Echelon will preserve the exact total and track the rounding difference.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-amber-700" aria-live="polite">{evaluation.error}</p>
      )}

      {receiveConfiguration && (
        <>
          <Separator />
          <div className="rounded-md border p-3 space-y-1 text-sm">
            <div className="font-medium">Receiving configuration</div>
            <p className="text-xs text-muted-foreground">
              This controls how the warehouse receives the product. It is independent of the supplier's purchase UOM.
            </p>
            <div className="pt-1">
              <span>{receiveConfiguration.label || "Selected product configuration"}</span>
              {receiveConfigSummary !== null && (
                <span className="text-muted-foreground">
                  {` — ${receiveConfigSummary}`}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
