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
export type PurchasingRecommendationDemandQuality = "no_recent_demand" | "thin_history" | "normal";
export type PurchasingRecommendationDemandTrend =
  | "not_available"
  | "no_recent_demand"
  | "new_demand"
  | "rising"
  | "stable"
  | "falling";
export type PurchasingRecommendationLeadTimeSource = "vendor_product" | "product" | "default";
export type PurchasingRecommendationSafetyStockSource = "product" | "default";
export type PurchasingRecommendationOrderUomSource = "variant" | "default_each";
export type PurchasingRecommendationReviewAction =
  | "create_po"
  | "assign_vendor"
  | "review_open_po"
  | "review_exclusion"
  | "monitor"
  | "none";
export type PurchasingRecommendationReviewSeverity = "critical" | "warning" | "info";

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
  preferred_vendor_id?: number | string | null;
  preferred_vendor_name?: string | null;
  estimated_cost_cents?: number | string | null;
  unit_cost_cents?: number | string | null;
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

export interface AutoDraftRecommendationSettings {
  autoDraftMode?: "draft_po" | "review_only";
  includeOrderSoon?: boolean;
  skipOnOpenPo?: boolean;
  skipNoVendor?: boolean;
}

export interface GeneratePurchasingRecommendationsOptions {
  rows: PurchasingRecommendationRawRow[];
  lookbackDays: number;
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
  estimatedCostCents: number | null;
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
  };
  leadTimeBasis: {
    leadTimeDays: number;
    leadTimeSource: PurchasingRecommendationLeadTimeSource;
    safetyStockDays: number;
    safetyStockSource: PurchasingRecommendationSafetyStockSource;
    reorderPointPieces: number;
  };
  forecastProvenance: {
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
    leadTimeSource: PurchasingRecommendationLeadTimeSource;
    safetyStockSource: PurchasingRecommendationSafetyStockSource;
    orderUomSource: PurchasingRecommendationOrderUomSource;
  };
  confidence: PurchasingRecommendationConfidence;
  confidenceFactors: string[];
  explanation: string;
  reviewSignal: {
    action: PurchasingRecommendationReviewAction;
    severity: PurchasingRecommendationReviewSeverity;
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

function asNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(asNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
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
  leadTimeSource: PurchasingRecommendationLeadTimeSource;
  hasVendor: boolean;
}): PurchasingRecommendationConfidence {
  if (input.demandQuality === "no_recent_demand") return "low";
  if (input.demandQuality === "thin_history") return "medium";
  if (input.demandTrend === "new_demand" || input.demandTrend === "falling") return "medium";
  if (!input.hasVendor || input.leadTimeSource === "default") return "medium";
  return "high";
}

function buildConfidenceFactors(input: {
  demandQuality: PurchasingRecommendationDemandQuality;
  demandTrend: PurchasingRecommendationDemandTrend;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  leadTimeSource: PurchasingRecommendationLeadTimeSource;
  safetyStockSource: PurchasingRecommendationSafetyStockSource;
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

  if (input.leadTimeSource === "vendor_product") {
    factors.push("Vendor-specific lead time is configured.");
  } else if (input.leadTimeSource === "product") {
    factors.push("Product lead time is configured.");
  } else {
    factors.push("Lead time uses the default fallback.");
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

function classifyDemandQuality(
  periodUsage: number,
  lookbackDays: number,
  demandOrderCount: number | null,
  demandActiveDays: number | null,
): PurchasingRecommendationDemandQuality {
  if (periodUsage <= 0) return "no_recent_demand";
  if ((demandOrderCount !== null && demandOrderCount <= 1) || (demandActiveDays !== null && demandActiveDays <= 1)) {
    return "thin_history";
  }
  if (periodUsage < 3 || lookbackDays < 14) return "thin_history";
  return "normal";
}

function classifyDemandTrend(
  periodUsage: number,
  priorPeriodUsage: number | null,
): PurchasingRecommendationDemandTrend {
  if (periodUsage <= 0) return "no_recent_demand";
  if (priorPeriodUsage === null) return "not_available";
  if (priorPeriodUsage <= 0) return "new_demand";

  const ratio = periodUsage / priorPeriodUsage;
  if (ratio >= 1.5) return "rising";
  if (ratio <= 0.5) return "falling";
  return "stable";
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

export function generatePurchasingRecommendations(
  options: GeneratePurchasingRecommendationsOptions,
): PurchasingRecommendationResult {
  const defaults = {
    leadTimeDays: asPositiveInt(options.defaults?.leadTimeDays, DEFAULTS.leadTimeDays),
    safetyStockDays: asPositiveInt(options.defaults?.safetyStockDays, DEFAULTS.safetyStockDays),
  };
  const rules = options.exclusionRules ?? [];
  const settings = options.autoDraftSettings ?? {};
  const lookbackDays = asPositiveInt(options.lookbackDays, 30);
  const items: PurchasingRecommendationItem[] = [];
  const skippedItems: PurchasingRecommendationItem[] = [];

  for (const row of options.rows) {
    const productId = asNumber(row.product_id);
    if (!productId) continue;

    const meta = getMeta(options.productMetaById, productId);
    const productVariantId = row.variant_id == null ? undefined : asNumber(row.variant_id);
    const totalOnHand = asNumber(row.total_pieces);
    const totalReserved = asNumber(row.total_reserved_pieces);
    const periodUsage = asNumber(row.total_outbound_pieces);
    const priorPeriodUsage = row.previous_outbound_pieces == null ? null : asNumber(row.previous_outbound_pieces);
    const demandOrderCount = row.demand_order_count == null ? null : asNumber(row.demand_order_count);
    const demandActiveDays = row.demand_active_days == null ? null : asNumber(row.demand_active_days);
    const latestDemandAt = row.latest_demand_at ?? null;
    const onOrderPieces = asNumber(row.on_order_pieces);
    const available = totalOnHand - totalReserved;
    const avgDailyUsage = lookbackDays > 0 ? periodUsage / lookbackDays : 0;
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
    const effectiveSupply = available + onOrderPieces;
    const rawOrderQtyPieces = Math.max(0, reorderPoint - effectiveSupply);
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
      reorderPoint,
      onOrderPieces,
      effectiveSupply,
    });
    const preferredVendorId = row.preferred_vendor_id == null ? null : asNumber(row.preferred_vendor_id);
    const preferredVendorName = row.preferred_vendor_name ?? null;
    const estimatedCostCents =
      row.estimated_cost_cents == null && row.unit_cost_cents == null
        ? null
        : asNumber(row.estimated_cost_cents ?? row.unit_cost_cents);
    const hasVendor = Boolean(preferredVendorId);
    const demandQuality = classifyDemandQuality(periodUsage, lookbackDays, demandOrderCount, demandActiveDays);
    const demandTrend = classifyDemandTrend(periodUsage, priorPeriodUsage);

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
      reorderPoint,
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
      openPoCount: asNumber(row.open_po_count),
      onOrderPieces,
      actionable,
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
      avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
      daysOfSupply,
      leadTimeDays,
      safetyStockDays,
      reorderPoint,
      suggestedOrderQty,
      suggestedOrderPieces,
      recommendedOrderQty: suggestedOrderQty,
      orderUomUnits,
      orderUomLabel,
      onOrderQty: orderUomUnits > 1 ? Math.floor(onOrderPieces / orderUomUnits) : onOrderPieces,
      onOrderPieces,
      openPoCount: asNumber(row.open_po_count),
      earliestExpectedDate: row.earliest_expected ?? null,
      status,
      lastReceivedAt: row.last_received_at ?? null,
      preferredVendorId,
      preferredVendorName,
      estimatedCostCents,
      currentSupply: {
        onHandPieces: totalOnHand,
        reservedPieces: totalReserved,
        availablePieces: available,
        effectiveSupplyPieces: effectiveSupply,
      },
      openPoSupply: {
        onOrderPieces,
        openPoCount: asNumber(row.open_po_count),
        earliestExpectedDate: row.earliest_expected ?? null,
      },
      demandBasis: {
        lookbackDays,
        periodUsagePieces: periodUsage,
        priorPeriodUsagePieces: priorPeriodUsage,
        avgDailyUsagePieces: Math.round(avgDailyUsage * 100) / 100,
        demandQuality,
        demandTrend,
        demandOrderCount,
        demandActiveDays,
        latestDemandAt,
      },
      leadTimeBasis: {
        leadTimeDays,
        leadTimeSource,
        safetyStockDays,
        safetyStockSource,
        reorderPointPieces: reorderPoint,
      },
      forecastProvenance: {
        demandSource: "recent_order_velocity",
        demandWindowDays: lookbackDays,
        demandQuality,
        demandTrend,
        periodUsagePieces: periodUsage,
        priorPeriodUsagePieces: priorPeriodUsage,
        avgDailyUsagePieces: Math.round(avgDailyUsage * 100) / 100,
        demandOrderCount,
        demandActiveDays,
        latestDemandAt,
        leadTimeSource,
        safetyStockSource,
        orderUomSource,
      },
      confidence: buildConfidence({
        demandQuality,
        demandTrend,
        leadTimeSource,
        hasVendor,
      }),
      confidenceFactors: buildConfidenceFactors({
        demandQuality,
        demandTrend,
        demandOrderCount,
        demandActiveDays,
        leadTimeSource,
        safetyStockSource,
        hasVendor,
        orderUomSource,
      }),
      explanation,
      reviewSignal,
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
  };

  return {
    items: visibleItems,
    skippedItems,
    summary,
    lookbackDays,
  };
}
