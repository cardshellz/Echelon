import { centsToMills, millsToCents } from "@shared/utils/money";
import {
  buildPurchasingDemandForecastBasis,
  buildPurchasingDemandForecastWindowDiagnostics,
  type PurchasingDemandForecastMethod,
  type PurchasingDemandForecastDemandMixSignal,
  type PurchasingDemandForecastQuality,
  type PurchasingDemandForecastTrend,
  type PurchasingDemandForecastWindowDiagnostics,
} from "./purchasing-demand-forecast.engine";

export type PurchasingRecommendationStatus =
  | "stockout"
  | "order_now"
  | "order_soon"
  | "on_order"
  | "ok"
  | "no_movement";

export type PurchasingRecommendationSkipReason =
  | "excluded"
  | "already_on_order"
  | "no_vendor"
  | "not_actionable_status"
  | "zero_suggested_quantity";

export type PurchasingRecommendationConfidence = "low" | "medium" | "high";
export type PurchasingRecommendationDemandQuality = PurchasingDemandForecastQuality;
export type PurchasingRecommendationDemandTrend = PurchasingDemandForecastTrend;
export type PurchasingRecommendationLeadTimeSource = "vendor_product" | "product" | "default";
export type PurchasingRecommendationSafetyStockSource = "product" | "default";
export type PurchasingRecommendationOrderUomSource = "variant" | "default_each";
export type PurchasingRecommendationSupplierCostSource =
  | "vendor_unit_cost_mills"
  | "vendor_unit_cost_cents"
  | "last_purchase_cost"
  | "missing";
export type PurchasingRecommendationSupplierCostQuality = "current" | "stale" | "unverified" | "missing";
export type PurchasingRecommendationSupplierCycleSignal =
  | "open_supply_past_due"
  | "open_supply_covers_cycle"
  | "open_supply_partial"
  | "receipt_recent"
  | "receipt_aging"
  | "receipt_stale"
  | "no_supplier_cycle_data";
export type PurchasingRecommendationCandidateBand =
  | "strong_candidate"
  | "review_candidate"
  | "watch"
  | "blocked";
export type PurchasingRecommendationDemandSuppressionSignal =
  | "none"
  | "stockout_velocity_suppression"
  | "low_supply_velocity_suppression";
export type PurchasingRecommendationDemandSuppressionSeverity = "none" | "watch" | "review";
export type PurchasingRecommendationForecastTrustSignal =
  | "trusted"
  | "no_recent_demand"
  | "stale_recent_demand"
  | "thin_sample"
  | "missing_latest_demand_timestamp"
  | "missing_prior_baseline";
export type PurchasingRecommendationForecastTrustSeverity = "ok" | "watch" | "review";
export type PurchasingRecommendationForecastInputGap =
  | "missing_latest_demand_at"
  | "missing_demand_order_count"
  | "missing_demand_active_days"
  | "missing_prior_period"
  | "missing_short_window"
  | "missing_long_window"
  | "missing_seasonal_window";
export type PurchasingRecommendationReviewAction =
  | "create_po"
  | "assign_vendor"
  | "review_open_po"
  | "review_exclusion"
  | "monitor"
  | "none";
export type PurchasingRecommendationReviewSeverity = "critical" | "warning" | "info";
export type PurchasingRecommendationQualityGateReason =
  | "high_confidence"
  | "medium_confidence_review"
  | "low_confidence_review"
  | "not_actionable"
  | "quality_control_block"
  | "forecast_trust_review";
export type PurchasingRecommendationQualityControlArea =
  | "demand"
  | "lead_time"
  | "supplier_cost"
  | "vendor"
  | "receive_configuration"
  | "supplier_catalog";
export type PurchasingRecommendationQualityControlSeverity = "review" | "block";

export interface PurchasingRecommendationQualityControl {
  area: PurchasingRecommendationQualityControlArea;
  severity: PurchasingRecommendationQualityControlSeverity;
  code: string;
  label: string;
  detail: string;
}

export interface PurchasingRecommendationDemandSuppressionRisk {
  signal: PurchasingRecommendationDemandSuppressionSignal;
  severity: PurchasingRecommendationDemandSuppressionSeverity;
  detail: string;
  constrainedAvailablePieces: number;
  daysOfSupply: number;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandQuality: PurchasingRecommendationDemandQuality;
}

export interface PurchasingRecommendationForecastTrustDiagnostics {
  signal: PurchasingRecommendationForecastTrustSignal;
  severity: PurchasingRecommendationForecastTrustSeverity;
  detail: string;
  latestDemandAgeDays: number | null;
  staleDemandThresholdDays: number;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  hasPriorBaseline: boolean;
  hasShortWindow: boolean;
  hasLongWindow: boolean;
  hasSeasonalWindow: boolean;
  inputGaps: PurchasingRecommendationForecastInputGap[];
}

export interface PurchasingRecommendationRawRow {
  product_id: number | string;
  variant_id?: number | string | null;
  base_sku?: string | null;
  product_name?: string | null;
  variant_count?: number | string | null;
  total_pieces?: number | string | null;
  total_reserved_pieces?: number | string | null;
  total_outbound_pieces?: number | string | null;
  previous_outbound_pieces?: number | string | null;
  demand_order_count?: number | string | null;
  demand_active_days?: number | string | null;
  latest_demand_at?: string | Date | null;
  latest_known_demand_at?: string | Date | null;
  paid_demand_pieces?: number | string | null;
  zero_revenue_demand_pieces?: number | string | null;
  coupon_discount_demand_pieces?: number | string | null;
  short_window_days?: number | string | null;
  short_outbound_pieces?: number | string | null;
  previous_short_outbound_pieces?: number | string | null;
  short_demand_order_count?: number | string | null;
  short_demand_active_days?: number | string | null;
  short_latest_demand_at?: string | Date | null;
  long_window_days?: number | string | null;
  long_outbound_pieces?: number | string | null;
  previous_long_outbound_pieces?: number | string | null;
  long_demand_order_count?: number | string | null;
  long_demand_active_days?: number | string | null;
  long_latest_demand_at?: string | Date | null;
  seasonal_window_days?: number | string | null;
  seasonal_outbound_pieces?: number | string | null;
  previous_seasonal_outbound_pieces?: number | string | null;
  seasonal_demand_order_count?: number | string | null;
  seasonal_demand_active_days?: number | string | null;
  seasonal_latest_demand_at?: string | Date | null;
  on_order_pieces?: number | string | null;
  open_po_count?: number | string | null;
  earliest_expected?: string | Date | null;
  lead_time_days?: number | string | null;
  vendor_lead_time_days?: number | string | null;
  safety_stock_days?: number | string | null;
  order_uom_units?: number | string | null;
  order_uom_level?: number | string | null;
  order_uom_sku?: string | null;
  last_received_at?: string | Date | null;
  vendor_product_id?: number | string | null;
  preferred_vendor_id?: number | string | null;
  preferred_vendor_name?: string | null;
  estimated_cost_cents?: number | string | null;
  estimated_cost_mills?: number | string | null;
  last_cost_cents?: number | string | null;
  vendor_product_last_purchased_at?: string | Date | null;
  vendor_product_updated_at?: string | Date | null;
  unit_cost_cents?: number | string | null;
  forward_demand_pieces?: number | string | null;
  forward_demand_raw_pieces?: number | string | null;
  forward_demand_event_count?: number | string | null;
}

export interface PurchasingRecommendationProductMeta {
  id?: number | string;
  category?: string | null;
  brand?: string | null;
  product_type?: string | null;
  sku?: string | null;
  tags?: unknown;
  reorder_excluded?: boolean | number | null;
}

export interface PurchasingRecommendationExclusionRule {
  field: string;
  value: string;
}

export interface PurchasingRecommendationDefaults {
  leadTimeDays: number;
  safetyStockDays: number;
}

export type AutoDraftApprovalPolicy = "high_confidence_only" | "high_confidence_and_strong_candidate";

export interface AutoDraftRecommendationSettings {
  autoDraftMode?: "draft_po" | "review_only";
  approvalPolicy?: AutoDraftApprovalPolicy;
  includeOrderSoon?: boolean;
  skipOnOpenPo?: boolean;
  skipNoVendor?: boolean;
  candidateScoreStrongThreshold?: number;
  candidateScoreReviewThreshold?: number;
}

export interface GeneratePurchasingRecommendationsOptions {
  rows: PurchasingRecommendationRawRow[];
  lookbackDays: number;
  asOf?: Date | string;
  productMetaById?: Map<number, PurchasingRecommendationProductMeta> | Record<string, PurchasingRecommendationProductMeta>;
  exclusionRules?: PurchasingRecommendationExclusionRule[];
  defaults?: Partial<PurchasingRecommendationDefaults>;
  autoDraftSettings?: AutoDraftRecommendationSettings;
  requireVendor?: boolean;
  includeSkipped?: boolean;
}

export interface PurchasingRecommendationItem {
  recommendationId: string;
  productId: number;
  productVariantId?: number;
  sku: string;
  productName: string;
  variantCount: number;
  totalOnHand: number;
  totalReserved: number;
  available: number;
  periodUsage: number;
  avgDailyUsage: number;
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockDays: number;
  reorderPoint: number;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  recommendedOrderQty: number;
  orderUomUnits: number;
  orderUomLabel: string;
  onOrderQty: number;
  onOrderPieces: number;
  openPoCount: number;
  earliestExpectedDate: string | Date | null;
  status: PurchasingRecommendationStatus;
  lastReceivedAt: string | Date | null;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  estimatedCostMills: number | null;
  estimatedCostCents: number | null;
  supplierBasis: {
    vendorProductId: number | null;
    costSource: PurchasingRecommendationSupplierCostSource;
    costQuality: PurchasingRecommendationSupplierCostQuality;
    estimatedCostMills: number | null;
    estimatedCostCents: number | null;
    lastCostCents: number | null;
    lastPurchasedAt: string | Date | null;
    vendorProductUpdatedAt: string | Date | null;
  };
  currentSupply: {
    onHandPieces: number;
    reservedPieces: number;
    availablePieces: number;
    effectiveSupplyPieces: number;
  };
  openPoSupply: {
    onOrderPieces: number;
    openPoCount: number;
    earliestExpectedDate: string | Date | null;
  };
  supplierCycleDiagnostics: {
    signal: PurchasingRecommendationSupplierCycleSignal;
    detail: string;
    cycleDays: number;
    supplyCoverageRatio: number | null;
    openPoCoverageRatio: number | null;
    daysUntilEarliestExpected: number | null;
    daysSinceLastReceipt: number | null;
  };
  recommendationCandidateScore: {
    score: number;
    band: PurchasingRecommendationCandidateBand;
    demandScore: number;
    supplyScore: number;
    readinessScore: number;
    signals: string[];
    blockers: string[];
    detail: string;
  };
  demandBasis: {
    lookbackDays: number;
    periodUsagePieces: number;
    priorPeriodUsagePieces: number | null;
    avgDailyUsagePieces: number;
    demandQuality: PurchasingRecommendationDemandQuality;
    demandTrend: PurchasingRecommendationDemandTrend;
    demandOrderCount: number | null;
    demandActiveDays: number | null;
    latestDemandAt: string | Date | null;
    paidDemandPieces: number | null;
    zeroRevenueDemandPieces: number | null;
    couponDiscountDemandPieces: number | null;
    zeroRevenueDemandShare: number | null;
    couponDiscountDemandShare: number | null;
    demandMixSignal: PurchasingDemandForecastDemandMixSignal;
    demandSuppressionRisk: PurchasingRecommendationDemandSuppressionRisk;
    forecastTrust: PurchasingRecommendationForecastTrustDiagnostics;
  };
  forwardDemandBasis: {
    forwardDemandPieces: number;
    forwardDemandRawPieces: number;
    forwardDemandEventCount: number;
    adjustedReorderPoint: number;
  };
  leadTimeBasis: {
    leadTimeDays: number;
    leadTimeSource: PurchasingRecommendationLeadTimeSource;
    safetyStockDays: number;
    safetyStockSource: PurchasingRecommendationSafetyStockSource;
    reorderPointPieces: number;
  };
  forecastProvenance: {
    forecastMethod: PurchasingDemandForecastMethod;
    forecastVersion: 1;
    demandSource: "recent_order_velocity";
    demandWindowDays: number;
    demandQuality: PurchasingRecommendationDemandQuality;
    demandTrend: PurchasingRecommendationDemandTrend;
    periodUsagePieces: number;
    priorPeriodUsagePieces: number | null;
    avgDailyUsagePieces: number;
    demandOrderCount: number | null;
    demandActiveDays: number | null;
    latestDemandAt: string | Date | null;
    paidDemandPieces: number | null;
    zeroRevenueDemandPieces: number | null;
    couponDiscountDemandPieces: number | null;
    zeroRevenueDemandShare: number | null;
    couponDiscountDemandShare: number | null;
    demandMixSignal: PurchasingDemandForecastDemandMixSignal;
    leadTimeSource: PurchasingRecommendationLeadTimeSource;
    safetyStockSource: PurchasingRecommendationSafetyStockSource;
    orderUomSource: PurchasingRecommendationOrderUomSource;
    demandWindowDiagnostics: PurchasingDemandForecastWindowDiagnostics;
    demandSuppressionRisk: PurchasingRecommendationDemandSuppressionRisk;
    forecastTrust: PurchasingRecommendationForecastTrustDiagnostics;
  };
  confidence: PurchasingRecommendationConfidence;
  confidenceFactors: string[];
  qualityControls: PurchasingRecommendationQualityControl[];
  autopilotBlockers: PurchasingRecommendationQualityControl[];
  explanation: string;
  reviewSignal: {
    action: PurchasingRecommendationReviewAction;
    severity: PurchasingRecommendationReviewSeverity;
    label: string;
    detail: string;
  };
  qualityGate: {
    autoDraftEligible: boolean;
    reason: PurchasingRecommendationQualityGateReason;
    label: string;
    detail: string;
  };
  actionable: boolean;
  skippedReason: PurchasingRecommendationSkipReason | null;
}

export interface PurchasingRecommendationSummary {
  totalProducts: number;
  outOfStock: number;
  belowReorderPoint: number;
  orderSoon: number;
  noMovement: number;
  totalOnHand: number;
  excludedCount: number;
  skippedNoVendor: number;
  skippedOnOrder: number;
  actionableCount: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  autoDraftEligibleCount: number;
  autoDraftReviewRequiredCount: number;
}

export interface PurchasingRecommendationResult {
  items: PurchasingRecommendationItem[];
  skippedItems: PurchasingRecommendationItem[];
  summary: PurchasingRecommendationSummary;
  lookbackDays: number;
}

const HIERARCHY_LABELS: Record<number, string> = {
  1: "Pack",
  2: "Box",
  3: "Case",
  4: "Skid",
};

const DEFAULTS: PurchasingRecommendationDefaults = {
  leadTimeDays: 14,
  safetyStockDays: 7,
};

const DEFAULT_CANDIDATE_SCORE_STRONG_THRESHOLD = 80;
const DEFAULT_CANDIDATE_SCORE_REVIEW_THRESHOLD = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function asNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(asNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function asPositiveNumberOrNull(value: unknown): number | null {
  const parsed = asNumber(value, NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asPositiveSafeIntegerOrNull(value: unknown): number | null {
  const parsed = asNumber(value, NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAsOf(value: Date | string | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function getLatestDemandAgeDays(asOf: Date, latestDemandAt: string | Date | null): number | null {
  if (!latestDemandAt) return null;
  const latest = new Date(latestDemandAt).getTime();
  if (!Number.isFinite(latest)) return null;
  return Math.max(0, Math.floor((asOf.getTime() - latest) / MS_PER_DAY));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeCandidateScoreThresholds(settings: AutoDraftRecommendationSettings): {
  strongThreshold: number;
  reviewThreshold: number;
} {
  const strongThreshold = clampScore(
    asNumber(settings.candidateScoreStrongThreshold, DEFAULT_CANDIDATE_SCORE_STRONG_THRESHOLD),
  );
  const requestedReviewThreshold = clampScore(
    asNumber(settings.candidateScoreReviewThreshold, DEFAULT_CANDIDATE_SCORE_REVIEW_THRESHOLD),
  );
  const reviewThreshold = Math.min(requestedReviewThreshold, strongThreshold);
  return { strongThreshold, reviewThreshold };
}

function getMeta(
  productMetaById: GeneratePurchasingRecommendationsOptions["productMetaById"],
  productId: number,
): PurchasingRecommendationProductMeta {
  if (!productMetaById) return {};
  if (productMetaById instanceof Map) return productMetaById.get(productId) ?? {};
  return productMetaById[String(productId)] ?? {};
}

function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).toLowerCase());
  if (typeof tags === "string") {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return parsed.map((tag) => String(tag).toLowerCase());
    } catch (_) {
      return tags
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return [];
}

function isExcluded(
  row: PurchasingRecommendationRawRow,
  meta: PurchasingRecommendationProductMeta,
  rules: PurchasingRecommendationExclusionRule[],
): boolean {
  if (meta.reorder_excluded === true || meta.reorder_excluded === 1) return true;

  const category = String(meta.category ?? "").toLowerCase();
  const brand = String(meta.brand ?? "").toLowerCase();
  const productType = String(meta.product_type ?? "").toLowerCase();
  const sku = String(meta.sku ?? row.base_sku ?? "").toLowerCase();
  const tags = normalizeTags(meta.tags);

  for (const rule of rules) {
    const value = String(rule.value ?? "").toLowerCase();
    switch (rule.field) {
      case "category":
        if (category === value) return true;
        break;
      case "brand":
        if (brand === value) return true;
        break;
      case "product_type":
        if (productType === value) return true;
        break;
      case "sku_prefix":
        if (sku.startsWith(value)) return true;
        break;
      case "sku_exact":
        if (sku === value) return true;
        break;
      case "tag":
        if (tags.includes(value)) return true;
        break;
    }
  }

  return false;
}

function classifyRecommendation(input: {
  available: number;
  avgDailyUsage: number;
  daysOfSupply: number;
  leadTimeDays: number;
  reorderPoint: number;
  onOrderPieces: number;
  effectiveSupply: number;
}): PurchasingRecommendationStatus {
  if (input.available <= 0) return "stockout";
  if (input.avgDailyUsage === 0) return "no_movement";
  if (
    input.available <= input.reorderPoint &&
    input.onOrderPieces > 0 &&
    input.effectiveSupply >= input.reorderPoint
  ) {
    return "on_order";
  }
  if (input.available <= input.reorderPoint) return "order_now";
  if (input.daysOfSupply <= input.leadTimeDays * 1.5) return "order_soon";
  return "ok";
}

function isActionableStatus(
  status: PurchasingRecommendationStatus,
  settings: AutoDraftRecommendationSettings,
): boolean {
  return status === "stockout" || status === "order_now" || (status === "order_soon" && Boolean(settings.includeOrderSoon));
}

function buildExplanation(input: {
  status: PurchasingRecommendationStatus;
  available: number;
  effectiveSupply: number;
  reorderPoint: number;
  avgDailyUsage: number;
  lookbackDays: number;
  leadTimeDays: number;
  safetyStockDays: number;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomLabel: string;
  skippedReason: PurchasingRecommendationSkipReason | null;
}): string {
  if (input.skippedReason === "excluded") {
    return "Excluded by purchasing reorder policy.";
  }
  if (input.skippedReason === "no_vendor") {
    return "Recommendation blocked because no preferred vendor is configured.";
  }
  if (input.skippedReason === "already_on_order") {
    return `Open PO supply covers the reorder point: effective supply ${input.effectiveSupply} pieces vs reorder point ${input.reorderPoint}.`;
  }
  if (input.status === "no_movement") {
    return `No demand in the ${input.lookbackDays}-day lookback window.`;
  }
  if (input.suggestedOrderQty <= 0) {
    return `Effective supply ${input.effectiveSupply} pieces covers the reorder point ${input.reorderPoint}.`;
  }
  return [
    `Available ${input.available} pieces plus open PO supply gives ${input.effectiveSupply} effective pieces.`,
    `Reorder point is ${input.reorderPoint} pieces from ${input.avgDailyUsage.toFixed(2)} pieces/day over ${input.lookbackDays} days, ${input.leadTimeDays} lead days, and ${input.safetyStockDays} safety days.`,
    `Recommend ${input.suggestedOrderQty} ${input.orderUomLabel} (${input.suggestedOrderPieces} pieces).`,
  ].join(" ");
}

function buildConfidence(input: {
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandMixSignal: PurchasingDemandForecastDemandMixSignal;
  leadTimeSource: PurchasingRecommendationLeadTimeSource;
  costQuality: PurchasingRecommendationSupplierCostQuality;
  costSource: PurchasingRecommendationSupplierCostSource;
  hasVendor: boolean;
}): PurchasingRecommendationConfidence {
  if (input.demandQuality === "no_recent_demand") return "low";
  if (input.demandQuality === "thin_history") return "medium";
  if (input.demandMixSignal === "mostly_zero_revenue" || input.demandMixSignal === "mixed_discounted_or_free") return "medium";
  if (input.demandTrend === "new_demand" || input.demandTrend === "falling") return "medium";
  if (!input.hasVendor || input.leadTimeSource !== "vendor_product") return "medium";
  if (input.costQuality !== "current" || input.costSource === "last_purchase_cost") return "medium";
  return "high";
}

function buildQualityControls(input: {
  lookbackDays: number;
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  periodUsagePieces: number;
  zeroRevenueDemandPieces: number | null;
  couponDiscountDemandPieces: number | null;
  zeroRevenueDemandShare: number | null;
  couponDiscountDemandShare: number | null;
  demandMixSignal: PurchasingDemandForecastDemandMixSignal;
  leadTimeSource: PurchasingRecommendationLeadTimeSource;
  costQuality: PurchasingRecommendationSupplierCostQuality;
  costSource: PurchasingRecommendationSupplierCostSource;
  hasVendor: boolean;
  actionable: boolean;
  hasReceiveConfiguration: boolean;
  hasSupplierCatalogBinding: boolean;
}): PurchasingRecommendationQualityControl[] {
  const controls: PurchasingRecommendationQualityControl[] = [];
  const demandSample =
    input.demandOrderCount !== null || input.demandActiveDays !== null
      ? ` Sample: ${input.demandOrderCount ?? 0} order${input.demandOrderCount === 1 ? "" : "s"} across ${input.demandActiveDays ?? 0} active day${input.demandActiveDays === 1 ? "" : "s"}.`
      : "";

  if (input.demandQuality === "no_recent_demand") {
    controls.push({
      area: "demand",
      severity: "block",
      code: "no_recent_demand",
      label: "No recent demand",
      detail: `No units shipped in the ${input.lookbackDays}-day demand window.${demandSample}`,
    });
  } else if (input.demandQuality === "thin_history") {
    controls.push({
      area: "demand",
      severity: "review",
      code: "thin_history",
      label: "Thin demand history",
      detail: `Demand history is too sparse for fully automated purchasing.${demandSample}`,
    });
  } else if (input.demandTrend === "new_demand") {
    controls.push({
      area: "demand",
      severity: "review",
      code: "new_demand",
      label: "New demand pattern",
      detail: "Current demand has no matching prior-period baseline yet.",
    });
  } else if (input.demandTrend === "falling") {
    controls.push({
      area: "demand",
      severity: "review",
      code: "falling_demand",
      label: "Falling demand",
      detail: "Current demand is lower than the prior lookback window, so the reorder quantity needs operator review.",
    });
  }

  if (input.demandMixSignal === "mostly_zero_revenue") {
    controls.push({
      area: "demand",
      severity: "review",
      code: "zero_revenue_demand_mix",
      label: "High zero-revenue demand",
      detail: `${input.zeroRevenueDemandPieces ?? 0} of ${input.periodUsagePieces} forecast demand pieces came from zero-revenue lines. Count the units, but review before automated purchasing.`,
    });
  } else if (input.demandMixSignal === "mixed_discounted_or_free") {
    controls.push({
      area: "demand",
      severity: "review",
      code: "discounted_or_free_demand_mix",
      label: "Discounted/free demand mix",
      detail: `${input.zeroRevenueDemandPieces ?? 0} zero-revenue pieces and ${input.couponDiscountDemandPieces ?? 0} coupon-discounted pieces are included in demand. Review promotion-driven demand before automation.`,
    });
  }

  if (input.leadTimeSource === "default") {
    controls.push({
      area: "lead_time",
      severity: "review",
      code: "default_lead_time",
      label: "Default lead time",
      detail: "Vendor and product lead time are missing, so the forecast used the default lead-time fallback.",
    });
  } else if (input.leadTimeSource === "product") {
    controls.push({
      area: "lead_time",
      severity: "review",
      code: "product_lead_time_fallback",
      label: "Vendor lead time missing",
      detail: "The forecast used product-level lead time because vendor-specific lead time is not configured.",
    });
  }

  if (!input.hasVendor) {
    controls.push({
      area: "vendor",
      severity: "block",
      code: "missing_vendor",
      label: "Missing preferred vendor",
      detail: "Assign a preferred vendor before automated PO drafting can evaluate supplier cost and lead time.",
    });
  } else if (input.costSource === "missing" || input.costQuality === "missing") {
    controls.push({
      area: "supplier_cost",
      severity: "review",
      code: "missing_supplier_cost",
      label: "Missing supplier cost",
      detail: "Preferred vendor cost is missing, so landed cost and PO value need review before automation.",
    });
  } else {
    if (input.costSource === "last_purchase_cost") {
      controls.push({
        area: "supplier_cost",
        severity: "review",
        code: "last_purchase_cost",
        label: "Last purchase cost fallback",
        detail: "Preferred vendor cost fell back to the last purchase cost instead of an active vendor-product cost.",
      });
    }

    if (input.costQuality === "stale") {
      controls.push({
        area: "supplier_cost",
        severity: "review",
        code: "stale_supplier_cost",
        label: "Stale supplier cost",
        detail: "Preferred vendor cost has not been verified in over 365 days.",
      });
    } else if (input.costQuality === "unverified") {
      controls.push({
        area: "supplier_cost",
        severity: "review",
        code: "unverified_supplier_cost",
        label: "Unverified supplier cost",
        detail: "Preferred vendor cost exists, but its verification date is unknown.",
      });
    }
  }

  if (input.actionable && !input.hasReceiveConfiguration) {
    controls.push({
      area: "receive_configuration",
      severity: "block",
      code: "missing_receive_configuration",
      label: "Missing receive configuration",
      detail: "Assign an active product variant before automated purchasing can create a receivable PO line.",
    });
  }

  if (input.actionable && !input.hasSupplierCatalogBinding) {
    controls.push({
      area: "supplier_catalog",
      severity: "block",
      code: "missing_supplier_catalog_binding",
      label: "Missing supplier catalog binding",
      detail: "Link an active preferred vendor-product row before automated purchasing can create a PO line.",
    });
  }

  return controls;
}

function buildDemandSuppressionRisk(input: {
  available: number;
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockDays: number;
  periodUsagePieces: number;
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
}): PurchasingRecommendationDemandSuppressionRisk {
  const constrainedWindowDays = input.leadTimeDays + input.safetyStockDays;
  const constrainedAvailablePieces = Math.max(0, input.available);
  const isStockout = input.available <= 0;
  const isLowSupply = !isStockout && input.daysOfSupply <= constrainedWindowDays;
  const suppressedSignal =
    input.demandTrend === "falling" ||
    input.demandQuality === "no_recent_demand" ||
    (input.periodUsagePieces > 0 && input.demandQuality === "thin_history");

  if (isStockout && suppressedSignal) {
    return {
      signal: "stockout_velocity_suppression",
      severity: "review",
      detail:
        "Observed order velocity may understate demand because this SKU is stocked out while recent demand is falling, missing, or sparse.",
      constrainedAvailablePieces,
      daysOfSupply: input.daysOfSupply,
      demandTrend: input.demandTrend,
      demandQuality: input.demandQuality,
    };
  }

  if (isLowSupply && suppressedSignal) {
    return {
      signal: "low_supply_velocity_suppression",
      severity: "watch",
      detail:
        "Observed order velocity may be constrained by low available supply; review before treating the demand forecast as a hard ceiling.",
      constrainedAvailablePieces,
      daysOfSupply: input.daysOfSupply,
      demandTrend: input.demandTrend,
      demandQuality: input.demandQuality,
    };
  }

  return {
    signal: "none",
    severity: "none",
    detail: "No demand suppression signal detected from current supply, demand quality, and demand trend.",
    constrainedAvailablePieces,
    daysOfSupply: input.daysOfSupply,
    demandTrend: input.demandTrend,
    demandQuality: input.demandQuality,
  };
}

function buildForecastTrustDiagnostics(input: {
  asOf: Date;
  lookbackDays: number;
  priorPeriodUsagePieces: number | null;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  latestDemandAt: string | Date | null;
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  hasShortWindowInput: boolean;
  hasLongWindowInput: boolean;
  hasSeasonalWindowInput: boolean;
}): PurchasingRecommendationForecastTrustDiagnostics {
  const latestDemandAgeDays = getLatestDemandAgeDays(input.asOf, input.latestDemandAt);
  const staleDemandThresholdDays = Math.max(input.lookbackDays, 14);
  const hasPriorBaseline = input.priorPeriodUsagePieces !== null;
  const inputGaps: PurchasingRecommendationForecastInputGap[] = [];

  if (!input.latestDemandAt) inputGaps.push("missing_latest_demand_at");
  if (input.demandOrderCount === null) inputGaps.push("missing_demand_order_count");
  if (input.demandActiveDays === null) inputGaps.push("missing_demand_active_days");
  if (!hasPriorBaseline) inputGaps.push("missing_prior_period");
  if (!input.hasShortWindowInput) inputGaps.push("missing_short_window");
  if (!input.hasLongWindowInput) inputGaps.push("missing_long_window");
  if (!input.hasSeasonalWindowInput) inputGaps.push("missing_seasonal_window");

  let signal: PurchasingRecommendationForecastTrustSignal = "trusted";
  let severity: PurchasingRecommendationForecastTrustSeverity = "ok";
  let detail = "Forecast inputs have recent demand, a usable sample, and a prior-period baseline.";

  if (input.demandQuality === "no_recent_demand") {
    signal = "no_recent_demand";
    severity = "review";
    detail = "Forecast has no outbound usage in the current lookback window; review before using it as an autopilot purchasing ceiling.";
  } else if (latestDemandAgeDays !== null && latestDemandAgeDays > staleDemandThresholdDays) {
    signal = "stale_recent_demand";
    severity = "review";
    detail = `Most recent demand is ${latestDemandAgeDays} days old, older than the ${staleDemandThresholdDays}-day trust threshold.`;
  } else if (input.demandQuality === "thin_history") {
    signal = "thin_sample";
    severity = "watch";
    detail = "Forecast is based on a thin demand sample; keep it visible for review before expanding autopilot scope.";
  } else if (!input.latestDemandAt) {
    signal = "missing_latest_demand_timestamp";
    severity = "watch";
    detail = "Forecast has outbound usage but no latest-demand timestamp, so freshness cannot be proven.";
  } else if (!hasPriorBaseline) {
    signal = "missing_prior_baseline";
    severity = "watch";
    detail = "Forecast has no prior-period baseline, so trend confidence is limited.";
  }

  return {
    signal,
    severity,
    detail,
    latestDemandAgeDays,
    staleDemandThresholdDays,
    demandOrderCount: input.demandOrderCount,
    demandActiveDays: input.demandActiveDays,
    demandQuality: input.demandQuality,
    demandTrend: input.demandTrend,
    hasPriorBaseline,
    hasShortWindow: input.hasShortWindowInput,
    hasLongWindow: input.hasLongWindowInput,
    hasSeasonalWindow: input.hasSeasonalWindowInput,
    inputGaps,
  };
}

function buildConfidenceFactors(input: {
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  paidDemandPieces: number | null;
  zeroRevenueDemandPieces: number | null;
  couponDiscountDemandPieces: number | null;
  demandMixSignal: PurchasingDemandForecastDemandMixSignal;
  leadTimeSource: PurchasingRecommendationLeadTimeSource;
  safetyStockSource: PurchasingRecommendationSafetyStockSource;
  costSource: PurchasingRecommendationSupplierCostSource;
  costQuality: PurchasingRecommendationSupplierCostQuality;
  hasVendor: boolean;
  orderUomSource: PurchasingRecommendationOrderUomSource;
}): string[] {
  const factors: string[] = [];

  if (input.demandQuality === "no_recent_demand") {
    factors.push("No recent demand in the lookback window.");
  } else if (input.demandQuality === "thin_history") {
    factors.push("Limited demand history in the lookback window.");
  } else {
    factors.push("Recent demand history is sufficient for velocity-based forecasting.");
  }

  if (input.demandOrderCount !== null || input.demandActiveDays !== null) {
    factors.push(
      `Demand sample includes ${input.demandOrderCount ?? 0} order${input.demandOrderCount === 1 ? "" : "s"} across ${input.demandActiveDays ?? 0} active day${input.demandActiveDays === 1 ? "" : "s"}.`,
    );
  }

  if (input.demandTrend === "new_demand") {
    factors.push("Demand is new versus the prior lookback window.");
  } else if (input.demandTrend === "rising") {
    factors.push("Demand is rising versus the prior lookback window.");
  } else if (input.demandTrend === "falling") {
    factors.push("Demand is falling versus the prior lookback window.");
  } else if (input.demandTrend === "stable") {
    factors.push("Demand is stable versus the prior lookback window.");
  }

  if (input.demandMixSignal !== "not_available") {
    factors.push(
      `Demand mix: ${input.paidDemandPieces ?? 0} paid pieces, ${input.zeroRevenueDemandPieces ?? 0} zero-revenue pieces, and ${input.couponDiscountDemandPieces ?? 0} coupon-discounted pieces.`,
    );
  }

  if (input.leadTimeSource === "vendor_product") {
    factors.push("Vendor-specific lead time is configured.");
  } else if (input.leadTimeSource === "product") {
    factors.push("Product lead time is configured.");
    if (input.hasVendor) factors.push("Preferred vendor-specific lead time is missing.");
  } else {
    factors.push("Lead time uses the default fallback.");
  }

  if (input.hasVendor) {
    if (input.costSource === "missing") {
      factors.push("Preferred vendor cost is missing.");
    } else if (input.costSource === "last_purchase_cost") {
      factors.push("Preferred vendor cost uses last purchase fallback.");
    } else if (input.costSource === "vendor_unit_cost_mills") {
      factors.push("Preferred vendor cost uses mills precision.");
    } else {
      factors.push("Preferred vendor cost is configured in cents.");
    }

    if (input.costQuality === "current") {
      factors.push("Preferred vendor cost was verified recently.");
    } else if (input.costQuality === "stale") {
      factors.push("Preferred vendor cost was last verified over 365 days ago.");
    } else if (input.costQuality === "unverified") {
      factors.push("Preferred vendor cost age could not be verified.");
    }
  }

  if (input.safetyStockSource === "product") {
    factors.push("Product safety stock is configured.");
  } else {
    factors.push("Safety stock uses the default fallback.");
  }

  if (!input.hasVendor) {
    factors.push("Preferred vendor is missing.");
  }

  if (input.orderUomSource === "default_each") {
    factors.push("Order UOM defaults to each because no higher ordering unit is configured.");
  }

  return factors;
}

function mostRecentDate(...values: Array<string | Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) continue;
    if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
  }
  return latest;
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toUtcDayNumber(value: Date): number {
  return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000);
}

function calendarDayDiff(start: Date, end: Date): number {
  return toUtcDayNumber(end) - toUtcDayNumber(start);
}

function formatCoverage(ratio: number | null): string {
  return ratio == null ? "no cycle coverage" : `${ratio.toLocaleString(undefined, { maximumFractionDigits: 2 })}x cycle coverage`;
}

function buildSupplierCycleDiagnostics(input: {
  available: number;
  effectiveSupply: number;
  reorderPoint: number;
  onOrderPieces: number;
  openPoCount: number;
  earliestExpectedDate: string | Date | null;
  lastReceivedAt: string | Date | null;
  leadTimeDays: number;
  safetyStockDays: number;
}): PurchasingRecommendationItem["supplierCycleDiagnostics"] {
  const cycleDays = Math.max(1, Math.ceil(input.leadTimeDays + input.safetyStockDays));
  const supplyCoverageRatio = input.reorderPoint > 0 ? roundRatio(input.effectiveSupply / input.reorderPoint) : null;
  const openPoCoverageRatio =
    input.reorderPoint > 0 && input.onOrderPieces > 0 ? roundRatio(input.onOrderPieces / input.reorderPoint) : null;
  const now = new Date();
  const expectedDate = parseDate(input.earliestExpectedDate);
  const lastReceivedAt = parseDate(input.lastReceivedAt);
  const daysUntilEarliestExpected = expectedDate ? calendarDayDiff(now, expectedDate) : null;
  const daysSinceLastReceipt = lastReceivedAt ? calendarDayDiff(lastReceivedAt, now) : null;
  const hasOpenSupply = input.openPoCount > 0 || input.onOrderPieces > 0;

  if (hasOpenSupply) {
    if (daysUntilEarliestExpected != null && daysUntilEarliestExpected < 0) {
      return {
        signal: "open_supply_past_due",
        detail: `Open PO supply is ${Math.abs(daysUntilEarliestExpected)} day${Math.abs(daysUntilEarliestExpected) === 1 ? "" : "s"} past expected date with ${formatCoverage(supplyCoverageRatio)}.`,
        cycleDays,
        supplyCoverageRatio,
        openPoCoverageRatio,
        daysUntilEarliestExpected,
        daysSinceLastReceipt,
      };
    }

    if (input.reorderPoint > 0 && input.effectiveSupply >= input.reorderPoint) {
      return {
        signal: "open_supply_covers_cycle",
        detail: `Available plus open PO supply covers the reorder cycle (${formatCoverage(supplyCoverageRatio)}).`,
        cycleDays,
        supplyCoverageRatio,
        openPoCoverageRatio,
        daysUntilEarliestExpected,
        daysSinceLastReceipt,
      };
    }

    return {
      signal: "open_supply_partial",
      detail: `Open PO supply exists but available plus inbound supply is still below the reorder cycle (${formatCoverage(supplyCoverageRatio)}).`,
      cycleDays,
      supplyCoverageRatio,
      openPoCoverageRatio,
      daysUntilEarliestExpected,
      daysSinceLastReceipt,
    };
  }

  if (daysSinceLastReceipt == null) {
    return {
      signal: "no_supplier_cycle_data",
      detail: "No open PO supply or recent receipt date is available for supplier-cycle review.",
      cycleDays,
      supplyCoverageRatio,
      openPoCoverageRatio,
      daysUntilEarliestExpected,
      daysSinceLastReceipt,
    };
  }

  if (daysSinceLastReceipt <= cycleDays) {
    return {
      signal: "receipt_recent",
      detail: `Last receipt was ${daysSinceLastReceipt} day${daysSinceLastReceipt === 1 ? "" : "s"} ago, inside the ${cycleDays}-day lead plus safety cycle.`,
      cycleDays,
      supplyCoverageRatio,
      openPoCoverageRatio,
      daysUntilEarliestExpected,
      daysSinceLastReceipt,
    };
  }

  if (daysSinceLastReceipt <= cycleDays * 2) {
    return {
      signal: "receipt_aging",
      detail: `Last receipt was ${daysSinceLastReceipt} days ago, beyond the ${cycleDays}-day lead plus safety cycle.`,
      cycleDays,
      supplyCoverageRatio,
      openPoCoverageRatio,
      daysUntilEarliestExpected,
      daysSinceLastReceipt,
    };
  }

  return {
    signal: "receipt_stale",
    detail: `Last receipt was ${daysSinceLastReceipt} days ago, more than two supplier cycles ago.`,
    cycleDays,
    supplyCoverageRatio,
    openPoCoverageRatio,
    daysUntilEarliestExpected,
    daysSinceLastReceipt,
  };
}

function buildRecommendationCandidateScore(input: {
  status: PurchasingRecommendationStatus;
  actionable: boolean;
  skippedReason: PurchasingRecommendationSkipReason | null;
  confidence: PurchasingRecommendationConfidence;
  qualityGate: PurchasingRecommendationItem["qualityGate"];
  qualityControls: PurchasingRecommendationQualityControl[];
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandMixSignal: PurchasingDemandForecastDemandMixSignal;
  demandWindowDiagnostics: PurchasingDemandForecastWindowDiagnostics;
  supplierCycleDiagnostics: PurchasingRecommendationItem["supplierCycleDiagnostics"];
  strongThreshold: number;
  reviewThreshold: number;
}): PurchasingRecommendationItem["recommendationCandidateScore"] {
  const demandQualityScore: Record<PurchasingRecommendationDemandQuality, number> = {
    no_recent_demand: 0,
    thin_history: 35,
    normal: 60,
  };
  const demandTrendAdjustment: Record<PurchasingRecommendationDemandTrend, number> = {
    not_available: 0,
    no_recent_demand: -30,
    new_demand: 12,
    rising: 15,
    stable: 5,
    falling: -20,
  };
  const demandWindow = input.demandWindowDiagnostics;
  const demandScore = clampScore(
    demandQualityScore[input.demandQuality] +
      demandTrendAdjustment[input.demandTrend] +
      (demandWindow.accelerationSignal === "accelerating" ? 10 : demandWindow.accelerationSignal === "decelerating" ? -10 : 0) +
      (demandWindow.baselineSignal === "above_baseline" ? 8 : demandWindow.baselineSignal === "below_baseline" ? -8 : 0) +
      (demandWindow.seasonalSignal === "above_seasonal" ? 8 : demandWindow.seasonalSignal === "below_seasonal" ? -8 : 0),
  );

  const supplyStatusScore: Record<PurchasingRecommendationStatus, number> = {
    stockout: 100,
    order_now: 85,
    order_soon: 65,
    on_order: 40,
    ok: 20,
    no_movement: 0,
  };
  const supplierCycleAdjustment: Record<PurchasingRecommendationSupplierCycleSignal, number> = {
    open_supply_past_due: 15,
    open_supply_covers_cycle: -20,
    open_supply_partial: 10,
    receipt_recent: -5,
    receipt_aging: 5,
    receipt_stale: 10,
    no_supplier_cycle_data: 0,
  };
  const supplyScore = clampScore(
    supplyStatusScore[input.status] + supplierCycleAdjustment[input.supplierCycleDiagnostics.signal],
  );

  const confidenceScore: Record<PurchasingRecommendationConfidence, number> = {
    high: 90,
    medium: 65,
    low: 30,
  };
  const reviewControlCount = input.qualityControls.filter((control) => control.severity === "review").length;
  const blockControlCount = input.qualityControls.filter((control) => control.severity === "block").length;
  const readinessScore = clampScore(
    (input.qualityGate.autoDraftEligible ? 100 : confidenceScore[input.confidence]) -
      reviewControlCount * 10 -
      blockControlCount * 35,
  );

  let score = clampScore(demandScore * 0.35 + supplyScore * 0.4 + readinessScore * 0.25);
  if (input.skippedReason === "excluded") score = 0;
  if (input.skippedReason === "no_vendor" || blockControlCount > 0) score = Math.min(score, 59);
  if (input.skippedReason === "already_on_order") score = Math.min(score, 49);
  if (input.skippedReason === "not_actionable_status" || input.skippedReason === "zero_suggested_quantity") {
    score = Math.min(score, 39);
  }

  const band: PurchasingRecommendationCandidateBand =
    input.skippedReason === "excluded" || input.skippedReason === "no_vendor" || blockControlCount > 0
      ? "blocked"
      : input.actionable && score >= input.strongThreshold
        ? "strong_candidate"
        : score >= input.reviewThreshold
          ? "review_candidate"
          : "watch";

  const signals = [
    `status:${input.status}`,
    `demand:${input.demandQuality}`,
    `trend:${input.demandTrend}`,
    `demand_mix:${input.demandMixSignal}`,
    `short:${demandWindow.accelerationSignal}`,
    `baseline:${demandWindow.baselineSignal}`,
    `seasonal:${demandWindow.seasonalSignal}`,
    `supplier_cycle:${input.supplierCycleDiagnostics.signal}`,
    `quality_gate:${input.qualityGate.reason}`,
  ];
  const blockers = input.qualityControls
    .filter((control) => control.severity === "block" || control.severity === "review")
    .map((control) => control.code);
  if (input.skippedReason) blockers.push(`skipped:${input.skippedReason}`);

  return {
    score,
    band,
    demandScore,
    supplyScore,
    readinessScore,
    signals,
    blockers,
    detail: `Read-only candidate score ${score}/100 from demand ${demandScore}, supply ${supplyScore}, and readiness ${readinessScore}.`,
  };
}

function resolveSupplierCost(input: {
  estimatedCostMills: number | null;
  estimatedCostCents: number | null;
  unitCostCents: number | null;
  lastCostCents: number | null;
  lastPurchasedAt: string | Date | null;
  vendorProductUpdatedAt: string | Date | null;
}): {
  estimatedCostMills: number | null;
  estimatedCostCents: number | null;
  costSource: PurchasingRecommendationSupplierCostSource;
  costQuality: PurchasingRecommendationSupplierCostQuality;
} {
  let estimatedCostMills: number | null = null;
  let estimatedCostCents: number | null = null;
  let costSource: PurchasingRecommendationSupplierCostSource = "missing";

  if (input.estimatedCostMills !== null) {
    estimatedCostMills = input.estimatedCostMills;
    estimatedCostCents = millsToCents(estimatedCostMills);
    costSource = "vendor_unit_cost_mills";
  } else if (input.estimatedCostCents !== null || input.unitCostCents !== null) {
    estimatedCostCents = input.estimatedCostCents ?? input.unitCostCents;
    estimatedCostMills = centsToMills(estimatedCostCents as number);
    costSource = "vendor_unit_cost_cents";
  } else if (input.lastCostCents !== null) {
    estimatedCostCents = input.lastCostCents;
    estimatedCostMills = centsToMills(estimatedCostCents);
    costSource = "last_purchase_cost";
  }

  if (estimatedCostMills === null || estimatedCostCents === null || costSource === "missing") {
    return {
      estimatedCostMills: null,
      estimatedCostCents: null,
      costSource: "missing",
      costQuality: "missing",
    };
  }

  const verificationDate = mostRecentDate(input.lastPurchasedAt, input.vendorProductUpdatedAt);
  if (!verificationDate) {
    return { estimatedCostMills, estimatedCostCents, costSource, costQuality: "unverified" };
  }

  const ageMs = Date.now() - verificationDate.getTime();
  const staleMs = 365 * 24 * 60 * 60 * 1000;
  return {
    estimatedCostMills,
    estimatedCostCents,
    costSource,
    costQuality: ageMs > staleMs ? "stale" : "current",
  };
}

function buildReviewSignal(input: {
  status: PurchasingRecommendationStatus;
  skippedReason: PurchasingRecommendationSkipReason | null;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomLabel: string;
  openPoCount: number;
  onOrderPieces: number;
  actionable: boolean;
}): PurchasingRecommendationItem["reviewSignal"] {
  const demandSeverity: PurchasingRecommendationReviewSeverity =
    input.status === "stockout" || input.status === "order_now" ? "critical" : "warning";

  if (input.actionable) {
    return {
      action: "create_po",
      severity: demandSeverity,
      label: "Create PO",
      detail: `Create or review a PO for ${input.suggestedOrderQty} ${input.orderUomLabel} (${input.suggestedOrderPieces} pieces).`,
    };
  }

  switch (input.skippedReason) {
    case "no_vendor":
      return {
        action: "assign_vendor",
        severity: demandSeverity,
        label: "Assign preferred vendor",
        detail: "Add a preferred vendor before auto-draft can create a PO for this recommendation.",
      };
    case "already_on_order":
      return {
        action: "review_open_po",
        severity: "info",
        label: "Review inbound PO",
        detail: `Open PO coverage is present (${input.onOrderPieces} pieces across ${input.openPoCount} open PO line${input.openPoCount === 1 ? "" : "s"}). Confirm ETA if demand has changed.`,
      };
    case "excluded":
      return {
        action: "review_exclusion",
        severity: "info",
        label: "Review exclusion",
        detail: "This item is excluded by reorder policy. Remove the exclusion if it should be considered for purchasing.",
      };
    case "zero_suggested_quantity":
      return {
        action: "monitor",
        severity: "info",
        label: "Monitor",
        detail: "Effective supply covers the reorder point, so no purchase quantity is currently recommended.",
      };
    case "not_actionable_status":
      return {
        action: "monitor",
        severity: "info",
        label: "Monitor",
        detail: "Inventory is not currently in an auto-draftable reorder state.",
      };
    default:
      return {
        action: "none",
        severity: "info",
        label: "No action",
        detail: "No purchasing action is required.",
      };
  }
}

function buildQualityGate(input: {
  actionable: boolean;
  confidence: PurchasingRecommendationConfidence;
  skippedReason: PurchasingRecommendationSkipReason | null;
  autopilotBlockers: PurchasingRecommendationQualityControl[];
  forecastTrust: PurchasingRecommendationForecastTrustDiagnostics;
}): PurchasingRecommendationItem["qualityGate"] {
  const primaryControl = input.autopilotBlockers[0];
  const hardBlocker = input.autopilotBlockers.find((control) => control.severity === "block");
  if (!input.actionable) {
    let detail = "This recommendation is not currently in an auto-draftable reorder state.";
    if (hardBlocker) {
      detail = `${hardBlocker.label}: ${hardBlocker.detail}`;
    } else if (primaryControl) {
      detail = `${primaryControl.label}: ${primaryControl.detail}`;
    } else if (input.skippedReason) {
      detail = "This recommendation is blocked by an operator review condition.";
    }

    return {
      autoDraftEligible: false,
      reason: "not_actionable",
      label: "Not auto-draftable",
      detail,
    };
  }

  if (hardBlocker) {
    return {
      autoDraftEligible: false,
      reason: "quality_control_block",
      label: "Blocked from auto-draft",
      detail: `${hardBlocker.label}: ${hardBlocker.detail}`,
    };
  }

  if (input.confidence === "high" && input.forecastTrust.severity === "review") {
    return {
      autoDraftEligible: false,
      reason: "forecast_trust_review",
      label: "Forecast trust review",
      detail: `Forecast trust ${input.forecastTrust.signal.replace(/_/g, " ")}: ${input.forecastTrust.detail}`,
    };
  }

  if (input.confidence === "high") {
    return {
      autoDraftEligible: true,
      reason: "high_confidence",
      label: "Auto-draft eligible",
      detail: "This recommendation passed the high-confidence quality gate for automated PO drafting.",
    };
  }

  return {
    autoDraftEligible: false,
    reason: input.confidence === "medium" ? "medium_confidence_review" : "low_confidence_review",
    label: "Review before auto-draft",
    detail: primaryControl
      ? `${primaryControl.label}: ${primaryControl.detail}`
      : "This recommendation is actionable, but confidence is not high enough for automated PO drafting.",
  };
}

export function getAutoDraftApprovalPolicy(settings?: AutoDraftRecommendationSettings): AutoDraftApprovalPolicy {
  return settings?.approvalPolicy === "high_confidence_and_strong_candidate"
    ? "high_confidence_and_strong_candidate"
    : "high_confidence_only";
}

export function passesAutoDraftApprovalPolicy(
  item: PurchasingRecommendationItem,
  settings?: AutoDraftRecommendationSettings,
): boolean {
  const policy = getAutoDraftApprovalPolicy(settings);
  if (policy === "high_confidence_only") return item.qualityGate.autoDraftEligible;
  if (policy === "high_confidence_and_strong_candidate") {
    return item.qualityGate.autoDraftEligible && item.recommendationCandidateScore.band === "strong_candidate";
  }
  return false;
}

export function generatePurchasingRecommendations(
  options: GeneratePurchasingRecommendationsOptions,
): PurchasingRecommendationResult {
  const defaults = {
    leadTimeDays: asPositiveInt(options.defaults?.leadTimeDays, DEFAULTS.leadTimeDays),
    safetyStockDays: asPositiveInt(options.defaults?.safetyStockDays, DEFAULTS.safetyStockDays),
  };
  const rules = options.exclusionRules ?? [];
  const settings = options.autoDraftSettings ?? {};
  const candidateScoreThresholds = normalizeCandidateScoreThresholds(settings);
  const lookbackDays = asPositiveInt(options.lookbackDays, 30);
  const asOf = normalizeAsOf(options.asOf);
  const items: PurchasingRecommendationItem[] = [];
  const skippedItems: PurchasingRecommendationItem[] = [];

  for (const row of options.rows) {
    const productId = asNumber(row.product_id);
    if (!productId) continue;

    const meta = getMeta(options.productMetaById, productId);
    const productVariantId = row.variant_id == null ? undefined : asNumber(row.variant_id);
    const totalOnHand = asNumber(row.total_pieces);
    const totalReserved = asNumber(row.total_reserved_pieces);
    const demandForecast = buildPurchasingDemandForecastBasis({
      lookbackDays,
      periodUsagePieces: row.total_outbound_pieces,
      priorPeriodUsagePieces: row.previous_outbound_pieces,
      demandOrderCount: row.demand_order_count,
      demandActiveDays: row.demand_active_days,
      latestDemandAt: row.latest_demand_at ?? null,
      paidDemandPieces: row.paid_demand_pieces,
      zeroRevenueDemandPieces: row.zero_revenue_demand_pieces,
      couponDiscountDemandPieces: row.coupon_discount_demand_pieces,
    });
    const hasShortWindowInput =
      row.short_window_days !== undefined ||
      row.short_outbound_pieces !== undefined ||
      row.previous_short_outbound_pieces !== undefined ||
      row.short_demand_order_count !== undefined ||
      row.short_demand_active_days !== undefined ||
      row.short_latest_demand_at !== undefined;
    const shortDemandForecast = buildPurchasingDemandForecastBasis({
      lookbackDays: hasShortWindowInput ? row.short_window_days : lookbackDays,
      periodUsagePieces: hasShortWindowInput ? row.short_outbound_pieces : row.total_outbound_pieces,
      priorPeriodUsagePieces: hasShortWindowInput ? row.previous_short_outbound_pieces : row.previous_outbound_pieces,
      demandOrderCount: hasShortWindowInput ? row.short_demand_order_count : row.demand_order_count,
      demandActiveDays: hasShortWindowInput ? row.short_demand_active_days : row.demand_active_days,
      latestDemandAt: hasShortWindowInput ? row.short_latest_demand_at ?? null : row.latest_demand_at ?? null,
    });
    const hasLongWindowInput =
      row.long_window_days !== undefined ||
      row.long_outbound_pieces !== undefined ||
      row.previous_long_outbound_pieces !== undefined ||
      row.long_demand_order_count !== undefined ||
      row.long_demand_active_days !== undefined ||
      row.long_latest_demand_at !== undefined;
    const longDemandForecast = buildPurchasingDemandForecastBasis({
      lookbackDays: hasLongWindowInput ? row.long_window_days : lookbackDays,
      periodUsagePieces: hasLongWindowInput ? row.long_outbound_pieces : row.total_outbound_pieces,
      priorPeriodUsagePieces: hasLongWindowInput ? row.previous_long_outbound_pieces : row.previous_outbound_pieces,
      demandOrderCount: hasLongWindowInput ? row.long_demand_order_count : row.demand_order_count,
      demandActiveDays: hasLongWindowInput ? row.long_demand_active_days : row.demand_active_days,
      latestDemandAt: hasLongWindowInput ? row.long_latest_demand_at ?? null : row.latest_demand_at ?? null,
    });
    const hasSeasonalWindowInput =
      row.seasonal_window_days !== undefined ||
      row.seasonal_outbound_pieces !== undefined ||
      row.previous_seasonal_outbound_pieces !== undefined ||
      row.seasonal_demand_order_count !== undefined ||
      row.seasonal_demand_active_days !== undefined ||
      row.seasonal_latest_demand_at !== undefined;
    const seasonalDemandForecast = hasSeasonalWindowInput
      ? buildPurchasingDemandForecastBasis({
          lookbackDays: row.seasonal_window_days,
          periodUsagePieces: row.seasonal_outbound_pieces,
          priorPeriodUsagePieces: row.previous_seasonal_outbound_pieces,
          demandOrderCount: row.seasonal_demand_order_count,
          demandActiveDays: row.seasonal_demand_active_days,
          latestDemandAt: row.seasonal_latest_demand_at ?? null,
        })
      : undefined;
    const demandWindowDiagnostics = buildPurchasingDemandForecastWindowDiagnostics({
      standardWindow: demandForecast,
      shortWindow: shortDemandForecast,
      longWindow: longDemandForecast,
      seasonalWindow: seasonalDemandForecast,
    });
    const periodUsage = demandForecast.periodUsagePieces;
    const priorPeriodUsage = demandForecast.priorPeriodUsagePieces;
    const demandOrderCount = demandForecast.demandOrderCount;
    const demandActiveDays = demandForecast.demandActiveDays;
    const latestDemandAt = demandForecast.latestDemandAt;
    const latestKnownDemandAt = row.latest_known_demand_at ?? latestDemandAt;
    const paidDemandPieces = demandForecast.paidDemandPieces;
    const zeroRevenueDemandPieces = demandForecast.zeroRevenueDemandPieces;
    const couponDiscountDemandPieces = demandForecast.couponDiscountDemandPieces;
    const zeroRevenueDemandShare = demandForecast.zeroRevenueDemandShare;
    const couponDiscountDemandShare = demandForecast.couponDiscountDemandShare;
    const demandMixSignal = demandForecast.demandMixSignal;
    const avgDailyUsage = demandForecast.avgDailyUsagePieces;
    const roundedAvgDailyUsage = Math.round(avgDailyUsage * 100) / 100;
    const onOrderPieces = asNumber(row.on_order_pieces);
    const openPoCount = asNumber(row.open_po_count);
    const available = totalOnHand - totalReserved;
    const daysOfSupply = avgDailyUsage > 0 ? Math.round(available / avgDailyUsage) : available > 0 ? 9999 : 0;
    const vendorLeadTime = row.vendor_lead_time_days == null ? null : asNumber(row.vendor_lead_time_days, NaN);
    const productLeadTime = row.lead_time_days == null ? null : asNumber(row.lead_time_days, NaN);
    const leadTimeSource: PurchasingRecommendationLeadTimeSource = Number.isFinite(vendorLeadTime ?? NaN)
      ? "vendor_product"
      : Number.isFinite(productLeadTime ?? NaN)
        ? "product"
        : "default";
    const leadTimeDays = Number.isFinite(vendorLeadTime ?? NaN)
      ? Number(vendorLeadTime)
      : Number.isFinite(productLeadTime ?? NaN)
        ? Number(productLeadTime)
        : defaults.leadTimeDays;
    const safetyStockSource: PurchasingRecommendationSafetyStockSource =
      row.safety_stock_days == null || Number.isNaN(Number(row.safety_stock_days)) ? "default" : "product";
    const safetyStockDays =
      row.safety_stock_days == null || Number.isNaN(Number(row.safety_stock_days))
        ? defaults.safetyStockDays
        : asNumber(row.safety_stock_days);
    const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);
    const forwardDemandPieces = asNumber(row.forward_demand_pieces);
    const forwardDemandRawPieces = asNumber(row.forward_demand_raw_pieces);
    const forwardDemandEventCount = asNumber(row.forward_demand_event_count);
    const adjustedReorderPoint = reorderPoint + forwardDemandPieces;
    const effectiveSupply = available + onOrderPieces;
    const rawOrderQtyPieces = Math.max(0, adjustedReorderPoint - effectiveSupply);
    const orderUomUnits = asPositiveInt(row.order_uom_units, 1);
    const orderUomLevel = asNumber(row.order_uom_level);
    const orderUomSource: PurchasingRecommendationOrderUomSource = asNumber(row.order_uom_units) > 0 ? "variant" : "default_each";
    const orderUomLabel = HIERARCHY_LABELS[orderUomLevel] || (orderUomUnits > 1 ? `${orderUomUnits}pk` : "pcs");
    const suggestedOrderQty =
      orderUomUnits > 1 ? Math.ceil(rawOrderQtyPieces / orderUomUnits) : Math.ceil(rawOrderQtyPieces);
    const suggestedOrderPieces = suggestedOrderQty * orderUomUnits;
    const status = classifyRecommendation({
      available,
      avgDailyUsage,
      daysOfSupply,
      leadTimeDays,
      reorderPoint: adjustedReorderPoint,
      onOrderPieces,
      effectiveSupply,
    });
    const supplierCycleDiagnostics = buildSupplierCycleDiagnostics({
      available,
      effectiveSupply,
      reorderPoint: adjustedReorderPoint,
      onOrderPieces,
      openPoCount,
      earliestExpectedDate: row.earliest_expected ?? null,
      lastReceivedAt: row.last_received_at ?? null,
      leadTimeDays,
      safetyStockDays,
    });
    const preferredVendorId = row.preferred_vendor_id == null ? null : asNumber(row.preferred_vendor_id);
    const preferredVendorName = row.preferred_vendor_name ?? null;
    const vendorProductId = row.vendor_product_id == null ? null : asNumber(row.vendor_product_id);
    const lastCostCents = asPositiveSafeIntegerOrNull(row.last_cost_cents);
    const supplierCost = resolveSupplierCost({
      estimatedCostMills: asPositiveSafeIntegerOrNull(row.estimated_cost_mills),
      estimatedCostCents: asPositiveSafeIntegerOrNull(row.estimated_cost_cents),
      unitCostCents: asPositiveSafeIntegerOrNull(row.unit_cost_cents),
      lastCostCents,
      lastPurchasedAt: row.vendor_product_last_purchased_at ?? null,
      vendorProductUpdatedAt: row.vendor_product_updated_at ?? null,
    });
    const estimatedCostMills = supplierCost.estimatedCostMills;
    const estimatedCostCents = supplierCost.estimatedCostCents;
    const hasVendor = Boolean(preferredVendorId);
    const demandQuality = demandForecast.demandQuality;
    const demandTrend = demandForecast.demandTrend;
    const demandSuppressionRisk = buildDemandSuppressionRisk({
      available,
      daysOfSupply,
      leadTimeDays,
      safetyStockDays,
      periodUsagePieces: periodUsage,
      demandQuality,
      demandTrend,
    });
    const forecastTrust = buildForecastTrustDiagnostics({
      asOf,
      lookbackDays,
      priorPeriodUsagePieces: priorPeriodUsage,
      demandOrderCount,
      demandActiveDays,
      latestDemandAt: latestKnownDemandAt,
      demandQuality,
      demandTrend,
      hasShortWindowInput,
      hasLongWindowInput,
      hasSeasonalWindowInput,
    });

    let skippedReason: PurchasingRecommendationSkipReason | null = null;
    if (isExcluded(row, meta, rules)) {
      skippedReason = "excluded";
    } else if (settings.skipOnOpenPo && onOrderPieces > 0 && effectiveSupply >= reorderPoint) {
      skippedReason = "already_on_order";
    } else if (!isActionableStatus(status, settings)) {
      skippedReason = "not_actionable_status";
    } else if (suggestedOrderQty <= 0) {
      skippedReason = "zero_suggested_quantity";
    } else if (options.requireVendor && settings.skipNoVendor !== false && !hasVendor) {
      skippedReason = "no_vendor";
    }

    const actionable = skippedReason === null && isActionableStatus(status, settings) && suggestedOrderQty > 0;
    const explanation = buildExplanation({
      status,
      available,
      effectiveSupply,
      reorderPoint: adjustedReorderPoint,
      avgDailyUsage,
      lookbackDays,
      leadTimeDays,
      safetyStockDays,
      suggestedOrderQty,
      suggestedOrderPieces,
      orderUomLabel,
      skippedReason,
    });
    const reviewSignal = buildReviewSignal({
      status,
      skippedReason,
      suggestedOrderQty,
      suggestedOrderPieces,
      orderUomLabel,
      openPoCount,
      onOrderPieces,
      actionable,
    });

    const confidence = buildConfidence({
      demandQuality,
      demandTrend,
      demandMixSignal,
      leadTimeSource,
      costQuality: supplierCost.costQuality,
      costSource: supplierCost.costSource,
      hasVendor,
    });
    const qualityControls = buildQualityControls({
      lookbackDays,
      demandQuality,
      demandTrend,
      demandOrderCount,
      demandActiveDays,
      periodUsagePieces: periodUsage,
      zeroRevenueDemandPieces,
      couponDiscountDemandPieces,
      zeroRevenueDemandShare,
      couponDiscountDemandShare,
      demandMixSignal,
      leadTimeSource,
      costQuality: supplierCost.costQuality,
      costSource: supplierCost.costSource,
      hasVendor,
      actionable,
      hasReceiveConfiguration: productVariantId !== undefined && productVariantId > 0,
      hasSupplierCatalogBinding: vendorProductId !== null && vendorProductId > 0,
    });
    const autopilotBlockers = qualityControls;
    const qualityGate = buildQualityGate({
      actionable,
      confidence,
      skippedReason,
      autopilotBlockers,
      forecastTrust,
    });
    const recommendationCandidateScore = buildRecommendationCandidateScore({
      status,
      actionable,
      skippedReason,
      confidence,
      qualityGate,
      qualityControls,
      demandQuality,
      demandTrend,
      demandMixSignal,
      demandWindowDiagnostics,
      supplierCycleDiagnostics,
      strongThreshold: candidateScoreThresholds.strongThreshold,
      reviewThreshold: candidateScoreThresholds.reviewThreshold,
    });
    const item: PurchasingRecommendationItem = {
      recommendationId: `${productId}:${productVariantId ?? "product"}:${lookbackDays}`,
      productId,
      productVariantId,
      sku: row.base_sku || row.product_name || `product-${productId}`,
      productName: row.product_name || row.base_sku || `Product ${productId}`,
      variantCount: asNumber(row.variant_count),
      totalOnHand,
      totalReserved,
      available,
      periodUsage,
      avgDailyUsage: roundedAvgDailyUsage,
      daysOfSupply,
      leadTimeDays,
      safetyStockDays,
      reorderPoint: adjustedReorderPoint,
      suggestedOrderQty,
      suggestedOrderPieces,
      recommendedOrderQty: suggestedOrderQty,
      orderUomUnits,
      orderUomLabel,
      onOrderQty: orderUomUnits > 1 ? Math.floor(onOrderPieces / orderUomUnits) : onOrderPieces,
      onOrderPieces,
      openPoCount,
      earliestExpectedDate: row.earliest_expected ?? null,
      status,
      lastReceivedAt: row.last_received_at ?? null,
      preferredVendorId,
      preferredVendorName,
      estimatedCostMills,
      estimatedCostCents,
      supplierBasis: {
        vendorProductId,
        costSource: supplierCost.costSource,
        costQuality: supplierCost.costQuality,
        estimatedCostMills,
        estimatedCostCents,
        lastCostCents,
        lastPurchasedAt: row.vendor_product_last_purchased_at ?? null,
        vendorProductUpdatedAt: row.vendor_product_updated_at ?? null,
      },
      currentSupply: {
        onHandPieces: totalOnHand,
        reservedPieces: totalReserved,
        availablePieces: available,
        effectiveSupplyPieces: effectiveSupply,
      },
      openPoSupply: {
        onOrderPieces,
        openPoCount,
        earliestExpectedDate: row.earliest_expected ?? null,
      },
      supplierCycleDiagnostics,
      recommendationCandidateScore,
      forwardDemandBasis: {
        forwardDemandPieces,
        forwardDemandRawPieces,
        forwardDemandEventCount,
        adjustedReorderPoint,
      },
      demandBasis: {
        lookbackDays,
        periodUsagePieces: periodUsage,
        priorPeriodUsagePieces: priorPeriodUsage,
        avgDailyUsagePieces: roundedAvgDailyUsage,
        demandQuality,
        demandTrend,
        demandOrderCount,
        demandActiveDays,
        latestDemandAt,
        paidDemandPieces,
        zeroRevenueDemandPieces,
        couponDiscountDemandPieces,
        zeroRevenueDemandShare,
        couponDiscountDemandShare,
        demandMixSignal,
        demandSuppressionRisk,
        forecastTrust,
      },
      leadTimeBasis: {
        leadTimeDays,
        leadTimeSource,
        safetyStockDays,
        safetyStockSource,
        reorderPointPieces: adjustedReorderPoint,
      },
      forecastProvenance: {
        forecastMethod: demandForecast.method,
        forecastVersion: demandForecast.version,
        demandSource: "recent_order_velocity",
        demandWindowDays: lookbackDays,
        demandQuality,
        demandTrend,
        periodUsagePieces: periodUsage,
        priorPeriodUsagePieces: priorPeriodUsage,
        avgDailyUsagePieces: roundedAvgDailyUsage,
        demandOrderCount,
        demandActiveDays,
        latestDemandAt,
        paidDemandPieces,
        zeroRevenueDemandPieces,
        couponDiscountDemandPieces,
        zeroRevenueDemandShare,
        couponDiscountDemandShare,
        demandMixSignal,
        leadTimeSource,
        safetyStockSource,
        orderUomSource,
        demandWindowDiagnostics,
        demandSuppressionRisk,
        forecastTrust,
      },
      confidence,
      confidenceFactors: buildConfidenceFactors({
        demandQuality,
        demandTrend,
        demandOrderCount,
        demandActiveDays,
        paidDemandPieces,
        zeroRevenueDemandPieces,
        couponDiscountDemandPieces,
        demandMixSignal,
        leadTimeSource,
        safetyStockSource,
        costSource: supplierCost.costSource,
        costQuality: supplierCost.costQuality,
        hasVendor,
        orderUomSource,
      }),
      qualityControls,
      autopilotBlockers,
      explanation,
      reviewSignal,
      qualityGate,
      actionable,
      skippedReason,
    };

    if (skippedReason === "excluded") {
      skippedItems.push(item);
      if (options.includeSkipped) items.push(item);
    } else {
      items.push(item);
      if (skippedReason) skippedItems.push(item);
    }
  }

  const visibleItems = items.filter((item) => item.skippedReason !== "excluded");
  const summary: PurchasingRecommendationSummary = {
    totalProducts: visibleItems.length,
    outOfStock: visibleItems.filter((item) => item.status === "stockout").length,
    belowReorderPoint: visibleItems.filter((item) => item.status === "order_now").length,
    orderSoon: visibleItems.filter((item) => item.status === "order_soon").length,
    noMovement: visibleItems.filter((item) => item.status === "no_movement").length,
    totalOnHand: visibleItems.reduce((sum, item) => sum + item.totalOnHand, 0),
    excludedCount: skippedItems.filter((item) => item.skippedReason === "excluded").length,
    skippedNoVendor: skippedItems.filter((item) => item.skippedReason === "no_vendor").length,
    skippedOnOrder: skippedItems.filter((item) => item.skippedReason === "already_on_order").length,
    actionableCount: visibleItems.filter((item) => item.actionable).length,
    highConfidenceCount: visibleItems.filter((item) => item.confidence === "high").length,
    mediumConfidenceCount: visibleItems.filter((item) => item.confidence === "medium").length,
    lowConfidenceCount: visibleItems.filter((item) => item.confidence === "low").length,
    autoDraftEligibleCount: visibleItems.filter((item) => item.qualityGate.autoDraftEligible).length,
    autoDraftReviewRequiredCount: visibleItems.filter(
      (item) => item.actionable && !item.qualityGate.autoDraftEligible,
    ).length,
  };

  return {
    items: visibleItems,
    skippedItems,
    summary,
    lookbackDays,
  };
}
