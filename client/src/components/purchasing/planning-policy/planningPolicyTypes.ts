import {
  DEFAULT_STALE_PO_THRESHOLDS,
  type AutoDraftStalePoThresholds,
} from "@/features/purchasing/autoDraftSettingsValidation";

export type PlanningPolicyTab =
  | "all"
  | "stock-targets"
  | "exclusions"
  | "forecasting"
  | "automation";

export const PLANNING_POLICY_TABS = [
  { value: "all", label: "All Sections" },
  { value: "stock-targets", label: "Stock & Overrides" },
  { value: "exclusions", label: "Exclusions" },
  { value: "forecasting", label: "Forecasting" },
  { value: "automation", label: "Automation" },
] as const satisfies ReadonlyArray<{ value: PlanningPolicyTab; label: string }>;

export interface ExclusionRule {
  id: number;
  field: string;
  value: string;
  matchCount: number;
  createdAt: string;
}

export interface RulesData {
  rules: ExclusionRule[];
  totalExcluded: number;
}

export interface PurchasingForecastPolicy {
  method: "recent_order_velocity_v1" | "weighted_blend_v1";
  shortWindowDays: number;
  standardWindowDays: number;
  longWindowDays: number;
  seasonalEnabled: boolean;
  seasonalWindowDays: number;
  weights: { short: number; standard: number; long: number; seasonal: number };
  forwardDemandEnabled: boolean;
  forwardDemandHorizonDays: number;
  forwardDemandConfidenceWeights: { high: number; medium: number; low: number };
  automationMinimumOrderCount: number;
  automationMinimumActiveDays: number;
}

export interface AutoDraftSettings {
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: "high_confidence_only" | "high_confidence_and_strong_candidate";
  includeOrderSoon: boolean;
  skipOnOpenPo: boolean;
  skipNoVendor: boolean;
  candidateScoreStrongThreshold: number;
  candidateScoreReviewThreshold: number;
  rfqDraftAutomationMode: "manual" | "preferred_vendor";
  rfqDraftMinimumConfidence: "high" | "medium";
  rfqDraftRequireTrustedForecast: boolean;
  rfqDraftMaximumLinesPerRun: number;
  stalePoThresholds: AutoDraftStalePoThresholds;
  forecastPolicy: PurchasingForecastPolicy;
}

export const DEFAULT_FORECAST_POLICY: PurchasingForecastPolicy = {
  method: "weighted_blend_v1",
  shortWindowDays: 7,
  standardWindowDays: 30,
  longWindowDays: 90,
  seasonalEnabled: true,
  seasonalWindowDays: 30,
  weights: { short: 30, standard: 35, long: 20, seasonal: 15 },
  forwardDemandEnabled: true,
  forwardDemandHorizonDays: 90,
  forwardDemandConfidenceWeights: { high: 100, medium: 70, low: 40 },
  automationMinimumOrderCount: 2,
  automationMinimumActiveDays: 2,
};

export const FIELD_LABELS: Record<string, string> = {
  category: "Category",
  brand: "Brand",
  product_type: "Product Type",
  sku_prefix: "SKU Prefix",
  sku_exact: "SKU (exact)",
  tag: "Tag",
};

export const PLANNING_ADJUST_PERMISSION_MESSAGE =
  "Inventory adjustment permission is required to change exclusions and automation settings.";

export function thresholdInputDefaults(): Record<keyof AutoDraftStalePoThresholds, string> {
  return Object.fromEntries(
    Object.entries(DEFAULT_STALE_PO_THRESHOLDS).map(([key, value]) => [key, String(value)]),
  ) as Record<keyof AutoDraftStalePoThresholds, string>;
}

export function mergeForecastPolicy(
  policy?: Partial<PurchasingForecastPolicy> | null,
): PurchasingForecastPolicy {
  return {
    ...DEFAULT_FORECAST_POLICY,
    ...(policy ?? {}),
    weights: {
      ...DEFAULT_FORECAST_POLICY.weights,
      ...(policy?.weights ?? {}),
    },
    forwardDemandConfidenceWeights: {
      ...DEFAULT_FORECAST_POLICY.forwardDemandConfidenceWeights,
      ...(policy?.forwardDemandConfidenceWeights ?? {}),
    },
  };
}

export type ForecastPolicyValidationResult =
  | { ok: true }
  | { ok: false; error: { title: string; description: string } };

export function validateForecastPolicyDraft(
  draft: PurchasingForecastPolicy,
): ForecastPolicyValidationResult {
  const weightTotal = Object.values(draft.weights).reduce((sum, value) => sum + value, 0);
  if (weightTotal !== 100) {
    return {
      ok: false,
      error: {
        title: "Invalid forecast weights",
        description: "Short, standard, long, and seasonal weights must total 100.",
      },
    };
  }
  if (
    !(
      draft.shortWindowDays <= draft.standardWindowDays &&
      draft.standardWindowDays <= draft.longWindowDays
    )
  ) {
    return {
      ok: false,
      error: {
        title: "Invalid forecast windows",
        description: "Window lengths must run from short to standard to long.",
      },
    };
  }
  const confidence = draft.forwardDemandConfidenceWeights;
  if (!(confidence.high >= confidence.medium && confidence.medium >= confidence.low)) {
    return {
      ok: false,
      error: {
        title: "Invalid confidence weights",
        description: "High must be at least medium, and medium at least low.",
      },
    };
  }
  return { ok: true };
}
