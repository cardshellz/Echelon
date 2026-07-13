// PurchaseOrderEdit.tsx
//
// Full-page PO editor for Spec A. Mounts at /purchase-orders/new and
// /purchase-orders/:id/edit (the :id path is the drafts-only editor). Reuses
// existing Echelon primitives — do NOT introduce new button/input components.
//
// Layout (per spec §4):
//   Header: title + Save draft + Save & Send PDF + Cancel
//   Vendor section: combobox typeahead + terms strip
//   Lines editor: inline rows with product typeahead, qty, unit cost, total
//   Totals: subtotal computed
//   Advanced collapsible: PO type, priority, expected delivery, incoterms
//       (incoterms only rendered when vendor.country !== 'US' AND
//       hide_incoterms_domestic === false), vendor notes, internal notes.
//
// Keyboard (per spec §14):
//   Cmd+S   — Save draft
//   Cmd+Enter — Save & Send PDF
//   Esc     — Cancel (with confirm if dirty)
//
// Per-unit cost carries 4-decimal precision via mills (1/10000 of a dollar).
// Everything else (line totals, PO totals) stays in cents. Floats are never
// used for currency.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  dollarsToCents,
  dollarsToMills,
  millsToDollarString,
  formatMills,
  millsToCents,
  centsToMills,
  computeLineTotalCentsFromMills,
} from "@shared/utils/money";
import { PoLineType, PO_LINE_TYPES } from "@shared/schema/procurement.schema";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ChevronsUpDown,
  Check,
  Trash2,
  Plus,
  ShoppingCart,
  AlertCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AddToCatalogDialog,
  type AddToCatalogDecision,
  type CatalogCandidate,
} from "@/features/po-edit/AddToCatalogDialog";
import {
  PoLinePricingEditor,
  createEmptyPoLinePricingDraft,
  createPerPiecePricingDraft,
  createVendorCatalogPricingDraft,
  evaluatePoLinePricingDraft,
  formatVendorCatalogQuote,
  isVendorCatalogQuoteReusable,
  vendorCatalogQuoteStatus,
  type PoLinePricingEditorDraft,
} from "@/features/po-edit/PoLinePricingEditor";
import {
  PoLineQuoteMetadataEditor,
  evaluatePoLineQuoteMetadataDraft,
  type PoLineQuoteMetadataDraft,
} from "@/features/po-edit/PoLineQuoteMetadataEditor";
import {
  canUseFullPurchaseOrderEditor,
  isImmutableRecommendationPurchaseOrder,
} from "@/features/po-edit/purchase-order-editability";

// ─── Types ─────────────────────────────────────────────────────────────────

type Vendor = {
  id: number;
  name: string;
  code: string;
  country?: string | null;
  defaultIncoterms?: string | null;
  paymentTermsDays?: number | null;
  paymentTermsType?: string | null;
  leadTimeDays?: number | null;
};

type ProductVariantLite = {
  id: number;
  productId: number;
  sku: string | null;
  name: string | null;
};

type ProductLite = {
  id: number;
  name: string;
  sku?: string | null;
  variants?: ProductVariantLite[];
};

type PricingSource = "legacy" | "manual" | "vendor_catalog" | "recommendation";

type LineDraft = {
  // Stable database identity for a line loaded from an existing draft.
  // New client-only lines remain null until the draft update returns their ids.
  serverLineId: number | null;
  // Client-local id for React keys and request-time parent-line resolution.
  clientId: string;
  // Line taxonomy (migration 0563). One of PO_LINE_TYPES. Default: "product".
  lineType: PoLineType;
  // Required for non-product lines; optional for product lines.
  description: string;
  // clientId of another line in this draft that this line "belongs to".
  // Only valid on discount/rebate lines. null means "applies to all product
  // lines" (no specific parent_line_id stored on the server).
  parentClientId: string | null;
  productVariantId: number | null;
  expectedReceiveVariantId: number | null;
  expectedReceiveUnitsPerVariant: number | null;
  productId: number | null;
  productName: string;
  sku: string | null;
  orderQty: number;
  // The vendor quote in the form in which it was issued. Product quantity,
  // normalized per-piece cost, and exact product total are all derived from
  // this draft. Non-product lines intentionally leave it null and retain
  // their existing signed-money behavior.
  pricingDraft: PoLinePricingEditorDraft | null;
  // Existing legacy_unknown lines expose a convenience pricing draft without
  // changing their persisted provenance on an unrelated save. This flips to
  // true only for stored explicit pricing or after the operator edits/confirms
  // the quote.
  hasExplicitPricing: boolean;
  preserveLegacyPricing: boolean;
  pricingSource: PricingSource | null;
  quoteReference: string | null;
  quotedAt: string | null;
  quoteValidUntil: string | null;
  // Per-unit cost in mills (1/10000 of a dollar). Computed-derived for
  // product lines (from totalProductCostCents / qty). Still source of
  // truth for non-product lines (fee, discount, etc.).
  // Signed: discount/rebate/adjustment lines may carry a negative value.
  unitCostMills: number;
  // Totals-based cost (Spec F Phase 1). Source of truth for product lines.
  // 0 or undefined for non-product lines.
  totalProductCostCents?: number;
  packagingCostCents?: number;
  vendorProductId?: number | null;
  // Spec A follow-up: tracks whether the selected product was NOT in the
  // vendor's catalog at the time of selection. Drives the "Add to catalog?"
  // modal on PO save. `null` for lines whose origin we don't know (e.g.
  // preloaded draft rows, legacy edit-mode rows).
  catalogOriginallyAbsent?: boolean | null;
};

// Spec A follow-up: vendor-scoped catalog-search response.
type CatalogSearchResponse = {
  inCatalog: Array<{
    vendorProductId: number;
    productId: number;
    productVariantId: number | null;
    receiveUnitsPerVariant: number | null;
    sku: string | null;
    productName: string;
    variantName: string | null;
    vendorSku: string | null;
    vendorProductName: string | null;
    unitCostCents: number;
    unitCostMills: number;
    pricingBasis?: string | null;
    purchaseUom?: string | null;
    piecesPerPurchaseUom?: number | null;
    quotedUnitCostMills?: number | null;
    quoteReference?: string | null;
    quotedAt?: string | null;
    quoteValidUntil?: string | null;
    packSize: number | null;
    moq: number | null;
    leadTimeDays: number | null;
    isPreferred: boolean;
  }>;
  outOfCatalog: Array<{
    productId: number;
    productVariantId: number | null;
    sku: string | null;
    productName: string;
    variantName: string | null;
  }>;
};

type PreloadResponse = {
  vendor: Vendor | null;
  lines: Array<{
    productId: number;
    productVariantId: number | null;
    expectedReceiveVariantId: number | null;
    expectedReceiveUnitsPerVariant: number;
    productName: string;
    sku: string | null;
    variantDescription: string | null;
    uomLabel: string | null;
    suggestedQty: number;
    unitCostCents: number;
    unitCostMills?: number;
    pricingBasis?: string | null;
    purchaseUom?: string | null;
    piecesPerPurchaseUom?: number | null;
    quotedUnitCostMills?: number | null;
    quoteReference?: string | null;
    quotedAt?: string | null;
    quoteValidUntil?: string | null;
    catalogSource: string;
    // Optional for compatibility with older preload responses. A catalog
    // quote is trusted as vendor_catalog provenance only when its row id is
    // present; otherwise the original quote basis is still shown as manual.
    vendorProductId?: number | null;
  }>;
  sourcePo: { poNumber: string; note: string } | null;
};

type ProcurementSettings = {
  requireApproval: boolean;
  autoSendOnApprove: boolean;
  requireAcknowledgeBeforeReceive: boolean;
  hideIncotermsDomestic: boolean;
  enableShipmentTracking: boolean;
  autoPutawayLocation: boolean;
  autoCloseOnReconcile: boolean;
  oneClickReceiveStart: boolean;
  useNewPoEditor: boolean;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

// (Legacy cents parse helpers removed; per-unit cost now uses the mills
// helpers imported from @shared/utils/money. Line totals are still
// displayed in cents via formatCents below.)

// Uncontrolled-ish quantity input. Same pattern as UnitCostInput below —
// keeps the raw typing buffer so backspace/delete don't bounce the caret and
// empty intermediate states ("") don't get coerced to 0 mid-type.
function QuantityInput({
  qty,
  onChangeQty,
  ariaLabel,
  className,
}: {
  qty: number;
  onChangeQty: (q: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [buffer, setBuffer] = useState<string>(() => (qty > 0 ? String(qty) : ""));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setBuffer(qty > 0 ? String(qty) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, focused]);

  return (
    <Input
      type="text"
      inputMode="numeric"
      value={buffer}
      className={className}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // Allow empty or digits only — no decimals, no negatives.
        if (raw === "" || /^\d+$/.test(raw)) {
          setBuffer(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(buffer || "0", 10);
        const next = Number.isFinite(n) && n > 0 ? n : 0;
        setBuffer(next > 0 ? String(next) : "");
        if (next !== qty) onChangeQty(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

// Uncontrolled-ish unit cost input (mills — 4-decimal precision).
//
// Problem this solves: if we render a normalized value on every keystroke,
// the input string gets rewritten mid-edit and the caret jumps. We keep the
// raw typing buffer locally and only coerce to integer mills on blur. The
// parent stays the source of truth for the mills value; when it changes
// (from preload, paste, etc.) and we're not focused, we re-sync the buffer.
//
// Typing rules:
//   * Accepts digits, a single dot, and up to 4 fractional digits.
//   * Rejects a 5th decimal at the keystroke level so the user always sees
//     exactly what will be stored (no silent rounding on blur).
//   * Empty / lone dot is allowed mid-edit — coerced to 0 on blur.
function UnitCostInput({
  mills,
  onChangeMills,
  ariaLabel,
  allowNegative = false,
}: {
  mills: number;
  onChangeMills: (mills: number) => void;
  ariaLabel: string;
  // Discount / rebate / adjustment lines may carry negative cost. The default
  // is false so the existing product-line behavior is unchanged (Rule #3 main
  // money path is non-negative). When true the buffer accepts a leading
  // minus and the parsed result preserves the sign.
  allowNegative?: boolean;
}) {
  const [buffer, setBuffer] = useState<string>(() =>
    signedMillsToDollarString(mills),
  );
  const [focused, setFocused] = useState(false);

  // When the parent's value changes from outside (preload, programmatic edit)
  // and we're not currently focused, pull the new value into the buffer.
  useEffect(() => {
    if (!focused) {
      setBuffer(signedMillsToDollarString(mills));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mills, focused]);

  // Typing-time regex: optional minus only when allowNegative; otherwise
  // unchanged from the original strict-non-negative behavior.
  const inputRegex = allowNegative
    ? /^-?\d*\.?\d{0,4}$/
    : /^\d*\.?\d{0,4}$/;

  return (
    <Input
      inputMode="decimal"
      value={buffer}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // digits + optional single dot + up to 4 fractional digits, with an
        // optional leading minus when allowNegative=true. Intermediate
        // states ("", ".", "5.", "-", "-.", "-5", "-5.1234") all match.
        if (raw === "" || inputRegex.test(raw)) {
          setBuffer(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        let nextMills = mills;
        try {
          nextMills = signedDollarsToMills(buffer);
          if (!allowNegative && nextMills < 0) {
            nextMills = 0; // safety net; should not happen given regex.
          }
        } catch {
          // Unparseable — revert to last known good.
          nextMills = mills;
        }
        setBuffer(signedMillsToDollarString(nextMills));
        if (nextMills !== mills) onChangeMills(nextMills);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

// Dollar input for total product cost (Spec F Phase 1).
// Works with integer cents (not mills). Accepts dollar strings like
// "11600.00" and converts to cents. 2 decimal places max.
function DollarInput({
  cents,
  onChangeCents,
  ariaLabel,
  className,
}: {
  cents: number;
  onChangeCents: (cents: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [buffer, setBuffer] = useState<string>(() =>
    cents > 0 ? (cents / 100).toFixed(2) : "",
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setBuffer(cents > 0 ? (cents / 100).toFixed(2) : "");
    }
  }, [cents, focused]);

  return (
    <Input
      inputMode="decimal"
      value={buffer}
      className={className}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // Allow digits, single dot, up to 2 fractional digits.
        if (/^\d*\.?\d{0,2}$/.test(raw) || raw === "") {
          setBuffer(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        try {
          const nextCents = dollarsToCents(buffer);
          setBuffer(nextCents > 0 ? (nextCents / 100).toFixed(2) : "");
          if (nextCents !== cents) onChangeCents(nextCents);
        } catch {
          setBuffer(cents > 0 ? (cents / 100).toFixed(2) : "");
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

function formatCents(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  return `$${(n / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── Signed money helpers ──────────────────────────────────────────────────
// Discount / rebate / adjustment lines carry negative unitCostMills. The
// shared money helpers reject negatives (they were designed for per-unit
// cost which is always >= 0). These wrappers handle the sign and delegate
// to the authoritative shared helpers for the magnitude.

// Compute per-unit mills from total cents and qty. Returns null when qty
// is 0 or not yet entered (prevents divide-by-zero). Pure integer math.
function perUnitMillsFromCents(totalCents: number, qty: number): number | null {
  if (!qty || qty <= 0) return null;
  const c = Number(totalCents) || 0;
  // totalCents * 100 = mills for the total; divide by qty = per-unit mills.
  // Use round-half-up at the mills level.
  const totalMills = c * 100;
  if (totalMills === 0) return 0;
  const q = Math.floor(totalMills / qty);
  const r = totalMills - q * qty;
  return r * 2 >= qty ? q + 1 : q;
}

// Full-precision per-unit dollar string (up to 6 decimal places).
// Used for tooltip display. Pure integer math, no floats.
function perUnitFullPrecisionDollars(millsValue: number | null): string {
  if (millsValue === null) return "—";
  const m = Math.max(0, Math.round(millsValue));
  // We want up to 6 decimals. mills is 4-decimal precision.
  // For the tooltip, show the exact mills value as a dollar string.
  const whole = Math.floor(m / 10000);
  const frac = m - whole * 10000;
  return `$${whole}.${String(frac).padStart(4, "0")}`;
}

// Per-unit display helper: returns "—" for null, "$X.XXXX" otherwise.
function formatPerUnit(millsValue: number | null): string {
  if (millsValue === null) return "—";
  return formatMills(Math.max(0, Math.round(millsValue)));
}

function signedMillsToDollarString(mills: number): string {
  if (mills < 0) return `-${millsToDollarString(-mills)}`;
  return millsToDollarString(mills);
}

function signedDollarsToMills(input: string): number {
  const raw = String(input).trim();
  if (!raw || raw === "-" || raw === "." || raw === "-.") return 0;
  if (raw.startsWith("-")) {
    return -(dollarsToMills(raw.slice(1)));
  }
  return dollarsToMills(raw);
}

function signedMillsToCents(mills: number): number {
  if (mills < 0) return -(millsToCents(-mills));
  return millsToCents(mills);
}

function signedComputeLineTotalCents(mills: number, qty: number): number {
  if (mills === 0 || qty === 0) return 0;
  if (mills < 0) return -(computeLineTotalCentsFromMills(-mills, qty));
  return computeLineTotalCentsFromMills(mills, qty);
}

function signedFormatCents(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  if (n < 0) {
    return `-$${((-n) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return formatCents(n);
}

function newClientId(): string {
  return `ln-${Math.random().toString(36).slice(2, 10)}`;
}

function centsToExactDollarString(cents: number): string {
  const safeCents = Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
  const whole = Math.floor(safeCents / 100);
  const fraction = safeCents % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

function optionalPositiveIntegerString(value: unknown): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : "";
}

function optionalNonnegativeMillsString(value: unknown): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? millsToDollarString(parsed)
    : "";
}

function optionalNonnegativeCentsString(value: unknown): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? centsToExactDollarString(parsed)
    : "";
}

function pricingDraftFromStoredLine(
  line: any,
  orderQty: number,
  fallbackUnitCostMills: number,
): PoLinePricingEditorDraft {
  switch (line?.pricingBasis) {
    case "per_piece":
      return createEmptyPoLinePricingDraft({
        basis: "per_piece",
        quantityPieces: optionalPositiveIntegerString(orderQty),
        unitPriceDollars: optionalNonnegativeMillsString(line.quotedUnitCostMills),
      });
    case "per_purchase_uom":
      return createEmptyPoLinePricingDraft({
        basis: "per_purchase_uom",
        purchaseUom: typeof line.purchaseUom === "string" ? line.purchaseUom : "",
        uomQuantity: optionalPositiveIntegerString(line.purchaseUomQuantity),
        piecesPerUom: optionalPositiveIntegerString(line.piecesPerPurchaseUom),
        pricePerUomDollars: optionalNonnegativeMillsString(line.quotedUnitCostMills),
      });
    case "extended_total":
      return createEmptyPoLinePricingDraft({
        basis: "extended_total",
        quantityPieces: optionalPositiveIntegerString(orderQty),
        quotedTotalDollars: optionalNonnegativeCentsString(line.quotedTotalCents),
      });
    default:
      // A legacy_unknown product line has no original quote provenance to
      // reconstruct. Present its current normalized unit cost as an explicit
      // per-piece convenience draft; it is persisted only after the operator
      // edits or confirms it and then submits the PO.
      return createPerPiecePricingDraft(
        Number.isSafeInteger(orderQty) && orderQty > 0 ? orderQty : 1,
        Number.isSafeInteger(fallbackUnitCostMills) && fallbackUnitCostMills >= 0
          ? fallbackUnitCostMills
          : 0,
      );
  }
}

function pricingSourceFromStoredLine(value: unknown): PricingSource {
  return value === "manual" ||
    value === "vendor_catalog" ||
    value === "recommendation" ||
    value === "legacy"
    ? value
    : "legacy";
}

function pricingBasisLabel(basis: PoLinePricingEditorDraft["basis"]): string {
  if (basis === "per_purchase_uom") return "Case / pack quote";
  if (basis === "extended_total") return "Extended quote";
  return "Per-item quote";
}

function pricingSourceLabel(source: PricingSource | null): string {
  if (source === "vendor_catalog") return "Vendor catalog";
  if (source === "recommendation") return "Purchasing recommendation";
  if (source === "legacy") return "Legacy line";
  return "Manual vendor quote";
}

export function isExplicitVendorQuoteBasis(value: unknown): boolean {
  return value === "per_piece" ||
    value === "per_purchase_uom" ||
    value === "extended_total";
}

export function quoteMetadataOnlyLinePatch(
  line: { hasExplicitPricing: boolean },
  metadata: Pick<LineDraft, "quoteReference" | "quotedAt" | "quoteValidUntil">,
): Partial<LineDraft> {
  return {
    ...metadata,
    // Changing quote metadata on explicit pricing is an operator edit, but it
    // must never turn inferred legacy economics into an explicit quote.
    ...(line.hasExplicitPricing ? { pricingSource: "manual" as const } : {}),
  };
}

export function poLineQuoteMetadataDraft(
  line: Pick<LineDraft, "quoteReference" | "quotedAt" | "quoteValidUntil">,
): PoLineQuoteMetadataDraft {
  return {
    quoteReference: line.quoteReference ?? "",
    quotedAt: line.quotedAt ? String(line.quotedAt).slice(0, 10) : "",
    quoteValidUntil: line.quoteValidUntil
      ? String(line.quoteValidUntil).slice(0, 10)
      : "",
  };
}

export function poLineQuoteMetadataError(
  line: Pick<LineDraft, "quoteReference" | "quotedAt" | "quoteValidUntil">,
): string | null {
  return evaluatePoLineQuoteMetadataDraft(poLineQuoteMetadataDraft(line)).error;
}

export function quoteMetadataEditorLinePatch(
  line: Pick<
    LineDraft,
    "hasExplicitPricing" | "quoteReference" | "quotedAt" | "quoteValidUntil"
  >,
  next: PoLineQuoteMetadataDraft,
): Partial<LineDraft> {
  const current = poLineQuoteMetadataDraft(line);
  return quoteMetadataOnlyLinePatch(line, {
    quoteReference: next.quoteReference !== current.quoteReference
      ? next.quoteReference || null
      : line.quoteReference,
    // Preserve an untouched timestamp exactly; date inputs intentionally carry
    // only a calendar date and must not truncate provenance on another edit.
    quotedAt: next.quotedAt !== current.quotedAt
      ? (next.quotedAt ? `${next.quotedAt}T00:00:00.000Z` : null)
      : line.quotedAt,
    quoteValidUntil: next.quoteValidUntil !== current.quoteValidUntil
      ? next.quoteValidUntil || null
      : line.quoteValidUntil,
  });
}

export function catalogReceiveConfiguration(row: {
  productVariantId?: number | null;
  receiveUnitsPerVariant?: number | null;
}): Pick<
  LineDraft,
  "productVariantId" | "expectedReceiveVariantId" | "expectedReceiveUnitsPerVariant"
> {
  const variantId = Number(row.productVariantId);
  const validVariantId = Number.isSafeInteger(variantId) && variantId > 0
    ? variantId
    : null;
  const units = Number(row.receiveUnitsPerVariant);
  const validUnits = Number.isSafeInteger(units) && units > 0 ? units : null;
  return {
    productVariantId: validVariantId,
    expectedReceiveVariantId: validVariantId,
    expectedReceiveUnitsPerVariant: validVariantId === null ? null : validUnits,
  };
}

export function resolvePreloadCatalogPricingIdentity(line: {
  catalogSource?: string | null;
  pricingBasis?: string | null;
  vendorProductId?: number | null;
  quotedAt?: string | Date | null;
  quoteValidUntil?: string | null;
}): {
  hasReusableCatalogPricing: boolean;
  vendorProductId: number | null;
  pricingSource: "manual" | "vendor_catalog";
} {
  const hasReusableCatalogPricing =
    line.catalogSource === "vendor_catalog" &&
    isVendorCatalogQuoteReusable(line);
  const vendorProductId = Number(line.vendorProductId);
  const trustedVendorProductId =
    Number.isSafeInteger(vendorProductId) && vendorProductId > 0
      ? vendorProductId
      : null;
  return {
    hasReusableCatalogPricing,
    vendorProductId: trustedVendorProductId,
    pricingSource:
      hasReusableCatalogPricing && trustedVendorProductId !== null
        ? "vendor_catalog"
        : "manual",
  };
}

export function applyCatalogUpsertMatchesToLines(
  sourceLines: LineDraft[],
  candidates: CatalogCandidate[],
  upsertedCandidates: CatalogCandidate[],
  result: { created?: any[]; updated?: any[] } | null | undefined,
): LineDraft[] {
  const upsertedClientIds = new Set(upsertedCandidates.map((candidate) => candidate.clientId));
  const returnedRows = [
    ...(Array.isArray(result?.created) ? result.created : []),
    ...(Array.isArray(result?.updated) ? result.updated : []),
  ];
  return sourceLines.map((line) => {
    if (!upsertedClientIds.has(line.clientId)) return line;
    const candidate = candidates.find((item) => item.clientId === line.clientId);
    const match = returnedRows.find(
      (row: any) =>
        Number(row?.productId) === Number(candidate?.productId ?? line.productId) &&
        (row?.productVariantId ?? null) ===
          (candidate?.productVariantId ?? line.expectedReceiveVariantId ?? line.productVariantId ?? null),
    );
    const vendorProductId = Number(match?.vendorProductId);
    if (!Number.isSafeInteger(vendorProductId) || vendorProductId <= 0) {
      // A successful bulk response must identify the reusable catalog row.
      // Keep the line manual if an older/incomplete server omits that id; this
      // avoids asserting vendor_catalog provenance without a verifiable link.
      return {
        ...line,
        catalogOriginallyAbsent: false,
        vendorProductId: null,
        pricingSource: "manual",
      };
    }
    return {
      ...line,
      catalogOriginallyAbsent: false,
      vendorProductId,
      pricingSource: "vendor_catalog",
    };
  });
}

function normalizedPricingPatch(
  pricingDraft: PoLinePricingEditorDraft,
  pricingSource?: PricingSource,
): Partial<LineDraft> {
  const evaluation = evaluatePoLinePricingDraft(pricingDraft);
  return {
    pricingDraft,
    hasExplicitPricing: true,
    preserveLegacyPricing: false,
    ...(pricingSource ? { pricingSource } : {}),
    ...(evaluation.normalized
      ? {
          orderQty: evaluation.normalized.orderQty,
          unitCostMills: evaluation.normalized.unitCostMills,
          totalProductCostCents: evaluation.normalized.totalProductCostCents,
        }
      : {}),
  };
}

function emptyLine(lineType: PoLineType = "product"): LineDraft {
  const isProduct = lineType === "product";
  return {
    serverLineId: null,
    clientId: newClientId(),
    lineType,
    description: "",
    parentClientId: null,
    productVariantId: null,
    expectedReceiveVariantId: null,
    expectedReceiveUnitsPerVariant: 1,
    productId: null,
    productName: "",
    sku: null,
    orderQty: 1,
    pricingDraft: isProduct ? createEmptyPoLinePricingDraft() : null,
    hasExplicitPricing: false,
    preserveLegacyPricing: false,
    pricingSource: isProduct ? "manual" : null,
    quoteReference: null,
    quotedAt: null,
    quoteValidUntil: null,
    unitCostMills: 0,
    totalProductCostCents: 0,
    packagingCostCents: 0,
  };
}

type EditorSnapshotInput = {
  vendorId: number | null;
  lines: LineDraft[];
  poType: string;
  priority: string;
  expectedDeliveryDate: string;
  incoterms: string;
  vendorNotes: string;
  internalNotes: string;
};

function buildEditorSnapshot(input: EditorSnapshotInput): string {
  return JSON.stringify(input);
}

// Idempotency-Key header value. Fresh per mutation attempt.
function genIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `po-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function PurchaseOrderEdit() {
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const params = useParams<{ id?: string }>();
  const isEditMode = Boolean(params?.id);
  const editId = params?.id ? Number(params.id) : null;

  // ── Query params (preload) ────────────────────────────────────────────
  const queryString = typeof window !== "undefined" ? window.location.search : "";
  const urlParams = useMemo(() => new URLSearchParams(queryString), [queryString]);
  const preloadVendorId = urlParams.get("vendor_id")
    ? Number(urlParams.get("vendor_id"))
    : undefined;
  const preloadVariantIdsCsv = urlParams.get("variant_ids") || "";
  const preloadDuplicateFrom = urlParams.get("duplicate_from")
    ? Number(urlParams.get("duplicate_from"))
    : undefined;

  const hasPreloadParams =
    Boolean(preloadVendorId) ||
    Boolean(preloadVariantIdsCsv) ||
    Boolean(preloadDuplicateFrom);

  // ── State ─────────────────────────────────────────────────────────────
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  const [lines, setLines] = useState<LineDraft[]>([]);
  const [poType, setPoType] = useState("standard");
  const [priority, setPriority] = useState("normal");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState<string>("");
  const [incoterms, setIncoterms] = useState("");
  const [vendorNotes, setVendorNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Spec A follow-up: "Add to catalog?" modal state.
  // Populated right before a save when any line was selected from the
  // non-catalog bucket. The resolver inside the dialog flow hands control
  // back to the originating save handler via a ref-held Promise.
  const [catalogDialogOpen, setCatalogDialogOpen] = useState(false);
  const [catalogCandidates, setCatalogCandidates] = useState<CatalogCandidate[]>([]);
  const [catalogSubmitting, setCatalogSubmitting] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogResolverRef = useRef<((resolvedLines: LineDraft[]) => void) | null>(null);

  // Remember the initial snapshot so we only flip dirty on real changes.
  const snapshotRef = useRef<string>("");
  const loadedVersionRef = useRef<string | null>(null);
  useEffect(() => {
    // Capture baseline after the first render completes.
    snapshotRef.current = buildEditorSnapshot({
      vendorId: selectedVendor?.id ?? null,
      lines,
      poType,
      priority,
      expectedDeliveryDate,
      incoterms,
      vendorNotes,
      internalNotes,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = buildEditorSnapshot({
      vendorId: selectedVendor?.id ?? null,
      lines,
      poType,
      priority,
      expectedDeliveryDate,
      incoterms,
      vendorNotes,
      internalNotes,
    });
    setDirty(current !== snapshotRef.current);
  }, [
    selectedVendor,
    lines,
    poType,
    priority,
    expectedDeliveryDate,
    incoterms,
    vendorNotes,
    internalNotes,
  ]);

  // ── Settings (for incoterms display rule) ─────────────────────────────
  const { data: settings } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    queryFn: async () => {
      const res = await fetch("/api/settings/procurement");
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  const showIncotermsField = useMemo(() => {
    // Per spec §6.4: only show for non-US vendors, AND only when
    // hide_incoterms_domestic is false. If vendor unknown, show by default.
    if (!settings) return false;
    const hideDomestic = settings.hideIncotermsDomestic;
    const country = selectedVendor?.country;
    if (!country) return !hideDomestic; // no vendor/country: respect setting
    if (country.toUpperCase() === "US") return false;
    return true;
  }, [settings, selectedVendor]);

  // ── Vendors typeahead ─────────────────────────────────────────────────
  const { data: allVendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
    queryFn: async () => {
      const res = await fetch("/api/vendors");
      if (!res.ok) throw new Error("Failed to load vendors");
      return res.json();
    },
  });

  const filteredVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return allVendors.slice(0, 30);
    return allVendors
      .filter(
        (v) =>
          v.name?.toLowerCase().includes(q) || v.code?.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [allVendors, vendorSearch]);

  // ── Products typeahead (per-row) ──────────────────────
  const [productSearch, setProductSearch] = useState<Record<string, string>>({});
  const [productPopoverOpen, setProductPopoverOpen] = useState<Record<string, boolean>>({});

  // Spec A follow-up: vendor-scoped typeahead. When a vendor is selected we
  // hit /api/vendors/:id/catalog-search to get a two-bucket response. When
  // no vendor is selected yet (rare, Add-line is disabled) we fall back to
  // /api/products?q= so the user can still search the global catalog.
  function useVendorCatalogSearch(vendorId: number | null, q: string) {
    return useQuery<CatalogSearchResponse>({
      queryKey: ["/api/vendors/catalog-search", { vendorId, q }],
      queryFn: async () => {
        if (vendorId) {
          const url = `/api/vendors/${vendorId}/catalog-search${
            q ? `?q=${encodeURIComponent(q)}` : ""
          }`;
          const res = await fetch(url);
          if (!res.ok) throw new Error("Failed to load vendor catalog");
          return res.json();
        }
        // Fallback: global product search, coerced into the two-bucket shape
        // with an empty inCatalog section. Lets the user start typing before
        // a vendor is picked.
        const url = q ? `/api/products?q=${encodeURIComponent(q)}` : "/api/products?limit=50";
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load products");
        const data = (await res.json()) as ProductLite[];
        const products: ProductLite[] = Array.isArray(data) ? data : (data as any).products ?? [];
        const outOfCatalog: CatalogSearchResponse["outOfCatalog"] = [];
        for (const p of products) {
          outOfCatalog.push({
            productId: p.id,
            productVariantId: null,
            sku: p.sku ?? null,
            productName: p.name,
            variantName: null,
          });
        }
        return { inCatalog: [], outOfCatalog };
      },
      staleTime: 30_000,
    });
  }

  // ── Preload (vendor + lines) ──────────────────────────────────────────
  const { data: preload } = useQuery<PreloadResponse>({
    queryKey: [
      "/api/purchase-orders/new-preload",
      { preloadVendorId, preloadVariantIdsCsv, preloadDuplicateFrom },
    ],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (preloadVendorId) qs.set("vendor_id", String(preloadVendorId));
      if (preloadVariantIdsCsv) qs.set("variant_ids", preloadVariantIdsCsv);
      if (preloadDuplicateFrom) qs.set("duplicate_from", String(preloadDuplicateFrom));
      const res = await fetch(`/api/purchase-orders/new-preload?${qs.toString()}`);
      if (!res.ok) throw new Error("Failed to preload");
      return res.json();
    },
    enabled: !isEditMode && hasPreloadParams,
  });

  useEffect(() => {
    if (!preload) return;
    if (preload.vendor && !selectedVendor) {
      setSelectedVendor(preload.vendor);
      if (preload.vendor.defaultIncoterms) setIncoterms(preload.vendor.defaultIncoterms);
    }
    if (preload.lines?.length > 0 && lines.length === 0) {
      setLines(
        preload.lines.map((l) => {
          const orderQty = l.suggestedQty > 0 ? l.suggestedQty : 1;
          // Prefer server-provided mills; fall back to cents × 100 for
          // legacy responses that don't yet include unit_cost_mills.
          const unitCostMills =
            typeof l.unitCostMills === "number"
              ? l.unitCostMills
              : centsToMills(Number(l.unitCostCents) || 0);
          const {
            vendorProductId,
            pricingSource,
          } = resolvePreloadCatalogPricingIdentity(l);
          const hasExplicitCatalogPricing = isExplicitVendorQuoteBasis(l.pricingBasis);
          // Preserve the vendor-facing basis even when an old/expired quote
          // is downgraded to manual review. Trust and representation are two
          // separate decisions.
          const pricingDraft = createVendorCatalogPricingDraft({ ...l, moq: orderQty });
          const normalized = evaluatePoLinePricingDraft(pricingDraft).normalized;
          return {
            serverLineId: null,
            clientId: newClientId(),
            // Preloaded lines are always product lines (the preload endpoint
            // returns catalog suggestions, not typed non-product lines).
            lineType: "product" as PoLineType,
            description: "",
            parentClientId: null,
            productVariantId: l.productVariantId,
            expectedReceiveVariantId: l.expectedReceiveVariantId ?? l.productVariantId ?? null,
            expectedReceiveUnitsPerVariant: l.expectedReceiveUnitsPerVariant ?? 1,
            productId: l.productId,
            productName: l.productName,
            sku: l.sku,
            orderQty: normalized?.orderQty ?? orderQty,
            pricingDraft,
            hasExplicitPricing: hasExplicitCatalogPricing,
            preserveLegacyPricing: false,
            pricingSource,
            quoteReference: l.quoteReference ?? null,
            quotedAt: l.quotedAt ?? null,
            quoteValidUntil: l.quoteValidUntil ?? null,
            unitCostMills: normalized?.unitCostMills ?? unitCostMills,
            totalProductCostCents: normalized?.totalProductCostCents ?? 0,
            packagingCostCents: 0,
            vendorProductId,
          };
        }),
      );
    }
    if (preload.sourcePo) {
      toast({
        title: preload.sourcePo.note,
        description: "Line costs refreshed from current vendor catalog where available.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload]);

  // ── Load existing draft (edit mode) ───────────────────────────────────
  const { data: existingPo } = useQuery<any>({
    queryKey: ["/api/purchase-orders", editId, "full"],
    queryFn: async () => {
      const res = await fetch(`/api/purchase-orders/${editId}`);
      if (!res.ok) throw new Error("Failed to load PO");
      return res.json();
    },
    enabled: isEditMode && Boolean(editId),
  });
  const immutableExistingPo = isEditMode &&
    isImmutableRecommendationPurchaseOrder(existingPo);

  useEffect(() => {
    if (!existingPo) return;
    if (!canUseFullPurchaseOrderEditor(existingPo)) {
      // Non-drafts and recommendation-owned economic snapshots are managed
      // from detail, where lifecycle actions do not require a replacement PUT.
      navigate(`/purchase-orders/${existingPo.id}`);
      return;
    }
    const nextVendor = existingPo.vendor ?? null;
    const nextPoType = existingPo.poType ?? "standard";
    const nextPriority = existingPo.priority ?? "normal";
    const nextExpectedDeliveryDate = existingPo.expectedDeliveryDate
      ? String(existingPo.expectedDeliveryDate).slice(0, 10)
      : "";
    const nextIncoterms = existingPo.incoterms ?? "";
    const nextVendorNotes = existingPo.vendorNotes ?? "";
    const nextInternalNotes = existingPo.internalNotes ?? "";
    const activeServerLines = Array.isArray(existingPo.lines)
      ? existingPo.lines.filter((line: any) => line.status !== "cancelled")
      : [];
    const clientIdByServerLineId = new Map<number, string>();
    for (const line of activeServerLines) {
      const lineId = Number(line.id);
      if (Number.isSafeInteger(lineId) && lineId > 0) {
        clientIdByServerLineId.set(lineId, `existing-${lineId}`);
      }
    }
    const nextLines: LineDraft[] = activeServerLines.map((l: any) => {
      const lineType: PoLineType =
        typeof l.lineType === "string" && PO_LINE_TYPES.includes(l.lineType as PoLineType)
          ? (l.lineType as PoLineType)
          : "product";
      const serverMills =
        typeof l.unitCostMills === "number" ? l.unitCostMills : null;
      // For non-product lines (discount/rebate/adjustment), cost may be
      // negative. We preserve the sign from the server value.
      let unitCostMills: number;
      if (serverMills !== null) {
        unitCostMills = serverMills;
      } else {
        // Fall back to cents→mills. Non-negative only (legacy rows).
        unitCostMills = centsToMills(Number(l.unitCostCents) || 0);
      }
      // Spec F Phase 1: populate totals from server data.
      // For old lines (totalProductCostCents = 0), back-compute from mills.
      const qty = Number(l.orderQty) || 0;
      const serverTotalProduct = Number(l.totalProductCostCents) || 0;
      const serverPackaging = Number(l.packagingCostCents) || 0;
      const totalProductCostCents =
        serverTotalProduct > 0
          ? serverTotalProduct
          : unitCostMills > 0 && qty > 0
            ? Math.round((unitCostMills * qty) / 100)
            : 0;
      const pricingDraft =
        lineType === "product" ? pricingDraftFromStoredLine(l, qty, unitCostMills) : null;
      const hasExplicitPricing =
        lineType === "product" && isExplicitVendorQuoteBasis(l.pricingBasis);
      const normalizedPricing = pricingDraft
        ? evaluatePoLinePricingDraft(pricingDraft).normalized
        : null;
      const serverLineId = Number(l.id);
      return {
        serverLineId:
          Number.isSafeInteger(serverLineId) && serverLineId > 0 ? serverLineId : null,
        clientId: clientIdByServerLineId.get(serverLineId) ?? newClientId(),
        lineType,
        description: typeof l.description === "string" ? l.description : "",
        parentClientId:
          l.parentLineId == null
            ? null
            : clientIdByServerLineId.get(Number(l.parentLineId)) ?? null,
        productVariantId: l.productVariantId ?? null,
        expectedReceiveVariantId: l.expectedReceiveVariantId ?? l.productVariantId ?? null,
        expectedReceiveUnitsPerVariant:
          l.expectedReceiveUnitsPerVariant ?? l.unitsPerUom ?? 1,
        productId: l.productId ?? null,
        productName: l.productName ?? "",
        sku: l.sku ?? null,
        orderQty: hasExplicitPricing ? (normalizedPricing?.orderQty ?? l.orderQty) : l.orderQty,
        pricingDraft: lineType === "product" ? pricingDraft : null,
        hasExplicitPricing,
        preserveLegacyPricing: lineType === "product" && !hasExplicitPricing,
        pricingSource:
          lineType === "product" ? pricingSourceFromStoredLine(l.pricingSource) : null,
        quoteReference:
          lineType === "product" && typeof l.quoteReference === "string"
            ? l.quoteReference
            : null,
        quotedAt:
          lineType === "product" && l.quotedAt != null ? String(l.quotedAt) : null,
        quoteValidUntil:
          lineType === "product" && l.quoteValidUntil != null
            ? String(l.quoteValidUntil).slice(0, 10)
            : null,
        unitCostMills: hasExplicitPricing
          ? (normalizedPricing?.unitCostMills ?? unitCostMills)
          : unitCostMills,
        totalProductCostCents: hasExplicitPricing
          ? (normalizedPricing?.totalProductCostCents ?? totalProductCostCents)
          : totalProductCostCents,
        packagingCostCents: serverPackaging,
        vendorProductId: l.vendorProductId ?? null,
        catalogOriginallyAbsent: null,
      };
    });

    const loadedVersion = existingPo.updatedAt ? String(existingPo.updatedAt) : null;
    loadedVersionRef.current = loadedVersion;
    snapshotRef.current = buildEditorSnapshot({
      vendorId: nextVendor?.id ?? null,
      lines: nextLines,
      poType: nextPoType,
      priority: nextPriority,
      expectedDeliveryDate: nextExpectedDeliveryDate,
      incoterms: nextIncoterms,
      vendorNotes: nextVendorNotes,
      internalNotes: nextInternalNotes,
    });
    setSelectedVendor(nextVendor);
    setPoType(nextPoType);
    setPriority(nextPriority);
    setExpectedDeliveryDate(nextExpectedDeliveryDate);
    setIncoterms(nextIncoterms);
    setVendorNotes(nextVendorNotes);
    setInternalNotes(nextInternalNotes);
    setLines(nextLines);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingPo]);

  // ── Totals ────────────────────────────────────────────────────────────
  // Line total = round_half_up(unit_cost_mills * order_qty / 100) — integer
  // math only. Subtotal is the sum of line totals in cents.
  // Sign-aware totals breakdown by line_type. Mirrors server-side
  // computePoTotalsFromLines so the displayed totals match exactly what
  // the backend will record on save.
  const totals = useMemo(() => {
    let productSubtotal = 0;
    let discountTotal = 0;
    let feeTotal = 0;
    let taxTotal = 0;
    let adjustmentTotal = 0;
    for (const l of lines) {
      const qty = Number(l.orderQty) || 0;
      const mills = Number(l.unitCostMills) || 0;
      // Spec F Phase 1: product lines use totals as source of truth.
      const totalProduct = Number(l.totalProductCostCents) || 0;
      const packaging = Number(l.packagingCostCents) || 0;
      let lineTotal: number;
      if (l.lineType === "product") {
        lineTotal = totalProduct + packaging;
      } else {
        if (qty === 0 || mills === 0) continue;
        lineTotal = signedComputeLineTotalCents(mills, qty);
      }
      switch (l.lineType) {
        case "product":
          productSubtotal += lineTotal;
          break;
        case "discount":
        case "rebate":
          discountTotal += lineTotal;
          break;
        case "fee":
          feeTotal += lineTotal;
          break;
        case "tax":
          taxTotal += lineTotal;
          break;
        case "adjustment":
          adjustmentTotal += lineTotal;
          break;
      }
    }
    return {
      productSubtotalCents: productSubtotal,
      discountTotalCents: discountTotal,
      feeTotalCents: feeTotal,
      taxTotalCents: taxTotal,
      adjustmentTotalCents: adjustmentTotal,
      totalCents:
        productSubtotal +
        discountTotal +
        feeTotal +
        taxTotal +
        adjustmentTotal,
      hasNonProductLines: lines.some((l) => l.lineType !== "product"),
    };
  }, [lines]);

  // Back-compat alias — simple subtotal display when there are no non-
  // product lines uses just productSubtotalCents (matches old behavior).
  const subtotalCents = totals.productSubtotalCents;

  // ── Client-side line validation ──────────────────────────────
  //
  // Mirrors the server-side validateCreateWithLinesInput rules from
  // purchasing.service.ts so the user sees inline errors before submit.
  // The backend is still authoritative; this just gives faster feedback
  // and disables the Save buttons when something obvious is wrong.
  //
  // Returns a map of clientId -> error message. Empty map = all valid.
  const lineErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const l of lines) {
      const qty = Number(l.orderQty) || 0;
      const mills = Number(l.unitCostMills) || 0;
      const description = (l.description ?? "").trim();

      if (l.lineType === "product") {
        if (!l.productId) {
          errors[l.clientId] = "Pick a product";
          continue;
        }
        if (!l.pricingDraft) {
          errors[l.clientId] = "Enter the vendor quote";
          continue;
        }
        if (!l.hasExplicitPricing && !l.preserveLegacyPricing) {
          errors[l.clientId] = "Confirm the vendor quote";
          continue;
        }
        const pricingEvaluation = evaluatePoLinePricingDraft(l.pricingDraft);
        if (!pricingEvaluation.normalized) {
          errors[l.clientId] = pricingEvaluation.error ?? "Enter a valid vendor quote";
          continue;
        }
        const metadataError = poLineQuoteMetadataError(l);
        if (metadataError) {
          errors[l.clientId] = metadataError;
          continue;
        }
        continue;
      }

      // Non-product lines: description required.
      if (description.length === 0) {
        errors[l.clientId] = "Description required";
        continue;
      }

      // Per-type sign + qty rules.
      if (l.lineType === "discount" || l.lineType === "rebate") {
        if (mills > 0) {
          errors[l.clientId] = `${l.lineType.charAt(0).toUpperCase()}${l.lineType.slice(1)} amount must be ≤ 0`;
          continue;
        }
        if (qty !== 1) {
          errors[l.clientId] = `${l.lineType.charAt(0).toUpperCase()}${l.lineType.slice(1)} quantity must be 1`;
          continue;
        }
      } else if (l.lineType === "fee") {
        if (mills < 0) {
          errors[l.clientId] = "Fee amount must be ≥ 0";
          continue;
        }
        if (qty < 1) {
          errors[l.clientId] = "Fee quantity must be ≥ 1";
          continue;
        }
      } else if (l.lineType === "tax") {
        if (mills < 0) {
          errors[l.clientId] = "Tax amount must be ≥ 0";
          continue;
        }
        if (qty !== 1) {
          errors[l.clientId] = "Tax quantity must be 1";
          continue;
        }
      } else if (l.lineType === "adjustment") {
        if (qty !== 1) {
          errors[l.clientId] = "Adjustment quantity must be 1";
          continue;
        }
      }
    }
    return errors;
  }, [lines]);

  const hasLineErrors = Object.keys(lineErrors).length > 0;
  const hasNoLines = lines.length === 0;
  const noVendor = !selectedVendor;
  const canSave = !immutableExistingPo && !saving && !hasLineErrors && !hasNoLines && !noVendor;
  const canSaveDraft = canSave && (!isEditMode || dirty);

  // ── Dirty nav prompt ──────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ── Validation ────────────────────────────────────────────────────────
  //
  // Mirrors the server-side validateCreateWithLinesInput rules from
  // purchasing.service.ts (migration 0563 + typed lines). Each line type
  // has its own shape, so a single rule per line is wrong: e.g. a discount
  // line has no product, has qty == 1, and cost <= 0.
  function validateForSubmit(): string | null {
    if (!selectedVendor) return "Select a vendor before saving.";
    if (lines.length === 0) return "Add at least one line.";
    for (const [idx, l] of lines.entries()) {
      const label = `Line ${idx + 1}`;
      const description = (l.description ?? "").trim();

      if (l.lineType === "product") {
        if (!l.productId) return `${label}: pick a product.`;
        if (!l.pricingDraft) return `${label}: enter the vendor quote.`;
        if (!l.hasExplicitPricing && !l.preserveLegacyPricing) {
          return `${label}: confirm the vendor quote.`;
        }
        const pricingEvaluation = evaluatePoLinePricingDraft(l.pricingDraft);
        if (!pricingEvaluation.normalized) {
          return `${label}: ${pricingEvaluation.error ?? "enter a valid vendor quote."}`;
        }
        const metadataError = poLineQuoteMetadataError(l);
        if (metadataError) return `${label}: ${metadataError}`;
        continue;
      }

      // Non-product lines all require a description.
      if (description.length === 0) {
        return `${label} (${l.lineType}): description required.`;
      }

      const mills = Number(l.unitCostMills) || 0;
      const qty = Number(l.orderQty) || 0;

      if (l.lineType === "discount" || l.lineType === "rebate") {
        if (mills > 0) {
          return `${label} (${l.lineType}): amount must be zero or negative.`;
        }
        if (qty !== 1) {
          return `${label} (${l.lineType}): quantity must be 1.`;
        }
      } else if (l.lineType === "fee") {
        if (mills < 0) return `${label} (fee): amount must be zero or more.`;
        if (qty < 1) return `${label} (fee): quantity must be 1 or more.`;
      } else if (l.lineType === "tax") {
        if (mills < 0) return `${label} (tax): amount must be zero or more.`;
        if (qty !== 1) return `${label} (tax): quantity must be 1.`;
      } else if (l.lineType === "adjustment") {
        if (qty !== 1) {
          return `${label} (adjustment): quantity must be 1.`;
        }
      }
    }
    return null;
  }

  // ── Add-to-catalog gate (Spec A follow-up) ────────────────────
  //
  // Computes the candidate list (lines selected from the "not in catalog"
  // bucket that have a valid productVariantId and a non-negative cost). If
  // none: resolves true immediately so the caller proceeds to save. If any:
  // opens the dialog and waits for the user's decision. On "Add all" or
  // "Add N selected" we POST to the bulk-upsert endpoint BEFORE returning;
  // a failure there leaves the dialog open with an error and returns false,
  // so the caller does NOT attempt the PO save.
  function computeCatalogCandidates(): CatalogCandidate[] {
    if (!selectedVendor) return [];
    const out: CatalogCandidate[] = [];
    for (const l of lines) {
      if (l.catalogOriginallyAbsent !== true) continue;
      if (!l.productId) continue;
      if (!l.pricingDraft) continue;
      const pricingEvaluation = evaluatePoLinePricingDraft(l.pricingDraft);
      const reusablePricing = pricingEvaluation.pricing;
      // Extended totals are quantity-specific and cannot become a reusable
      // vendor catalog price.
      if (!reusablePricing || reusablePricing.basis === "extended_total") {
        continue;
      }
      if (!pricingEvaluation.normalized) continue;
      out.push({
        clientId: l.clientId,
        productId: l.productId,
        productVariantId: l.expectedReceiveVariantId ?? l.productVariantId ?? null,
        productName: l.productName || "(unnamed)",
        sku: l.sku,
        // Dialog displays 4-decimal mills; cents derived for back-compat.
        unitCostMills: pricingEvaluation.normalized.unitCostMills,
        unitCostCents: pricingEvaluation.normalized.unitCostCents,
        pricing: reusablePricing,
        quotedAt: l.quotedAt,
      });
    }
    return out;
  }

  async function maybePromptAddToCatalog(): Promise<LineDraft[]> {
    if (!selectedVendor) return lines;
    const candidates = computeCatalogCandidates();
    if (candidates.length === 0) return lines;
    setCatalogCandidates(candidates);
    setCatalogError(null);
    setCatalogSubmitting(false);
    setCatalogDialogOpen(true);
    return new Promise<LineDraft[]>((resolve) => {
      catalogResolverRef.current = resolve;
    });
  }

  async function handleCatalogDecision(decision: AddToCatalogDecision) {
    if (!selectedVendor) return;
    const resolver = catalogResolverRef.current;
    if (decision.action === "add-none") {
      const resolvedLines = lines.map((line) =>
        catalogCandidates.some((candidate) => candidate.clientId === line.clientId)
          ? { ...line, catalogOriginallyAbsent: false }
          : line,
      );
      setLines(resolvedLines);
      setCatalogDialogOpen(false);
      catalogResolverRef.current = null;
      resolver?.(resolvedLines);
      return;
    }
    const toSend: CatalogCandidate[] =
      decision.action === "add-all"
        ? catalogCandidates
        : catalogCandidates.filter((c) =>
            decision.selectedClientIds.includes(c.clientId),
          );
    if (toSend.length === 0) {
      const resolvedLines = lines.map((line) =>
        catalogCandidates.some((candidate) => candidate.clientId === line.clientId)
          ? { ...line, catalogOriginallyAbsent: false }
          : line,
      );
      setLines(resolvedLines);
      setCatalogDialogOpen(false);
      catalogResolverRef.current = null;
      resolver?.(resolvedLines);
      return;
    }
    setCatalogSubmitting(true);
    setCatalogError(null);
    try {
      const body = {
        entries: toSend.map((c) => {
          const sourceLine = lines.find((line) => line.clientId === c.clientId);
          const pricingEvaluation = sourceLine?.pricingDraft
            ? evaluatePoLinePricingDraft(sourceLine.pricingDraft)
            : null;
          if (
            !pricingEvaluation?.pricing ||
            pricingEvaluation.pricing.basis === "extended_total"
          ) {
            throw new Error(`${c.productName}: enter a reusable item or case/pack price.`);
          }
          return {
            productId: c.productId,
            productVariantId: c.productVariantId,
            pricing: pricingEvaluation.pricing,
            quoteReference: sourceLine?.quoteReference ?? null,
            quotedAt: sourceLine?.quotedAt ?? null,
            quoteValidUntil: sourceLine?.quoteValidUntil ?? null,
          };
        }),
      };
      const res = await fetch(
        `/api/vendors/${selectedVendor.id}/catalog/bulk-upsert`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": genIdempotencyKey(),
          },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Catalog upsert failed");
      }
      const resolvedLines = applyCatalogUpsertMatchesToLines(
        lines,
        catalogCandidates,
        toSend,
        data,
      );
      setLines(resolvedLines);
      setCatalogDialogOpen(false);
      setCatalogSubmitting(false);
      catalogResolverRef.current = null;
      resolver?.(resolvedLines);
    } catch (e: any) {
      setCatalogError(e?.message || "Catalog upsert failed");
      setCatalogSubmitting(false);
      // Leave the dialog open. The user can retry, pick "Add none", or cancel.
      // Do NOT resolve the pending save promise yet — the caller is still awaiting.
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async ({
      advanceToSent,
      linesToSave,
    }: {
      advanceToSent: boolean;
      linesToSave: LineDraft[];
    }) => {
      if (!selectedVendor) throw new Error("Vendor required");
      if (isEditMode && (!editId || !loadedVersionRef.current)) {
        throw new Error("The draft version is unavailable. Reload the PO before saving.");
      }
      const body = {
        vendor_id: selectedVendor.id,
        po_type: poType,
        priority,
        expected_delivery_date: expectedDeliveryDate || null,
        incoterms: showIncotermsField ? incoterms || null : null,
        vendor_notes: vendorNotes || null,
        internal_notes: internalNotes || null,
        lines: linesToSave.map((l, index) => {
          const common = {
            line_id: l.serverLineId ?? undefined,
            line_type: l.lineType,
            client_id: l.clientId,
            parent_client_id: l.parentClientId ?? null,
            description: l.description || null,
            vendor_product_id: l.vendorProductId ?? null,
          };

          if (l.lineType === "product") {
            const productIdentity = {
              product_id: l.productId,
              expected_receive_variant_id: l.expectedReceiveVariantId,
              expected_receive_units_per_variant: l.expectedReceiveUnitsPerVariant,
            };

            // Do not silently assign a quote basis to a legacy_unknown line
            // during an unrelated draft edit. Its stored total-based shape is
            // retained until the operator explicitly confirms the quote UI.
            if (!l.hasExplicitPricing) {
              if (!l.preserveLegacyPricing) {
                throw new Error(`Line ${index + 1}: confirm the vendor quote.`);
              }
              return {
                ...common,
                ...productIdentity,
                quantity_ordered: l.orderQty,
                total_product_cost_cents: l.totalProductCostCents ?? 0,
                packaging_cost_cents: l.packagingCostCents ?? 0,
              };
            }

            if (!l.pricingDraft) {
              throw new Error(`Line ${index + 1}: enter the vendor quote.`);
            }
            const pricingEvaluation = evaluatePoLinePricingDraft(l.pricingDraft);
            if (!pricingEvaluation.pricing || !pricingEvaluation.normalized) {
              throw new Error(
                `Line ${index + 1}: ${pricingEvaluation.error ?? "enter a valid vendor quote."}`,
              );
            }
            return {
              ...common,
              // Purchasing identity is product_id + piece qty. The receiving
              // fields remain independent from the vendor's purchase UOM.
              ...productIdentity,
              quantity_ordered: pricingEvaluation.normalized.orderQty,
              pricing: pricingEvaluation.pricing,
              pricingSource: l.pricingSource ?? "manual",
              quoteReference: l.quoteReference,
              quotedAt: l.quotedAt,
              quoteValidUntil: l.quoteValidUntil,
              // Packaging is an additive exact-cent amount and is not part of
              // the supplier's product quote normalization.
              packaging_cost_cents: l.packagingCostCents ?? 0,
            };
          }

          // Typed non-product lines keep their existing signed legacy-money
          // contract and never send product quote fields.
          return {
            ...common,
            product_id: null,
            expected_receive_variant_id: null,
            expected_receive_units_per_variant: null,
            quantity_ordered: l.orderQty,
            unit_cost_mills: l.unitCostMills,
            unit_cost_cents: signedMillsToCents(l.unitCostMills),
          };
        }),
        advance_to_sent: advanceToSent,
        ...(isEditMode ? { expected_updated_at: loadedVersionRef.current } : {}),
      };
      const res = await fetch(
        isEditMode ? `/api/purchase-orders/${editId}/draft` : "/api/purchase-orders",
        {
          method: isEditMode ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": genIdempotencyKey(),
          },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save PO");
      return data;
    },
  });

  async function handleSaveDraft() {
    if (immutableExistingPo) {
      if (existingPo?.id) navigate(`/purchase-orders/${existingPo.id}`);
      return;
    }
    if (isEditMode && !dirty) return;
    const err = validateForSubmit();
    if (err) {
      toast({ title: "Cannot save", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const linesToSave = await maybePromptAddToCatalog();
      const result = await saveMutation.mutateAsync({
        advanceToSent: false,
        linesToSave,
      });
      const po = result?.po ?? result;
      let savedLines = linesToSave;
      if (isEditMode) {
        const serverLineIdByClientId = new Map<string, number>();
        for (const savedLine of Array.isArray(result?.lines) ? result.lines : []) {
          const lineId = Number(savedLine?.id);
          if (
            typeof savedLine?.clientId === "string" &&
            Number.isSafeInteger(lineId) &&
            lineId > 0
          ) {
            serverLineIdByClientId.set(savedLine.clientId, lineId);
          }
        }
        savedLines = linesToSave.map((line) => ({
          ...line,
          serverLineId: serverLineIdByClientId.get(line.clientId) ?? line.serverLineId,
        }));
        loadedVersionRef.current = po?.updatedAt ? String(po.updatedAt) : null;
        setLines(savedLines);
      }
      toast({
        title: isEditMode ? "PO updated" : "PO saved as draft",
        description: po?.poNumber ?? "",
      });
      snapshotRef.current = buildEditorSnapshot({
        vendorId: selectedVendor?.id ?? null,
        lines: savedLines,
        poType,
        priority,
        expectedDeliveryDate,
        incoterms,
        vendorNotes,
        internalNotes,
      });
      setDirty(false);
      if (!isEditMode && po?.id) navigate(`/purchase-orders/${po.id}/edit`);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAndSend() {
    if (immutableExistingPo) {
      if (existingPo?.id) navigate(`/purchase-orders/${existingPo.id}`);
      return;
    }
    const err = validateForSubmit();
    if (err) {
      toast({ title: "Cannot send", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const linesToSave = await maybePromptAddToCatalog();
      const result = await saveMutation.mutateAsync({
        advanceToSent: true,
        linesToSave,
      });
      const po = result?.po ?? result;
      if (result?.sendError) {
        toast({
          title: isEditMode
            ? "PO updated, but send to vendor failed"
            : "PO created, but send to vendor failed",
          description: result.sendError,
          variant: "destructive",
        });
      } else if (result?.pending_approval) {
        toast({
          title: "Submitted for approval",
          description: `${po?.poNumber ?? ""} is awaiting approval.`,
        });
      } else {
        toast({
          title: isEditMode ? "PO updated and sent to vendor" : "PO created and sent to vendor",
          description: po?.poNumber ?? "",
        });
      }
      setDirty(false);
      if (po?.id) navigate(`/purchase-orders/${po.id}`);
    } catch (e: any) {
      toast({ title: "Send failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (dirty) {
      const ok = window.confirm("Discard this PO? Unsaved changes will be lost.");
      if (!ok) return;
    }
    navigate("/purchase-orders");
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveDraft();
      } else if (isMod && e.key === "Enter") {
        e.preventDefault();
        handleSaveAndSend();
      } else if (e.key === "Escape") {
        // Don't swallow Esc while the user is inside a Popover/Command; those
        // close themselves first.
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        handleCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, selectedVendor, lines, poType, priority, expectedDeliveryDate, incoterms, vendorNotes, internalNotes]);

  // ── Lines helpers ─────────────────────────────────────────────────────
  function updateLine(clientId: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.clientId === clientId ? { ...l, ...patch } : l)));
  }
  function removeLine(clientId: string) {
    setLines((prev) => prev.filter((l) => l.clientId !== clientId));
  }
  function addLine(lineType: PoLineType = "product") {
    setLines((prev) => [...prev, emptyLine(lineType)]);
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (immutableExistingPo) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Opening the preserved recommendation purchase order...
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 md:h-6 md:w-6" />
            {isEditMode ? `Edit ${existingPo?.poNumber ?? "PO"}` : "New Purchase Order"}
          </h1>
          <div className="text-sm text-muted-foreground">
            Draft {dirty ? "· unsaved changes" : "· saved"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={handleSaveDraft}
            disabled={!canSaveDraft}
            title={
              hasLineErrors
                ? "Fix line errors before saving"
                : noVendor
                ? "Pick a vendor before saving"
                : hasNoLines
                ? "Add at least one line before saving"
                : isEditMode && !dirty
                ? "No unsaved changes"
                : undefined
            }
          >
            Save draft
          </Button>
          <Button
            onClick={handleSaveAndSend}
            disabled={!canSave}
            title={
              hasLineErrors
                ? "Fix line errors before sending"
                : noVendor
                ? "Pick a vendor before sending"
                : hasNoLines
                ? "Add at least one line before sending"
                : undefined
            }
          >
            Save &amp; Send PDF
          </Button>
        </div>
      </div>

      {/* Vendor card */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <Label>Vendor *</Label>
          <Popover open={vendorOpen} onOpenChange={setVendorOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-full justify-between h-11 font-normal"
              >
                <span className="truncate">
                  {selectedVendor
                    ? `${selectedVendor.code} — ${selectedVendor.name}`
                    : "Select vendor..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search vendors..."
                  value={vendorSearch}
                  onValueChange={setVendorSearch}
                />
                <CommandList>
                  <CommandEmpty>No vendors found.</CommandEmpty>
                  <CommandGroup>
                    {filteredVendors.map((v) => (
                      <CommandItem
                        key={v.id}
                        value={String(v.id)}
                        onSelect={() => {
                          if (selectedVendor?.id !== v.id) {
                            setLines((current) =>
                              current.map((line) => ({
                                ...line,
                                vendorProductId: null,
                                catalogOriginallyAbsent: null,
                                ...(line.lineType === "product"
                                  ? {
                                      pricingSource: "manual" as PricingSource,
                                      preserveLegacyPricing: false,
                                      quoteReference: null,
                                      quotedAt: null,
                                      quoteValidUntil: null,
                                    }
                                  : {}),
                              })),
                            );
                          }
                          setSelectedVendor(v);
                          setVendorOpen(false);
                          setVendorSearch("");
                          if (v.defaultIncoterms && !incoterms)
                            setIncoterms(v.defaultIncoterms);
                        }}
                      >
                        <Check
                          className={`mr-2 h-4 w-4 ${
                            selectedVendor?.id === v.id ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        <span className="font-mono text-xs mr-2">{v.code}</span>
                        {v.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {selectedVendor && (
            <div className="text-xs text-muted-foreground flex flex-wrap gap-3 pt-1">
              {selectedVendor.paymentTermsDays != null && (
                <span>
                  Terms: {selectedVendor.paymentTermsType || "net"}{" "}
                  {selectedVendor.paymentTermsDays}
                </span>
              )}
              {selectedVendor.leadTimeDays != null && (
                <span>Lead: {selectedVendor.leadTimeDays}d</span>
              )}
              {selectedVendor.country && <span>Country: {selectedVendor.country}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lines editor */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {/* Section header — matches Variant A mockup */}
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Lines</h3>
              <p className="text-xs text-slate-500 mt-0.5">Enter totals from the vendor invoice. Per-unit costs are computed.</p>
            </div>
            <div className="inline-flex items-stretch">
              <Button
                size="sm"
                variant="outline"
                onClick={() => addLine("product")}
                disabled={!selectedVendor}
                className="rounded-r-none border-r-0"
                data-testid="button-add-product-line"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add product
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selectedVendor}
                    className="rounded-l-none px-2"
                    aria-label="Add line of another type"
                    data-testid="button-add-line-menu"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => addLine("product")}>
                    Product
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addLine("discount")}>
                    Discount
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addLine("fee")}>
                    Fee
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addLine("tax")}>
                    Tax
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addLine("rebate")}>
                    Rebate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addLine("adjustment")}>
                    Adjustment
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="p-4 space-y-3">
          {lines.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {selectedVendor
                ? "Add a line to get started."
                : "Select a vendor first."}
            </div>
          ) : (
            <div className="space-y-2">
              {(() => {
                const productLines = lines.filter((l) => l.lineType === "product");
                const nonProductLines = lines.filter((l) => l.lineType !== "product");
                const productLineOptions = productLines.map((l, productIdx) => ({
                  clientId: l.clientId,
                  label:
                    l.sku || l.productName
                      ? `${l.sku ? `${l.sku} · ` : ""}${l.productName || "(unnamed)"}`
                      : `Line ${productIdx + 1}`,
                }));

                return (
                  <>
                    {productLines.length > 0 && (
                      <div className="border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-slate-50 border-b border-slate-200 hover:bg-slate-50">
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium px-5 py-2.5">
                                SKU
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium text-right w-24 px-3 py-2.5">
                                Pieces
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium w-36 px-3 py-2.5">
                                Receive As
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium text-right w-36 px-3 py-2.5">
                                <div>Vendor Quote</div>
                                <div className="text-[10px] font-normal text-slate-400 normal-case">original basis preserved</div>
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium text-right w-36 px-3 py-2.5">
                                <div>Packaging</div>
                                <div className="text-[10px] font-normal text-slate-400 normal-case">$ per unit shown below</div>
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-slate-500 font-medium text-right w-36 px-3 py-2.5">
                                <div>Total Cost</div>
                                <div className="text-[10px] font-normal text-slate-400 normal-case">$ per unit shown below</div>
                              </TableHead>
                              <TableHead className="w-10 px-2 py-2.5"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody className="divide-y divide-slate-100">
                            {productLines.map((line) => {
                              const lineIdx = lines.indexOf(line);
                              return (
                                <ProductLineTableRow
                                  key={line.clientId}
                                  line={line}
                                  idx={lineIdx}
                                  error={lineErrors[line.clientId]}
                                  onChange={(patch) => updateLine(line.clientId, patch)}
                                  onRemove={() => removeLine(line.clientId)}
                                  useVendorCatalogSearch={useVendorCatalogSearch}
                                  vendorId={selectedVendor?.id ?? null}
                                  vendorName={selectedVendor?.name ?? null}
                                  productSearch={productSearch[line.clientId] || ""}
                                  setProductSearch={(q) => setProductSearch((prev) => ({ ...prev, [line.clientId]: q }))}
                                  popoverOpen={!!productPopoverOpen[line.clientId]}
                                  setPopoverOpen={(b) => setProductPopoverOpen((prev) => ({ ...prev, [line.clientId]: b }))}
                                />
                              );
                            })}
                          </TableBody>
                          <TableFooter className="bg-slate-50/50 border-t border-slate-200">
                            <TableRow className="hover:bg-slate-50/50">
                              <TableCell colSpan={5} className="px-5 py-3">
                                <button
                                  className="text-slate-700 hover:text-slate-900 inline-flex items-center gap-1.5 text-sm font-medium"
                                  onClick={() => addLine("product")}
                                  disabled={!selectedVendor}
                                  type="button"
                                >
                                  <span>+</span> Add product
                                </button>
                              </TableCell>
                              <TableCell className="px-3 py-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                                {formatCents(totals.productSubtotalCents)}
                              </TableCell>
                              <TableCell></TableCell>
                            </TableRow>
                          </TableFooter>
                        </Table>
                      </div>
                    )}

                    {nonProductLines.length > 0 && (
                      <div className="space-y-2">
                        {nonProductLines.map((line) => {
                          const lineIdx = lines.indexOf(line);
                          const err = lineErrors[line.clientId];
                          return (
                            <div key={line.clientId} className="space-y-1">
                              <NonProductLineRow
                                line={line}
                                idx={lineIdx}
                                onChange={(patch) => updateLine(line.clientId, patch)}
                                onRemove={() => removeLine(line.clientId)}
                                productLineOptions={productLineOptions}
                              />
                              {err && (
                                <div
                                  className="text-xs text-destructive pl-1"
                                  data-testid={`error-line-${lineIdx}`}
                                  role="alert"
                                >
                                  {err}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          <div className="pt-2 border-t text-right space-y-1">
            {totals.hasNonProductLines ? (
              // Mixed-type PO: render the full breakdown so the user can
              // verify discount / fee / tax / adjustment math line by line.
              // Only non-zero rows render (avoids visual clutter).
              <div className="text-sm space-y-0.5 inline-block text-left">
                <div className="grid grid-cols-[auto_auto] gap-x-4">
                  <span className="text-muted-foreground">Products subtotal</span>
                  <span
                    className="font-medium tabular-nums text-right"
                    data-testid="totals-products"
                  >
                    {signedFormatCents(totals.productSubtotalCents)}
                  </span>
                  {totals.discountTotalCents !== 0 && (
                    <>
                      <span className="text-muted-foreground">Discounts</span>
                      <span
                        className="font-medium tabular-nums text-right text-destructive"
                        data-testid="totals-discounts"
                      >
                        {signedFormatCents(totals.discountTotalCents)}
                      </span>
                    </>
                  )}
                  {totals.feeTotalCents !== 0 && (
                    <>
                      <span className="text-muted-foreground">Fees</span>
                      <span
                        className="font-medium tabular-nums text-right"
                        data-testid="totals-fees"
                      >
                        {signedFormatCents(totals.feeTotalCents)}
                      </span>
                    </>
                  )}
                  {totals.taxTotalCents !== 0 && (
                    <>
                      <span className="text-muted-foreground">Tax</span>
                      <span
                        className="font-medium tabular-nums text-right"
                        data-testid="totals-tax"
                      >
                        {signedFormatCents(totals.taxTotalCents)}
                      </span>
                    </>
                  )}
                  {totals.adjustmentTotalCents !== 0 && (
                    <>
                      <span className="text-muted-foreground">Adjustments</span>
                      <span
                        className={`font-medium tabular-nums text-right ${
                          totals.adjustmentTotalCents < 0
                            ? "text-destructive"
                            : ""
                        }`}
                        data-testid="totals-adjustments"
                      >
                        {signedFormatCents(totals.adjustmentTotalCents)}
                      </span>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-[auto_auto] gap-x-4 pt-1 mt-1 border-t">
                  <span className="font-semibold">Total</span>
                  <span
                    className="font-bold tabular-nums text-right"
                    data-testid="totals-grand"
                  >
                    {signedFormatCents(totals.totalCents)}
                  </span>
                </div>
              </div>
            ) : (
              // Product-only PO: keep the existing simple subtotal display.
              <div className="text-sm">
                <span className="text-muted-foreground mr-2">Subtotal</span>
                <span className="font-semibold" data-testid="totals-subtotal">
                  {formatCents(subtotalCents)}
                </span>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Shipping &amp; tax are added at receive time.
            </div>
          </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card>
          <CardContent className="p-4">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <span>Advanced options</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label>PO type</Label>
                  <Select value={poType} onValueChange={setPoType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="blanket">Blanket</SelectItem>
                      <SelectItem value="dropship">Dropship</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="rush">Rush</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Expected delivery</Label>
                  <Input
                    type="date"
                    value={expectedDeliveryDate}
                    onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                  />
                </div>
              </div>
              {showIncotermsField && (
                <div>
                  <Label>Incoterms</Label>
                  <Select value={incoterms} onValueChange={setIncoterms}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"].map(
                        (t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>Vendor notes</Label>
                <Textarea
                  rows={2}
                  value={vendorNotes}
                  onChange={(e) => setVendorNotes(e.target.value)}
                  placeholder="Printed on the PO (visible to vendor)"
                />
              </div>
              <div>
                <Label>Internal notes</Label>
                <Textarea
                  rows={2}
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  placeholder="For internal reference (not printed)"
                />
              </div>
            </CollapsibleContent>
          </CardContent>
        </Card>
      </Collapsible>

      {/* Sticky action bar on mobile */}
      <div className="md:hidden sticky bottom-0 bg-background border-t pt-2 flex gap-2">
        <Button variant="ghost" onClick={handleCancel} disabled={saving} className="flex-1">
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={handleSaveDraft}
          disabled={!canSaveDraft}
          className="flex-1"
          title={
            hasLineErrors
              ? "Fix line errors before saving"
              : noVendor
              ? "Pick a vendor before saving"
              : hasNoLines
              ? "Add at least one line before saving"
              : isEditMode && !dirty
              ? "No unsaved changes"
              : undefined
          }
        >
          Save draft
        </Button>
        <Button
          onClick={handleSaveAndSend}
          disabled={!canSave}
          className="flex-1"
          title={
            hasLineErrors
              ? "Fix line errors before sending"
              : noVendor
              ? "Pick a vendor before sending"
              : hasNoLines
              ? "Add at least one line before sending"
              : undefined
          }
        >
          Send PDF
        </Button>
      </div>

      {/* Spec A follow-up: "Add to catalog?" modal. Mounted at the page root
          so it overlays on every save path. The dialog itself blocks Esc /
          backdrop dismissal (see AddToCatalogDialog). */}
      <AddToCatalogDialog
        open={catalogDialogOpen}
        vendorName={selectedVendor?.name ?? ""}
        candidates={catalogCandidates}
        submitting={catalogSubmitting}
        error={catalogError}
        onDecide={handleCatalogDecision}
      />
    </div>
  );
}

// ─── LineRow ───────────────────────────────────────────────────────────────



// Rendered above non-product line rows so the user can tell at a glance
// what type of line they're editing. Reuses existing tailwind classes.
function LineTypeChip({ lineType }: { lineType: PoLineType }) {
  const label = lineType.charAt(0).toUpperCase() + lineType.slice(1);
  return (
    <span
      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium text-muted-foreground bg-muted/40"
      data-testid={`chip-line-type-${lineType}`}
    >
      {label}
    </span>
  );
}

// Non-product line row (discount / fee / tax / rebate / adjustment).
// Layout differs from product lines: free-text description instead of a
// SKU typeahead, qty visible-but-fixed for most types, signed amount for
// discount/rebate/adjustment. Discount/rebate also expose an "Applies to"
// dropdown that targets a specific product line via parentClientId.
function NonProductLineRow({
  line,
  idx,
  onChange,
  onRemove,
  productLineOptions,
}: {
  line: LineDraft;
  idx: number;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  productLineOptions: Array<{ clientId: string; label: string }>;
}) {
  const lineType = line.lineType;
  // Adjustment is the only type that's truly signed in the UI — the user
  // explicitly chooses direction. Discount and rebate are conceptually
  // negative-only: the user types a positive amount ("5%", "$50") and the
  // sign is implied by the line type. We auto-negate on update so it's
  // impossible to save a positive discount.
  const allowNegative = lineType === "adjustment";
  const isImplicitNegative =
    lineType === "discount" || lineType === "rebate";
  const qtyEditable = lineType === "fee";
  const showAppliesTo = lineType === "discount" || lineType === "rebate";

  const lineTotalCents =
    Number(line.orderQty) !== 0 && Number(line.unitCostMills) !== 0
      ? signedComputeLineTotalCents(
          Number(line.unitCostMills),
          Number(line.orderQty),
        )
      : 0;

  const totalIsNegative = lineTotalCents < 0;

  return (
    <div className="grid grid-cols-12 gap-2 items-start bg-muted/20 border border-dashed rounded-md p-2">
      {/* Description + chip */}
      <div className="col-span-12 md:col-span-6 space-y-1">
        <div className="flex items-center gap-2">
          <LineTypeChip lineType={lineType} />
          {showAppliesTo && (
            <Select
              value={line.parentClientId ?? "__all__"}
              onValueChange={(v) =>
                onChange({ parentClientId: v === "__all__" ? null : v })
              }
            >
              <SelectTrigger
                className="h-7 w-auto px-2 text-xs"
                data-testid={`select-parent-line-${idx}`}
              >
                <SelectValue placeholder="Applies to..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All product lines</SelectItem>
                {productLineOptions.map((opt) => (
                  <SelectItem key={opt.clientId} value={opt.clientId}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <Input
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder={
            lineType === "discount"
              ? "Vendor promo, volume discount, etc."
              : lineType === "fee"
              ? "Freight, tooling, small-order fee, etc."
              : lineType === "tax"
              ? "Sales tax, VAT, etc."
              : lineType === "rebate"
              ? "Loyalty / volume rebate"
              : "Reason for adjustment"
          }
          aria-label={`Line ${idx + 1} description`}
          data-testid={`input-line-description-${idx}`}
        />
      </div>

      {/* Qty */}
      <div className="col-span-4 md:col-span-2">
        {qtyEditable ? (
          <QuantityInput
            qty={line.orderQty}
            onChangeQty={(q) => onChange({ orderQty: q })}
            ariaLabel={`Line ${idx + 1} quantity`}
          />
        ) : (
          <Input
            value={line.orderQty}
            disabled
            className="text-center text-muted-foreground"
            aria-label={`Line ${idx + 1} quantity (fixed at 1)`}
          />
        )}
      </div>

      {/* Amount (signed for adjustment, auto-negated for discount/rebate) */}
      <div className="col-span-4 md:col-span-2">
        <UnitCostInput
          // For discount/rebate, present the amount as a positive number to
          // the user (the magnitude). The line_type already encodes the sign.
          // Storage is still negative; we mirror via Math.abs on display and
          // re-apply the negative on update.
          mills={
            isImplicitNegative
              ? Math.abs(line.unitCostMills)
              : line.unitCostMills
          }
          onChangeMills={(mills) => {
            if (isImplicitNegative) {
              // Force negative storage. Math.abs first so the user can't
              // accidentally enter a negative; then negate.
              const magnitude = Math.abs(mills);
              onChange({ unitCostMills: magnitude === 0 ? 0 : -magnitude });
            } else {
              onChange({ unitCostMills: mills });
            }
          }}
          ariaLabel={`Line ${idx + 1} amount`}
          allowNegative={allowNegative}
        />
      </div>

      {/* Line total */}
      <div
        className={`col-span-3 md:col-span-1 text-right text-sm pt-2 font-mono ${
          totalIsNegative ? "text-destructive" : ""
        }`}
      >
        {signedFormatCents(lineTotalCents)}
      </div>

      {/* Remove */}
      <div className="col-span-1 text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove line ${idx + 1}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}


type ProductLineTableRowProps = {
  line: LineDraft;
  idx: number;
  error?: string;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  useVendorCatalogSearch: (
    vendorId: number | null,
    q: string,
  ) => ReturnType<typeof useQuery<CatalogSearchResponse>>;
  vendorId: number | null;
  vendorName: string | null;
  productSearch: string;
  setProductSearch: (q: string) => void;
  popoverOpen: boolean;
  setPopoverOpen: (b: boolean) => void;
};

function ProductLineTableRow({
  line,
  idx,
  error,
  onChange,
  onRemove,
  useVendorCatalogSearch,
  vendorId,
  vendorName,
  productSearch,
  setProductSearch,
  popoverOpen,
  setPopoverOpen,
}: ProductLineTableRowProps) {
  const catalogQuery = useVendorCatalogSearch(vendorId, productSearch);
  const inCatalog = catalogQuery.data?.inCatalog ?? [];
  const outOfCatalog = catalogQuery.data?.outOfCatalog ?? [];
  const [quotePopoverOpen, setQuotePopoverOpen] = useState(false);
  const pricingDraft =
    line.pricingDraft ??
    createEmptyPoLinePricingDraft({ quantityPieces: String(line.orderQty || 1) });
  const pricingEvaluation = evaluatePoLinePricingDraft(pricingDraft);
  const activeNormalizedPricing = line.hasExplicitPricing
    ? pricingEvaluation.normalized
    : null;

  // Product economics come from the quote normalizer; packaging remains an
  // independent exact-cent addition.
  const totalProduct =
    activeNormalizedPricing?.totalProductCostCents ??
    (Number(line.totalProductCostCents) || 0);
  const packaging = Number(line.packagingCostCents) || 0;
  const lineTotalCents = totalProduct + packaging;

  // Per-unit values (mills) for below-input microcopy.
  const qty = activeNormalizedPricing?.orderQty ?? (Number(line.orderQty) || 0);
  const productPerUnit =
    activeNormalizedPricing?.unitCostMills ?? perUnitMillsFromCents(totalProduct, qty);
  const packagingPerUnit = perUnitMillsFromCents(packaging, qty);
  const totalPerUnit = perUnitMillsFromCents(totalProduct + packaging, qty);
  const expectedReceiveUnits = Math.max(
    1,
    Number(line.expectedReceiveUnitsPerVariant || 1),
  );
  const expectedReceiveQty = qty > 0
    ? Math.ceil(qty / expectedReceiveUnits)
    : 0;

  const hasError = Boolean(error);
  const hasProduct = Boolean(line.productId);

  return (
    <TooltipProvider delayDuration={200}>
      <TableRow className={`align-top ${hasError ? "bg-amber-50/40" : ""}`}>
        {/* SKU cell */}
        <TableCell className="px-5 py-3">
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                className={`w-full text-left rounded-md border ${hasError ? "border-amber-300 hover:bg-amber-50/60" : "border-slate-200 hover:bg-slate-50"} px-3 py-2 flex items-center justify-between gap-2 text-sm ${hasProduct ? "font-mono" : "text-slate-500"}`}
              >
                <span className="truncate">
                  {hasProduct
                    ? `${line.sku ? `${line.sku}` : line.productName || "(unnamed)"}`
                    : "Search product…"}
                </span>
                <ChevronsUpDown className="size-3.5 text-slate-400 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search name or SKU..."
                  value={productSearch}
                  onValueChange={setProductSearch}
                />
                <CommandList>
                  <CommandEmpty>No products found.</CommandEmpty>
                  {vendorId && inCatalog.length > 0 && (
                    <CommandGroup heading={`In ${vendorName ?? "vendor"}'s catalog`}>
                      {inCatalog.slice(0, 30).map((row) => {
                        const key = `cat-${row.vendorProductId}`;
                        const hints: string[] = [];
                        const quoteStatus = vendorCatalogQuoteStatus(row);
                        if (row.packSize && row.packSize > 1) hints.push(`pack ${row.packSize}`);
                        if (row.moq && row.moq > 1) hints.push(`MOQ ${row.moq}`);
                        if (quoteStatus !== "usable" && quoteStatus !== "legacy") {
                          hints.push("quote review required");
                        }
                        return (
                          <CommandItem
                            key={key}
                            value={key}
                            onSelect={() => {
                              const hasReusableCatalogPricing =
                                isVendorCatalogQuoteReusable(row);
                              const catalogPricingDraft = createVendorCatalogPricingDraft({
                                ...row,
                                moq: Math.max(qty > 0 ? qty : 1, Number(row.moq) || 1),
                              });
                              const receiveConfiguration = catalogReceiveConfiguration(row);
                              onChange({
                                ...normalizedPricingPatch(
                                  catalogPricingDraft,
                                  hasReusableCatalogPricing ? "vendor_catalog" : "manual",
                                ),
                                productId: row.productId,
                                ...receiveConfiguration,
                                productName: row.productName,
                                sku: row.sku ?? null,
                                vendorProductId: row.vendorProductId,
                                catalogOriginallyAbsent: false,
                                quoteReference: row.quoteReference ?? null,
                                quotedAt: row.quotedAt ?? null,
                                quoteValidUntil: row.quoteValidUntil ?? null,
                              });
                              setPopoverOpen(false);
                              setProductSearch("");
                            }}
                          >
                            <span className="mr-2 text-amber-500" aria-label="In vendor catalog" title="In vendor catalog">
                              ★
                            </span>
                            <span className="font-mono text-xs mr-2 text-muted-foreground">
                              {row.sku ?? "—"}
                            </span>
                            <span className="truncate flex-1">
                              {row.productName}
                              {row.variantName ? ` · ${row.variantName}` : ""}
                            </span>
                            <span className="ml-2 text-xs tabular-nums">
                              {formatVendorCatalogQuote(row)}
                              {hints.length > 0 && (
                                <span className="text-muted-foreground"> · {hints.join(", ")}</span>
                              )}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                  {outOfCatalog.length > 0 && (
                    <CommandGroup heading={vendorId ? "All products (not in catalog)" : "All products"}
                    >
                      {outOfCatalog.slice(0, 30).map((row) => {
                        const key = `pv-${row.productId}-${row.productVariantId ?? "null"}`;
                        return (
                          <CommandItem
                            key={key}
                            value={key}
                            onSelect={() => {
                              const manualPricingDraft = createEmptyPoLinePricingDraft({
                                quantityPieces: String(qty > 0 ? qty : 1),
                              });
                              onChange({
                                productId: row.productId,
                                productVariantId: row.productVariantId ?? null,
                                expectedReceiveVariantId: row.productVariantId ?? null,
                                expectedReceiveUnitsPerVariant: 1,
                                productName: row.productName,
                                sku: row.sku ?? null,
                                vendorProductId: null,
                                catalogOriginallyAbsent: vendorId ? true : null,
                                pricingDraft: manualPricingDraft,
                                hasExplicitPricing: false,
                                preserveLegacyPricing: false,
                                pricingSource: "manual",
                                quoteReference: null,
                                quotedAt: null,
                                quoteValidUntil: null,
                                unitCostMills: 0,
                                totalProductCostCents: 0,
                              });
                              setPopoverOpen(false);
                              setProductSearch("");
                            }}
                          >
                            <span className="font-mono text-xs mr-2 text-muted-foreground">
                              {row.sku ?? "—"}
                            </span>
                            <span className="truncate flex-1">
                              {row.productName}
                              {row.variantName ? ` · ${row.variantName}` : ""}
                            </span>
                            {vendorId && (
                              <span className="ml-2 text-[10px] text-muted-foreground italic">
                                not in catalog
                              </span>
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {/* Product description or validation error */}
          {hasError ? (
            <p className="text-xs text-amber-700 mt-1" role="alert" data-testid={`error-line-${idx}`}
            >
              {error}
            </p>
          ) : hasProduct ? (
            <p className="text-xs text-slate-500 mt-1 truncate">
              {line.productName || line.sku || ""}
            </p>
          ) : null}
        </TableCell>

        {/* Piece quantity is derived from the quote basis. */}
        <TableCell className="px-3 py-3 text-right">
          <div className="font-mono text-sm tabular-nums py-2" data-testid={`line-qty-${idx}`}>
            {qty > 0 ? qty.toLocaleString() : "—"}
          </div>
          <div className="text-[10px] text-slate-400">from quote</div>
        </TableCell>

        <TableCell className="px-3 py-3">
          <div className="text-sm text-slate-700">
            {expectedReceiveUnits > 1
              ? `${expectedReceiveQty.toLocaleString()} x ${expectedReceiveUnits.toLocaleString()} pcs`
              : "Pieces"}
          </div>
          {expectedReceiveUnits > 1 && (
            <div className="text-xs text-slate-400 mt-1">
              {qty.toLocaleString()} pcs total
            </div>
          )}
        </TableCell>

        {/* Vendor quote cell */}
        <TableCell className="px-3 py-3">
          <Popover open={quotePopoverOpen} onOpenChange={setQuotePopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`w-full rounded-md border px-3 py-2 text-left hover:bg-slate-50 ${
                  line.hasExplicitPricing ? "border-slate-200" : "border-amber-300 bg-amber-50/40"
                }`}
                aria-label={`Edit vendor quote for line ${idx + 1}`}
              >
                <span className="block text-xs text-slate-500">
                  {line.hasExplicitPricing
                    ? pricingBasisLabel(pricingDraft.basis)
                    : line.preserveLegacyPricing
                      ? "Legacy pricing — review"
                      : "Enter vendor quote"}
                </span>
                <span className="block text-right font-mono text-sm font-medium tabular-nums">
                  {!pricingEvaluation.normalized && !line.preserveLegacyPricing
                    ? "—"
                    : formatCents(totalProduct)}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(42rem,calc(100vw-2rem))] max-h-[80vh] overflow-y-auto p-5"
            >
              <div className="space-y-5">
                <div>
                  <div className="font-semibold">Vendor quote</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Preserve the quote exactly as the supplier issued it. Receiving configuration is separate.
                  </p>
                </div>

                {line.preserveLegacyPricing && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                    <p>
                      This legacy line has no recorded quote basis. It will remain unchanged unless you confirm or edit this pricing.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!pricingEvaluation.normalized}
                      onClick={() => onChange(normalizedPricingPatch(pricingDraft, "manual"))}
                    >
                      Confirm as price per item
                    </Button>
                  </div>
                )}

                <PoLinePricingEditor
                  value={pricingDraft}
                  onChange={(next) => onChange(normalizedPricingPatch(next, "manual"))}
                  receiveConfiguration={{
                    label: line.productName || line.sku || "Selected product",
                    unitsPerVariant: expectedReceiveUnits,
                  }}
                />

                <div className="border-t pt-4 space-y-3">
                  <div className="space-y-2">
                    <Label>Pricing source</Label>
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      {pricingSourceLabel(line.pricingSource)}
                    </div>
                  </div>
                  {line.hasExplicitPricing ? (
                    <PoLineQuoteMetadataEditor
                      value={poLineQuoteMetadataDraft(line)}
                      onChange={(next) => onChange(quoteMetadataEditorLinePatch(line, next))}
                    />
                  ) : (
                    <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      Confirm the vendor quote basis and amount before adding quote reference or validity details.
                    </p>
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <div className="text-xs text-slate-400 text-right mt-1 tabular-nums">
            {formatPerUnit(productPerUnit)}/piece
          </div>
        </TableCell>

        {/* Packaging cell */}
        <TableCell className="px-3 py-3">
          <div className="relative w-full">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
            <DollarInput
              cents={line.packagingCostCents ?? 0}
              onChangeCents={(c) => {
                const packagingCostCents = Math.max(0, c);
                onChange({ packagingCostCents });
              }}
              ariaLabel={`Line ${idx + 1} packaging cost`}
              className="w-full pl-6 pr-2"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-xs text-slate-400 text-right mt-1 tabular-nums cursor-help">
                {formatPerUnit(packagingPerUnit)}/unit
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="text-xs">
              Full precision: {perUnitFullPrecisionDollars(packagingPerUnit)}/unit
            </TooltipContent>
          </Tooltip>
        </TableCell>

        {/* Total Cost cell — read-only */}
        <TableCell className="px-3 py-3">
          <div className="text-right font-mono font-semibold text-sm py-2" data-testid={`line-total-${idx}`}>
            {formatCents(lineTotalCents)}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-xs text-slate-400 text-right mt-1 tabular-nums cursor-help">
                {formatPerUnit(totalPerUnit)}/unit
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="text-xs">
              Full precision: {perUnitFullPrecisionDollars(totalPerUnit)}/unit
            </TooltipContent>
          </Tooltip>
        </TableCell>

        {/* Trash cell */}
        <TableCell className="px-2 py-3 text-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove line ${idx + 1}`}
            className="text-slate-400 hover:text-red-600 hover:bg-transparent"
          >
            <Trash2 className="size-4" />
          </Button>
        </TableCell>
      </TableRow>
    </TooltipProvider>
  );
}
