// Pure helpers for the Reorder Engine cockpit (client/src/pages/ReorderEngine.tsx).
//
// Everything here is presentation-layer: chip unions, grouping/rollups, date
// labels, and deep-link parsing. The single-engine invariant applies — nothing
// in this module recomputes forecast/reorder math; every planning number
// (reorder point, adjusted reorder point, suggested pieces, days of supply)
// comes straight from the engine item. The only arithmetic performed is
// display aggregation (sums/counts of engine numbers) and calendar labels.
//
// Time is injected (asOf / now parameters) per the determinism rule — no
// hidden Date.now() calls.

import { centsToMills, computeLineTotalCentsFromMills, millsToCents } from "@shared/utils/money";

// ---------------------------------------------------------------------------
// Item shape — the subset of the engine's PurchasingRecommendationItem that
// the cockpit consumes (see server/modules/procurement/purchasing-recommendation.engine.ts).
// ---------------------------------------------------------------------------

export type ReorderEngineStatus =
  | "stockout"
  | "order_now"
  | "order_soon"
  | "on_order"
  | "ok"
  | "no_movement";

/** Engine sentinel: daysOfSupply >= this means "no movement / infinite supply". */
export const INFINITE_DAYS_OF_SUPPLY = 9999;

/** Overstock display threshold (days of supply), per design spec rev 1-3. */
export const OVERSTOCK_DAYS_OF_SUPPLY = 180;

export interface ChipFilterItem {
  status: string;
  daysOfSupply: number;
}

export interface SuggestedSpendItem {
  suggestedOrderPieces: number;
  estimatedCostMills: number | null;
  estimatedCostCents: number | null;
  /**
   * Engine skip reason. The engine dual-lists non-excluded skipped rows
   * (no_vendor, already_on_order, …) in BOTH `items` and `skippedItems`.
   * Queue truth (PR feat/reorder-queue-truth): `no_vendor` rows have REAL
   * demand — the skip ladder only assigns no_vendor to actionable-status rows
   * with a positive suggestion — so they render and aggregate as first-class
   * order-queue rows (their spend lands under the missing-cost qualifier).
   * Every OTHER skip reason still renders "—" and is excluded from spend.
   */
  skippedReason?: string | null;
}

/**
 * True for the engine's dual-listed "real demand, no vendor mapping" rows.
 * Needing to order is the fact; the missing vendor mapping is app hygiene —
 * these rows are order-queue members, not skipped rows.
 */
export function isVendorGapRow(item: { skippedReason?: string | null }): boolean {
  return item.skippedReason === "no_vendor";
}

/**
 * True when a row gets the muted "skipped" table treatment (grey row, dashed
 * cells). Vendor-gap rows are deliberately NOT display-skipped — they show
 * their true engine status plus an honest "No vendor yet" badge.
 */
export function isDisplaySkipped(item: { skippedReason?: string | null }): boolean {
  return item.skippedReason !== null && item.skippedReason !== undefined && !isVendorGapRow(item);
}

export interface GroupableItem extends SuggestedSpendItem {
  category: string | null;
  productLines: string[];
  available: number;
  currentSupply: { effectiveSupplyPieces: number };
  forwardDemandBasis: { adjustedReorderPoint: number };
  skippedReason?: string | null;
}

// ---------------------------------------------------------------------------
// Status metadata (canonical mapping from the approved mock)
// ---------------------------------------------------------------------------

export const STATUS_META: Record<
  ReorderEngineStatus,
  { label: string; tone: "red" | "orange" | "amber" | "blue" | "green" | "gray" }
> = {
  stockout: { label: "Stockout", tone: "red" },
  order_now: { label: "Order now", tone: "orange" },
  order_soon: { label: "Burn rate high", tone: "amber" },
  on_order: { label: "Inbound covers", tone: "blue" },
  ok: { label: "Healthy", tone: "green" },
  no_movement: { label: "Stagnant", tone: "gray" },
};

/** Severity order for the default (ungrouped) sort — most urgent first. */
const STATUS_SEVERITY: readonly string[] = [
  "stockout",
  "order_now",
  "order_soon",
  "on_order",
  "ok",
  "no_movement",
];

export function statusSeverityRank(status: string): number {
  const index = STATUS_SEVERITY.indexOf(status);
  return index === -1 ? STATUS_SEVERITY.length : index;
}

// ---------------------------------------------------------------------------
// Two-tier additive chips
// ---------------------------------------------------------------------------

export type ChipKey =
  | "needs_order"
  | "order_soon"
  | "on_order"
  | "ok"
  | "stagnant"
  | "overstock";

export const ALL_CHIP_KEYS: readonly ChipKey[] = [
  "needs_order",
  "order_soon",
  "on_order",
  "ok",
  "stagnant",
  "overstock",
];

/** Default cockpit view = the order queue (rev 2). */
export const DEFAULT_CHIP_SELECTION: readonly ChipKey[] = ["needs_order", "order_soon"];

/**
 * Overstocked is a derived display state: engine status `ok` with more than
 * 180 days of supply but below the 9999 "no movement" sentinel. It deliberately
 * overlaps Healthy — chips are a union, so the overlap is safe (mock comment).
 */
export function isOverstocked(item: ChipFilterItem): boolean {
  return (
    item.status === "ok" &&
    item.daysOfSupply > OVERSTOCK_DAYS_OF_SUPPLY &&
    item.daysOfSupply < INFINITE_DAYS_OF_SUPPLY
  );
}

export function chipMatchesItem(chip: ChipKey, item: ChipFilterItem): boolean {
  switch (chip) {
    case "needs_order":
      return item.status === "stockout" || item.status === "order_now";
    case "order_soon":
      return item.status === "order_soon";
    case "on_order":
      return item.status === "on_order";
    case "ok":
      return item.status === "ok";
    case "stagnant":
      return item.status === "no_movement";
    case "overstock":
      return isOverstocked(item);
  }
}

export function allChipsSelected(selected: ReadonlySet<ChipKey>): boolean {
  return ALL_CHIP_KEYS.every((key) => selected.has(key));
}

/** True when the selection is exactly the default order-queue view. */
export function isOrderQueueSelection(selected: ReadonlySet<ChipKey>): boolean {
  return (
    selected.size === DEFAULT_CHIP_SELECTION.length &&
    DEFAULT_CHIP_SELECTION.every((key) => selected.has(key))
  );
}

/** Union filter: an item shows when ANY selected chip matches. All-on = show everything. */
export function filterItemsByChips<T extends ChipFilterItem>(
  items: readonly T[],
  selected: ReadonlySet<ChipKey>,
): T[] {
  if (selected.size === 0 || allChipsSelected(selected)) return [...items];
  return items.filter((item) =>
    ALL_CHIP_KEYS.some((chip) => selected.has(chip) && chipMatchesItem(chip, item)),
  );
}

/**
 * Parse the NEW `status` deep-link param into a chip preselection.
 * Accepts comma-separated engine statuses AND chip keys (`?status=stockout`,
 * `?status=order_soon,on_order`, `?status=overstocked`). Unknown tokens are
 * ignored; returns null when nothing usable remains so callers keep the default.
 */
export function statusParamToChipKeys(statusParam: string | null | undefined): ChipKey[] | null {
  if (!statusParam) return null;
  const mapping: Record<string, ChipKey> = {
    // engine statuses
    stockout: "needs_order",
    order_now: "needs_order",
    order_soon: "order_soon",
    on_order: "on_order",
    ok: "ok",
    no_movement: "stagnant",
    // chip keys / aliases
    needs_order: "needs_order",
    healthy: "ok",
    stagnant: "stagnant",
    overstock: "overstock",
    overstocked: "overstock",
  };
  const chips: ChipKey[] = [];
  for (const rawToken of statusParam.split(",")) {
    const chip = mapping[rawToken.trim().toLowerCase()];
    if (chip && !chips.includes(chip)) chips.push(chip);
  }
  return chips.length > 0 ? chips : null;
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * The five legacy params emitted by server-side link generators and frozen
 * into persisted notification rows (design spec §13). `recommendationId` is
 * honored natively (scroll + highlight + open drawer); the other four describe
 * the review queue, which now lives on the Automation page
 * (/procurement/automation) — the cockpit shows a banner linking there with
 * the full original query preserved.
 */
export const LEGACY_REVIEW_PARAM_KEYS = [
  "reviewQueue",
  "reason",
  "forecastAction",
  "candidateBand",
] as const;

export interface ReorderEngineDeepLink {
  /** recommendationId param — scroll to + highlight the row and open its drawer. */
  recommendationId: string | null;
  /** NEW status param — chip preselection (null = keep default). */
  chipSelection: ChipKey[] | null;
  /** True when any review-queue legacy param is present → show the banner. */
  hasLegacyReviewParams: boolean;
  /** Automation page URL preserving the FULL original query string. */
  automationUrl: string;
}

export function parseReorderEngineDeepLink(params: URLSearchParams): ReorderEngineDeepLink {
  const recommendationId = params.get("recommendationId")?.trim() || null;
  const hasLegacyReviewParams = LEGACY_REVIEW_PARAM_KEYS.some(
    (key) => (params.get(key)?.trim() ?? "") !== "",
  );
  const query = params.toString();
  return {
    recommendationId,
    chipSelection: statusParamToChipKeys(params.get("status")),
    hasLegacyReviewParams,
    automationUrl: `/procurement/automation${query ? `?${query}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Dates (UTC calendar math; asOf injected)
// ---------------------------------------------------------------------------

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** "2026-08-04" → "Aug 4". Returns "" for null/invalid input. */
export function formatIsoDateShort(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return "";
  const [, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  return `${MONTH_LABELS[month - 1]} ${day}`;
}

export interface OrderSoonDates {
  /** Projected stockout: asOf + daysOfSupply. */
  stockoutDate: string;
  /** Order-by: asOf + max(0, daysOfSupply − (leadTimeDays + safetyStockDays)). */
  orderByDate: string;
}

/**
 * Projected dates for order_soon rows (design spec rev 2). Pure calendar
 * labels derived from engine numbers — not planning math.
 */
export function orderSoonDates(
  asOfIsoDate: string,
  item: { daysOfSupply: number; leadTimeDays: number; safetyStockDays: number },
): OrderSoonDates {
  return {
    stockoutDate: addDaysToIsoDate(asOfIsoDate, item.daysOfSupply),
    orderByDate: addDaysToIsoDate(
      asOfIsoDate,
      Math.max(0, item.daysOfSupply - (item.leadTimeDays + item.safetyStockDays)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Money display aggregation (integer cents; no floating point money)
// ---------------------------------------------------------------------------

/**
 * Per-piece unit cost in mills from the engine's supplier basis fields.
 * Prefers mills (higher precision); falls back to cents. Null when the
 * engine has no usable cost (costSource "missing").
 */
export function unitCostMills(item: SuggestedSpendItem): number | null {
  if (item.estimatedCostMills !== null && item.estimatedCostMills !== undefined) {
    return item.estimatedCostMills;
  }
  if (item.estimatedCostCents !== null && item.estimatedCostCents !== undefined) {
    return centsToMills(item.estimatedCostCents);
  }
  return null;
}

/** Per-piece cost in display cents (half-up from mills). Null when the engine has no cost. */
export function unitCostCents(item: SuggestedSpendItem): number | null {
  const mills = unitCostMills(item);
  return mills === null ? null : millsToCents(mills);
}

/** Line value in cents: suggestedOrderPieces × per-piece cost. Null when cost is missing. */
export function suggestedValueCents(item: SuggestedSpendItem): number | null {
  const mills = unitCostMills(item);
  if (mills === null || item.suggestedOrderPieces <= 0) {
    return item.suggestedOrderPieces > 0 ? null : 0;
  }
  return computeLineTotalCentsFromMills(mills, item.suggestedOrderPieces);
}

export interface SuggestedSpendSummary {
  totalCents: number;
  /** SKUs with a positive suggested order. */
  skuCount: number;
  /** SKUs suggested for order whose supplier cost is missing (excluded from the total). */
  missingCostCount: number;
}

/**
 * Suggested-spend KPI: sum of pieces × per-piece supplier cost over items the
 * engine suggests ordering. Client-side per design spec §13 ("suggested-spend
 * (client-computed acceptable)"). Items without a usable cost are counted but
 * contribute $0 — the count is surfaced so the KPI is honest about coverage.
 * Display-skipped rows (the engine dual-lists them in `items`) never count:
 * their table row renders "—", so the KPI must not disagree with the table.
 * Vendor-gap (no_vendor) rows DO count — the table shows their suggestion,
 * and having no vendor almost always means no cost, so they surface through
 * the existing missing-cost qualifier (PR feat/reorder-queue-truth).
 */
export function computeSuggestedSpend(items: readonly SuggestedSpendItem[]): SuggestedSpendSummary {
  let totalCents = 0;
  let skuCount = 0;
  let missingCostCount = 0;
  for (const item of items) {
    if (isDisplaySkipped(item)) continue;
    if (item.suggestedOrderPieces <= 0) continue;
    skuCount += 1;
    const cents = suggestedValueCents(item);
    if (cents === null) {
      missingCostCount += 1;
      continue;
    }
    totalCents += cents;
  }
  return { totalCents, skuCount, missingCostCount };
}

/** Available on-hand value in cents (available pieces × per-piece cost); 0 when cost missing. */
export function availableValueCents(item: SuggestedSpendItem & { available: number }): number {
  const mills = unitCostMills(item);
  if (mills === null || item.available <= 0) return 0;
  return computeLineTotalCentsFromMills(mills, item.available);
}

/** "$1,813,500.00-style" compact money: whole dollars >= $100, cents below. */
export function formatMoneyCents(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 100 || cents % 100 === 0) {
    return `$${Math.round(dollars).toLocaleString("en-US")}`;
  }
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Grouping + rollups
// ---------------------------------------------------------------------------

export type ReorderGroupBy = "none" | "category" | "productLine";

export const UNCATEGORIZED_GROUP_LABEL = "Uncategorized";
export const NO_PRODUCT_LINE_GROUP_LABEL = "No product line";

export interface ReorderGroupRollup {
  skuCount: number;
  /** Non-skipped SKUs whose effective supply is under the adjusted reorder point (engine numbers). */
  belowReorderPointCount: number;
  suggestedCents: number;
  onHandCents: number;
}

export interface ReorderGroup<T> {
  key: string;
  items: T[];
  rollup: ReorderGroupRollup;
}

export function computeGroupRollup<T extends GroupableItem>(items: readonly T[]): ReorderGroupRollup {
  let belowReorderPointCount = 0;
  let suggestedCents = 0;
  let onHandCents = 0;
  for (const item of items) {
    // Vendor-gap (no_vendor) rows are NOT display-skipped: their demand is
    // real, so they count toward below-RP and suggested $ like any active row
    // (PR feat/reorder-queue-truth).
    const skipped = isDisplaySkipped(item);
    if (
      !skipped &&
      item.currentSupply.effectiveSupplyPieces < item.forwardDemandBasis.adjustedReorderPoint
    ) {
      belowReorderPointCount += 1;
    }
    // Display-skipped rows render "—" in the Suggested column, so their
    // (possibly positive) engine suggestion must not inflate the group's
    // suggested $. On-hand value is real stock regardless, so it always counts.
    if (!skipped) suggestedCents += suggestedValueCents(item) ?? 0;
    onHandCents += availableValueCents(item);
  }
  return { skuCount: items.length, belowReorderPointCount, suggestedCents, onHandCents };
}

/**
 * Group items for the table. Product-line grouping duplicates a product under
 * EACH of its lines (design decision: a product in multiple lines appears
 * under each). Group order follows first appearance in the (already sorted)
 * input, matching the mock.
 */
export function groupReorderItems<T extends GroupableItem>(
  items: readonly T[],
  groupBy: ReorderGroupBy,
): ReorderGroup<T>[] {
  if (groupBy === "none") {
    return [{ key: "", items: [...items], rollup: computeGroupRollup(items) }];
  }
  const keysInOrder: string[] = [];
  const byKey = new Map<string, T[]>();
  const add = (key: string, item: T) => {
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      keysInOrder.push(key);
    }
    bucket.push(item);
  };
  for (const item of items) {
    if (groupBy === "category") {
      add(item.category?.trim() || UNCATEGORIZED_GROUP_LABEL, item);
    } else {
      const lines = item.productLines.filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        add(NO_PRODUCT_LINE_GROUP_LABEL, item);
      } else {
        for (const line of lines) add(line, item);
      }
    }
  }
  return keysInOrder.map((key) => {
    const groupItems = byKey.get(key)!;
    return { key, items: groupItems, rollup: computeGroupRollup(groupItems) };
  });
}

// ---------------------------------------------------------------------------
// Trend + confidence display
// ---------------------------------------------------------------------------

export interface TrendDisplay {
  symbol: "up" | "down" | "flat" | "none";
  tooltip: string;
}

/**
 * Trend arrow + ratio tooltip from the engine's demand-basis fields. The
 * ratio (period vs prior period) is display-only context, mirroring the
 * mock's "Last 30d vs prior 30d: 1.45×" tooltip.
 */
export function trendDisplay(basis: {
  demandTrend: string;
  lookbackDays: number;
  periodUsagePieces: number;
  priorPeriodUsagePieces: number | null;
}): TrendDisplay {
  const ratio =
    basis.priorPeriodUsagePieces !== null && basis.priorPeriodUsagePieces > 0
      ? basis.periodUsagePieces / basis.priorPeriodUsagePieces
      : null;
  const ratioLabel =
    ratio !== null
      ? `Last ${basis.lookbackDays}d vs prior ${basis.lookbackDays}d: ${ratio.toFixed(2)}×`
      : "New demand — no sales in the prior window";
  switch (basis.demandTrend) {
    case "rising":
      return { symbol: "up", tooltip: ratioLabel };
    case "falling":
      return { symbol: "down", tooltip: ratioLabel };
    case "stable":
      return { symbol: "flat", tooltip: ratioLabel };
    case "new_demand":
      return { symbol: "up", tooltip: "New demand — no sales in the prior window" };
    default:
      return { symbol: "none", tooltip: "No recent demand" };
  }
}

const DEMAND_QUALITY_LABELS: Record<string, string> = {
  normal: "normal history",
  thin_history: "thin history",
  no_recent_demand: "no recent demand",
};

const LEAD_TIME_SOURCE_LABELS: Record<string, string> = {
  vendor_product: "vendor lead time",
  product: "product lead-time override",
  default: "default lead time",
};

export function leadTimeSourceLabel(source: string): string {
  return LEAD_TIME_SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

/**
 * Confidence badge tooltip composed from engine fields: trend (+ratio),
 * demand quality, last-sale age, lead-time source. `nowMs` injected so the
 * age label is deterministic in tests.
 */
export function confidenceTooltip(
  item: {
    demandBasis: {
      demandTrend: string;
      demandQuality: string;
      lookbackDays: number;
      periodUsagePieces: number;
      priorPeriodUsagePieces: number | null;
      latestDemandAt: string | Date | null;
    };
    leadTimeBasis: { leadTimeSource: string };
  },
  nowMs: number,
): string {
  const { demandBasis } = item;
  const trendWord =
    demandBasis.demandTrend === "new_demand"
      ? "New-demand"
      : demandBasis.demandTrend.charAt(0).toUpperCase() +
        demandBasis.demandTrend.slice(1).replace(/_/g, " ");
  const ratio =
    demandBasis.priorPeriodUsagePieces !== null && demandBasis.priorPeriodUsagePieces > 0
      ? `${(demandBasis.periodUsagePieces / demandBasis.priorPeriodUsagePieces).toFixed(2)}×`
      : "new demand";
  const quality = DEMAND_QUALITY_LABELS[demandBasis.demandQuality] ?? demandBasis.demandQuality;
  const lastSale = (() => {
    if (!demandBasis.latestDemandAt) return "no recorded sales";
    const at = new Date(demandBasis.latestDemandAt).getTime();
    if (Number.isNaN(at)) return "no recorded sales";
    const days = Math.max(0, Math.floor((nowMs - at) / 86_400_000));
    return `last sale ${days}d ago`;
  })();
  return `${trendWord} trend (${ratio}) · ${quality} · ${lastSale} · ${leadTimeSourceLabel(item.leadTimeBasis.leadTimeSource)}`;
}

// ---------------------------------------------------------------------------
// Days-of-supply bar
// ---------------------------------------------------------------------------

export interface DaysOfSupplyDisplay {
  infinite: boolean;
  /** Bar width 0-100 (60 days = full bar, mock scale). */
  percent: number;
  tone: "red" | "amber" | "green";
}

export function daysOfSupplyDisplay(item: {
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockDays: number;
}): DaysOfSupplyDisplay {
  const infinite = item.daysOfSupply >= INFINITE_DAYS_OF_SUPPLY;
  if (infinite) return { infinite: true, percent: 100, tone: "green" };
  const tone =
    item.daysOfSupply < item.leadTimeDays
      ? "red"
      : item.daysOfSupply < item.leadTimeDays + item.safetyStockDays
        ? "amber"
        : "green";
  return {
    infinite: false,
    percent: Math.max(3, Math.min(100, (item.daysOfSupply / 60) * 100)),
    tone,
  };
}

// ---------------------------------------------------------------------------
// Skip reasons (excluded/skipped toggle)
// ---------------------------------------------------------------------------

/**
 * Rows for the "Show excluded" appendix, SKU-sorted. The engine dual-lists
 * non-excluded skipped rows in BOTH `items` and `skippedItems` (the latter is
 * a review-queue view), so any row already visible in the main list must not
 * repeat in the appendix — dedupe by recommendationId.
 */
export function skippedAppendixRows<T extends { recommendationId: string; sku: string }>(
  skippedItems: readonly T[],
  visibleIds: ReadonlySet<string>,
): T[] {
  return skippedItems
    .filter((item) => !visibleIds.has(item.recommendationId))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

const SKIP_REASON_LABELS: Record<string, string> = {
  excluded: "Excluded by planning policy",
  already_on_order: "Open PO covers the gap",
  no_vendor: "No vendor assigned",
  not_actionable_status: "Not actionable",
  zero_suggested_quantity: "No order needed",
};

export function skippedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Skipped";
  return SKIP_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Order Builder (PR 3) — selection state, case rounding, evidence assembly.
//
// All functions are pure and never mutate inputs. Quantities are integer
// pieces; money stays in integer cents/mills (no floating point). Every
// server-facing rule mirrored here (case increment, override evidence,
// decision-note minimums) is display-side enforcement only — the server
// re-validates and stays authoritative.
// ---------------------------------------------------------------------------

/** Per-line Order Builder state, keyed by recommendationId. */
export interface OrderLineState {
  /** Operator-edited pieces (integer >= 0; 0 = skip this line at submit). */
  pieces: number;
  /** Reason typed for exceeding/changing the baseline; may be blank until required. */
  exceedReason: string;
}

export type OrderSelection = ReadonlyMap<string, OrderLineState>;

/**
 * Display mirror of the engine's effective order increment
 * (purchasing-recommendation.engine.ts, spec §12.1): the quoted
 * pieces-per-purchase-UOM is the case pack; vendor pack_size is the fallback
 * for per-piece quotes; otherwise a single piece. The engine already rounds
 * `suggestedOrderPieces` with this rule — the builder only snaps EDITS.
 */
export function orderIncrementPieces(basis: {
  piecesPerPurchaseUom: number | null;
  packSize?: number | null;
}): number {
  if (basis.piecesPerPurchaseUom !== null && basis.piecesPerPurchaseUom > 1) {
    return basis.piecesPerPurchaseUom;
  }
  const packSize = basis.packSize ?? null;
  if (packSize !== null && packSize > 1) return packSize;
  return 1;
}

/**
 * Case snap on blur: 0 stays 0 ("skip this line"); anything positive rounds
 * UP to the next full case (design spec §12.1 — full-case rounding is a rule,
 * not a hint). Invalid/negative input collapses to 0.
 */
export function snapPiecesUpToCase(pieces: number, incrementPieces: number): number {
  if (!Number.isFinite(pieces) || pieces <= 0) return 0;
  const whole = Math.ceil(pieces);
  if (!Number.isFinite(incrementPieces) || incrementPieces <= 1) return whole;
  return Math.ceil(whole / incrementPieces) * incrementPieces;
}

/** Add ⇄ remove toggle for a row. Adding defaults pieces to the engine suggestion. */
export function toggleOrderLine(
  selection: OrderSelection,
  recommendationId: string,
  suggestedOrderPieces: number,
): Map<string, OrderLineState> {
  const next = new Map(selection);
  if (next.has(recommendationId)) {
    next.delete(recommendationId);
  } else {
    next.set(recommendationId, {
      pieces: Math.max(0, Math.floor(suggestedOrderPieces)),
      exceedReason: "",
    });
  }
  return next;
}

export function removeOrderLine(
  selection: OrderSelection,
  recommendationId: string,
): Map<string, OrderLineState> {
  const next = new Map(selection);
  next.delete(recommendationId);
  return next;
}

export function setOrderLinePieces(
  selection: OrderSelection,
  recommendationId: string,
  pieces: number,
): Map<string, OrderLineState> {
  const current = selection.get(recommendationId);
  if (!current) return new Map(selection);
  const next = new Map(selection);
  next.set(recommendationId, {
    ...current,
    pieces: Number.isFinite(pieces) && pieces > 0 ? Math.floor(pieces) : 0,
  });
  return next;
}

export function setOrderLineExceedReason(
  selection: OrderSelection,
  recommendationId: string,
  exceedReason: string,
): Map<string, OrderLineState> {
  const current = selection.get(recommendationId);
  if (!current) return new Map(selection);
  const next = new Map(selection);
  next.set(recommendationId, { ...current, exceedReason });
  return next;
}

// ---------------- vendor grouping ----------------

export interface OrderableItem extends SuggestedSpendItem {
  recommendationId: string;
  sku: string;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
}

export const NEEDS_SUPPLIER_GROUP_KEY = "needs_supplier";

export function orderBuilderVendorKey(item: {
  preferredVendorId: number | null;
}): string {
  return item.preferredVendorId === null
    ? NEEDS_SUPPLIER_GROUP_KEY
    : `vendor:${item.preferredVendorId}`;
}

export interface OrderBuilderGroup<T> {
  key: string;
  vendorId: number;
  vendorName: string;
  lines: T[];
}

/**
 * Selected lines grouped by preferred vendor, in item order. Lines without a
 * vendor come back separately — they render in the "Needs supplier" group,
 * which is actionable (PR feat/reorder-queue-truth): assigning a vendor there
 * (optionally with a unit cost) moves the line into that vendor's group. Pass
 * items through `applyStagedVendors` first so client-staged assignments group
 * correctly before the server mapping exists.
 */
export function orderBuilderGroups<T extends OrderableItem>(
  items: readonly T[],
  selection: OrderSelection,
): { vendorGroups: OrderBuilderGroup<T>[]; needsSupplier: T[] } {
  const vendorGroups: OrderBuilderGroup<T>[] = [];
  const byKey = new Map<string, OrderBuilderGroup<T>>();
  const needsSupplier: T[] = [];
  for (const item of items) {
    if (!selection.has(item.recommendationId)) continue;
    if (item.preferredVendorId === null) {
      needsSupplier.push(item);
      continue;
    }
    const key = orderBuilderVendorKey(item);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        vendorId: item.preferredVendorId,
        vendorName: item.preferredVendorName ?? `Vendor ${item.preferredVendorId}`,
        lines: [],
      };
      byKey.set(key, group);
      vendorGroups.push(group);
    }
    group.lines.push(item);
  }
  return { vendorGroups, needsSupplier };
}

// ---------------- inline vendor assignment (PR feat/reorder-queue-truth) ----------------

/**
 * Client-staged vendor choice for a line whose server mapping does not exist
 * yet. Staged WITHOUT a cost, the assignment persists when the quote request
 * is submitted: createRfqBatch (purchasing.service.ts) creates the preferred
 * vendor_products mapping with honest null costs as part of RFQ creation.
 * Staged assignments never unlock the PO path — no mapping means no quote.
 */
export interface StagedVendorAssignment {
  vendorId: number;
  vendorName: string;
}

export type StagedVendorMap = ReadonlyMap<string, StagedVendorAssignment>;

/**
 * Overlay staged vendor choices onto items that have no server-side preferred
 * vendor, so `orderBuilderGroups` places them under the chosen vendor. Items
 * that already carry a server vendor are never overridden; inputs are never
 * mutated.
 */
export function applyStagedVendors<T extends OrderableItem>(
  items: readonly T[],
  staged: StagedVendorMap,
): T[] {
  return items.map((item) => {
    if (item.preferredVendorId !== null) return item;
    const assignment = staged.get(item.recommendationId);
    if (!assignment) return item;
    return {
      ...item,
      preferredVendorId: assignment.vendorId,
      preferredVendorName: assignment.vendorName,
    };
  });
}

/** The supplier-quote fields the PO-eligibility mirror needs. */
export interface SupplierQuoteFields {
  pricingBasis: string;
  purchaseUom: string | null;
  quotedUnitCostMills?: number | null;
  piecesPerPurchaseUom: number | null;
  quotedAt?: string | Date | null;
}

/**
 * Display-side mirror of the PO handoff's quote gate,
 * hasCompleteExplicitRecommendationQuote (purchasing-recommendation.routes.ts):
 * quotedAt must be set, and the pricing basis must be an explicit per-piece
 * quote (no UOM fields) or a per-purchase-UOM quote whose case pack divides
 * the suggested pieces. Anything else — notably `legacy_unknown` mappings and
 * costless RFQ-created mappings — is skipped at handoff with
 * `supplier_quote_basis_review_required`. Display gating only; the server
 * re-validates against the accepted snapshot.
 */
export function hasPoEligibleSupplierQuote(item: {
  suggestedOrderPieces: number;
  supplierBasis?: SupplierQuoteFields | null;
}): boolean {
  const basis = item.supplierBasis;
  if (!basis || !basis.quotedAt) return false;
  const quotedMills = basis.quotedUnitCostMills;
  const hasQuotedCost =
    typeof quotedMills === "number" && Number.isSafeInteger(quotedMills) && quotedMills >= 0;
  if (basis.pricingBasis === "per_piece") {
    return hasQuotedCost && basis.purchaseUom === null && basis.piecesPerPurchaseUom === null;
  }
  if (basis.pricingBasis !== "per_purchase_uom") return false;
  return (
    typeof basis.purchaseUom === "string" &&
    basis.purchaseUom.trim().length > 0 &&
    hasQuotedCost &&
    typeof basis.piecesPerPurchaseUom === "number" &&
    Number.isSafeInteger(basis.piecesPerPurchaseUom) &&
    basis.piecesPerPurchaseUom > 0 &&
    Number.isSafeInteger(item.suggestedOrderPieces) &&
    item.suggestedOrderPieces >= 0 &&
    item.suggestedOrderPieces % basis.piecesPerPurchaseUom === 0
  );
}

/**
 * Effective order mode for a vendor group. A group with NO PO-eligible line
 * cannot produce a PO — the handoff would skip every line with
 * `supplier_quote_basis_review_required` — so the PO radio is disabled and
 * the group is forced onto the quote-request path regardless of any stored
 * choice.
 */
export function effectiveVendorMode(
  stored: VendorOrderMode | undefined,
  groupHasPoEligibleLine: boolean,
): VendorOrderMode {
  if (!groupHasPoEligibleLine) return "rfq";
  return stored ?? "po";
}

/**
 * Parse an operator-typed dollar amount ("4.125") into integer mills without
 * floating-point money math: digits are split on the decimal point and the
 * fraction is right-padded to 4 places. Returns null for anything that is not
 * a plain POSITIVE dollar amount with at most 4 decimal places. Zero is
 * rejected on purpose: this parser feeds the inline vendor+cost save, where a
 * $0 "confirmed quote" would be fake money data — the costless path is the
 * quote request, not a zero-priced mapping.
 */
export function parseUnitCostDollarsToMills(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(trimmed)) return null;
  const [dollars, fraction = ""] = trimmed.split(".");
  const mills = Number(dollars) * 10_000 + Number(fraction.padEnd(4, "0"));
  return Number.isSafeInteger(mills) && mills > 0 ? mills : null;
}

/**
 * Body for POST /api/vendor-products/upsert — the vendor+cost assignment save.
 * The upsert (over plain create) is deliberate: it demotes any competing
 * preferred mapping transactionally instead of tripping the one-active-
 * preferred unique index, and it is keyed on the same
 * (vendor, product, variant) identity the analysis' preferred-vendor lateral
 * matches first. The endpoint REQUIRES a price, so this body is only built
 * when the operator typed a cost — a costless assignment goes through the
 * quote-request path instead (createRfqBatch persists the costless mapping).
 * Per-piece basis with quotedAt=now makes the mapping PO-eligible under
 * hasCompleteExplicitRecommendationQuote.
 */
export function buildVendorAssignmentBody(input: {
  vendorId: number;
  productId: number;
  productVariantId: number;
  unitCostMills: number;
  quotedAtIso: string;
}): {
  vendorId: number;
  productId: number;
  productVariantId: number;
  isPreferred: true;
  pricing: { basis: "per_piece"; quantityPieces: 1; unitCostMills: number };
  quotedAt: string;
} {
  return {
    vendorId: input.vendorId,
    productId: input.productId,
    productVariantId: input.productVariantId,
    isPreferred: true,
    pricing: { basis: "per_piece", quantityPieces: 1, unitCostMills: input.unitCostMills },
    quotedAt: input.quotedAtIso,
  };
}

// ---------------- money (integer cents) ----------------

/** Line value for edited pieces; null when the vendor cost is missing and pieces > 0. */
export function orderLineValueCents(item: SuggestedSpendItem, pieces: number): number | null {
  if (pieces <= 0) return 0;
  const mills = unitCostMills(item);
  if (mills === null) return null;
  return computeLineTotalCentsFromMills(mills, pieces);
}

export interface OrderBarSummary {
  lineCount: number;
  totalCents: number;
  /** Selected lines with pieces > 0 whose supplier cost is unknown (excluded from the total). */
  missingCostCount: number;
}

/** Sticky order-bar rollup over the whole selection (submittable or not). */
export function orderBarSummary(
  items: readonly OrderableItem[],
  selection: OrderSelection,
): OrderBarSummary {
  let lineCount = 0;
  let totalCents = 0;
  let missingCostCount = 0;
  for (const item of items) {
    const line = selection.get(item.recommendationId);
    if (!line) continue;
    lineCount += 1;
    const cents = orderLineValueCents(item, line.pieces);
    if (cents === null) missingCostCount += 1;
    else totalCents += cents;
  }
  return { lineCount, totalCents, missingCostCount };
}

// ---------------- override evidence rules ----------------

export type VendorOrderMode = "po" | "rfq";

/** Server minimums, mirrored for display gating only (routes re-validate). */
export const EXCEED_REASON_MIN_LENGTH = 3;
export const DECISION_NOTE_MIN_LENGTH = 10;
export const AUTO_DECISION_NOTE = "Manual order via Order Builder";
/**
 * Server cap, mirrored: handoffCommandSchema accepts at most 25 items per
 * create-po call. A vendor group above this must fail BEFORE any decision is
 * recorded — otherwise the group's acceptances land and the handoff 400s.
 * Pinned against the server schema by reorder-engine-ui-contract.test.ts.
 */
export const MAX_PO_HANDOFF_LINES = 25;

export function exceedsSuggestion(pieces: number, suggestedOrderPieces: number): boolean {
  return pieces > Math.max(0, suggestedOrderPieces);
}

export function exceedReasonValid(reason: string): boolean {
  return reason.trim().length >= EXCEED_REASON_MIN_LENGTH;
}

/**
 * RFQ evidence baseline. RFQ batches validate against the SAVED run line's
 * remaining pieces (recommendedPieces − already-allocated RFQ pieces), not the
 * live suggestion — use the mapped run value when known, the live suggestion
 * until the mapping loads.
 */
export function rfqBaselinePieces(
  remainingPieces: number | null | undefined,
  suggestedOrderPieces: number,
): number {
  return remainingPieces ?? Math.max(0, suggestedOrderPieces);
}

/** RFQ contract: ANY change from the run baseline needs a >=3-char reason (up or down). */
export function rfqLineNeedsReason(pieces: number, baselinePieces: number): boolean {
  return pieces !== baselinePieces;
}

/** RFQ contract: requesting ABOVE the run baseline additionally needs explicit approval. */
export function rfqLineNeedsApproval(pieces: number, baselinePieces: number): boolean {
  return pieces > baselinePieces;
}

/** PO line is flagged when it carries active quality controls or exceeds the suggestion. */
export function poLineFlagged(
  controlCount: number,
  pieces: number,
  suggestedOrderPieces: number,
): boolean {
  return controlCount > 0 || exceedsSuggestion(pieces, suggestedOrderPieces);
}

/**
 * Decision note for submission. With flagged lines the operator must type a
 * real note (server minimum 10 chars); with nothing flagged a blank note falls
 * back to the auto-note recorded in the audit trail. A 1–9 character note is
 * never sent — the server would reject it.
 */
export function decisionNoteForSubmit(
  note: string,
  anyFlagged: boolean,
): { ok: true; note: string } | { ok: false; error: string } {
  const trimmed = note.trim();
  if (trimmed.length >= DECISION_NOTE_MIN_LENGTH) return { ok: true, note: trimmed };
  if (anyFlagged) {
    return { ok: false, error: `Decision note needs at least ${DECISION_NOTE_MIN_LENGTH} characters` };
  }
  if (trimmed.length === 0) return { ok: true, note: AUTO_DECISION_NOTE };
  return {
    ok: false,
    error: `Decision note needs at least ${DECISION_NOTE_MIN_LENGTH} characters (or leave it blank for the auto-note)`,
  };
}

export function controlAckKey(recommendationId: string, controlCode: string): string {
  return `${recommendationId}:${controlCode}`;
}

// ---------------- confirm gating ----------------

export interface ConfirmPoLineInput {
  recommendationId: string;
  sku: string;
  pieces: number;
  suggestedOrderPieces: number;
  exceedReason: string;
  controls: ReadonlyArray<{ code: string; label: string }>;
}

export interface ConfirmRfqLineInput {
  recommendationId: string;
  sku: string;
  pieces: number;
  baselinePieces: number;
  exceedReason: string;
}

/**
 * First unmet confirm requirement, or null when the order can be created.
 * Check order mirrors the approved mock: control acknowledgments → sourcing
 * exception approvals (PO then RFQ) → decision note. The returned sentence is
 * used verbatim as the disabled button's title.
 */
export function firstUnmetConfirmRequirement(input: {
  poLines: readonly ConfirmPoLineInput[];
  rfqLines: readonly ConfirmRfqLineInput[];
  acknowledgedControlKeys: ReadonlySet<string>;
  approvedExceptionIds: ReadonlySet<string>;
  note: string;
}): string | null {
  for (const line of input.poLines) {
    for (const control of line.controls) {
      if (!input.acknowledgedControlKeys.has(controlAckKey(line.recommendationId, control.code))) {
        return `Acknowledge “${control.label}” for ${line.sku}`;
      }
    }
  }
  for (const line of input.poLines) {
    if (!exceedsSuggestion(line.pieces, line.suggestedOrderPieces)) continue;
    if (!exceedReasonValid(line.exceedReason)) {
      return `Enter a reason (at least ${EXCEED_REASON_MIN_LENGTH} characters) for exceeding the recommendation on ${line.sku}`;
    }
    if (!input.approvedExceptionIds.has(line.recommendationId)) {
      return `Approve the sourcing exception for ${line.sku}`;
    }
  }
  for (const line of input.rfqLines) {
    if (rfqLineNeedsReason(line.pieces, line.baselinePieces) && !exceedReasonValid(line.exceedReason)) {
      return `Enter a reason (at least ${EXCEED_REASON_MIN_LENGTH} characters) for changing the run baseline on ${line.sku}`;
    }
    if (rfqLineNeedsApproval(line.pieces, line.baselinePieces) && !input.approvedExceptionIds.has(line.recommendationId)) {
      return `Approve the sourcing exception for ${line.sku}`;
    }
  }
  const anyFlagged = input.poLines.some((line) =>
    poLineFlagged(line.controls.length, line.pieces, line.suggestedOrderPieces),
  );
  const note = decisionNoteForSubmit(input.note, anyFlagged);
  if (!note.ok) return note.error;
  return null;
}

/** "Create 2 draft POs · 1 RFQ" / "Create 1 draft PO" / "Create 3 RFQs" / "Nothing to order". */
export function confirmPrimaryLabel(poCount: number, rfqCount: number): string {
  const parts: string[] = [];
  if (poCount > 0) parts.push(`${poCount} draft PO${poCount === 1 ? "" : "s"}`);
  if (rfqCount > 0) parts.push(`${rfqCount} RFQ${rfqCount === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Nothing to order";
  return `Create ${parts.join(" · ")}`;
}

// ---------------- server payload assembly ----------------

export type ReviewQueueKind = "skipped" | "held_by_policy" | "quality_review_required";

/** The review-queue facts a PO decision needs: the entry's kind + its CURRENT control codes. */
export interface ReviewQueueLineEntry {
  kind: ReviewQueueKind;
  controlCodes: readonly string[];
}

/**
 * Body for POST /api/purchasing/recommendation-decisions. The strict evidence
 * contract (validateRecommendationDecisionEvidence) requires confirmDecision,
 * the eligibility acknowledgment, and reviewedControlCodes covering EVERY
 * current control — the risk-proportional confirm UI collects the flagged-only
 * ceremony, but the wire payload always satisfies the full server contract.
 */
export function buildAcceptedForPoDecisionBody(
  recommendationId: string,
  entry: ReviewQueueLineEntry,
  note: string,
): {
  recommendationId: string;
  kind: ReviewQueueKind;
  decision: "accepted_for_po";
  note: string;
  confirmDecision: true;
  acknowledgeAutomationEligibilityUnchanged: true;
  reviewedControlCodes: string[];
} {
  return {
    recommendationId,
    kind: entry.kind,
    decision: "accepted_for_po",
    note,
    confirmDecision: true,
    acknowledgeAutomationEligibilityUnchanged: true,
    reviewedControlCodes: [...entry.controlCodes],
  };
}

/**
 * One item for POST /api/purchasing/recommendation-accepted-queue/create-po.
 * Override evidence (reason + approval) is attached ONLY when pieces exceed
 * the suggestion — the handoff schema rejects evidence on non-exceeding lines
 * and rejects exceeding lines without both fields.
 */
export function buildCreatePoItemBody(input: {
  recommendationId: string;
  kind: ReviewQueueKind;
  pieces: number;
  suggestedOrderPieces: number;
  exceedReason: string;
}): {
  recommendationId: string;
  kind: ReviewQueueKind;
  requestedPieces: number;
  quantityOverrideReason?: string;
  allocationOverrideApproved?: true;
} {
  const base = {
    recommendationId: input.recommendationId,
    kind: input.kind,
    requestedPieces: input.pieces,
  };
  if (!exceedsSuggestion(input.pieces, input.suggestedOrderPieces)) return base;
  return {
    ...base,
    quantityOverrideReason: input.exceedReason.trim(),
    allocationOverrideApproved: true,
  };
}

/**
 * One line for POST /api/purchasing/rfq-queue, validated against the saved
 * run line it allocates from. Fail-closed: a line whose collected evidence no
 * longer satisfies the server baseline (e.g. the mapping refreshed to
 * different remaining pieces) reports an error instead of inventing evidence.
 */
export function buildRfqLineBody(input: {
  recommendationLineId: number;
  vendorId: number;
  pieces: number;
  remainingPieces: number;
  exceedReason: string;
  exceptionApproved: boolean;
}):
  | {
      ok: true;
      line: {
        recommendationLineId: number;
        vendorId: number;
        requestedPieces: number;
        quantityOverrideReason: string | null;
        allocationOverrideApproved: boolean;
      };
    }
  | { ok: false; error: string } {
  if (input.pieces <= 0) return { ok: false, error: "Pieces must be above zero" };
  const needsReason = rfqLineNeedsReason(input.pieces, input.remainingPieces);
  const needsApproval = rfqLineNeedsApproval(input.pieces, input.remainingPieces);
  if (needsReason && !exceedReasonValid(input.exceedReason)) {
    return {
      ok: false,
      error: `Run baseline is ${input.remainingPieces} pieces — a reason (at least ${EXCEED_REASON_MIN_LENGTH} characters) is required for ${input.pieces}`,
    };
  }
  if (needsApproval && !input.exceptionApproved) {
    return {
      ok: false,
      error: `Run baseline is ${input.remainingPieces} pieces — approve the sourcing exception to request ${input.pieces}`,
    };
  }
  return {
    ok: true,
    line: {
      recommendationLineId: input.recommendationLineId,
      vendorId: input.vendorId,
      requestedPieces: input.pieces,
      quantityOverrideReason: needsReason ? input.exceedReason.trim() : null,
      // Only meaningful above the baseline; the service rejects a stray true.
      allocationOverrideApproved: needsApproval,
    },
  };
}
