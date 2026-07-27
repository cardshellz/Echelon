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
   * (no_vendor, already_on_order, …) in BOTH `items` and `skippedItems`;
   * their Suggested cell renders "—", so spend aggregation must ignore them.
   */
  skippedReason?: string | null;
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
 * the review queue, which lives on the legacy page until the Automation page
 * ships — the cockpit shows a banner linking to /reorder-analysis/legacy.
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
  /** Legacy page URL preserving the FULL original query string. */
  legacyUrl: string;
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
    legacyUrl: `/reorder-analysis/legacy${query ? `?${query}` : ""}`,
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
 * Skipped rows (the engine dual-lists them in `items`) never count: their
 * table row renders "—", so the KPI must not disagree with the table.
 */
export function computeSuggestedSpend(items: readonly SuggestedSpendItem[]): SuggestedSpendSummary {
  let totalCents = 0;
  let skuCount = 0;
  let missingCostCount = 0;
  for (const item of items) {
    if (item.skippedReason) continue;
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
    const skipped = item.skippedReason !== null && item.skippedReason !== undefined;
    if (
      !skipped &&
      item.currentSupply.effectiveSupplyPieces < item.forwardDemandBasis.adjustedReorderPoint
    ) {
      belowReorderPointCount += 1;
    }
    // Skipped rows render "—" in the Suggested column, so their (possibly
    // positive) engine suggestion must not inflate the group's suggested $.
    // On-hand value is real stock regardless, so it always counts.
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
