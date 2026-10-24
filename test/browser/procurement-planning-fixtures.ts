import type { Page } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import { defaultPurchasePlanningPolicy } from "../../shared/procurement/purchase-planning-policy";
import { installFixtures } from "./procurement-fixtures";
import { forecastBacktestReportSchema, purchaseRecommendationPipelineHealthSchema } from "../../client/src/features/purchasing/forecastBacktesting";

// Empty fictional accuracy history is an explicit unknown, not a malformed API response.
const emptyAccuracyReport = forecastBacktestReportSchema.parse({
  evaluationVersion: 1,
  measurement: {
    scope: "product_all_warehouses",
    predictionScope: "baseline_with_date_replacements_and_optional_start_date_overlay",
    historicalPredictionScope: "baseline_with_date_replacements",
    horizons: [7, 30, 90],
    wapeUnit: "basis_points",
    quantityUnit: "base_piece",
    predictionPrecision: "micro_piece",
    overlayAttributionVersion: 1,
    overlayAttributionInterval: "Fictional fixture contains no observations or attributed demand events.",
    overlayEligibility: "No captured policy cohort in this fictional fixture.",
    policyCohortIsolation: "exact_policy_fingerprint_method_and_forecast_version",
  },
  policyCohorts: [],
  selectedPolicyCohort: null,
  cohortCoverage: {
    capturedPolicyCohortCount: 0,
    capturedObservationCount: 0,
    capturedEvaluationCount: 0,
    legacyObservationCount: 0,
    legacyEvaluationCount: 0,
  },
  accuracyTrustAssessment: {
    status: "not_assessed",
    reason: "no_captured_policy_cohort",
    selectedPolicyFingerprint: null,
    selectedForecastVersion: null,
    cohortIsolated: false,
    selectedCohortEvaluationCount: 0,
    excludedLegacyEvaluationCount: 0,
    excludedOtherPolicyCohortEvaluationCount: 0,
  },
  summaries: [],
  itemCount: 0,
  items: [],
});
const emptyPipelineHealth = purchaseRecommendationPipelineHealthSchema.parse({
  generatedAt: "2026-09-07T12:00:00.000Z",
  status: "warning",
  critical: 0,
  warning: 1,
  latestScheduledRun: null,
  jobs: { recommendationSnapshot: null, forecastEvaluation: null },
  latestEvaluationAt: null,
  maturedEvaluationBacklog: 0,
  thresholds: { warningAgeHours: 36, criticalAgeHours: 72 },
  detail: "No scheduled execution evidence exists in this fictional browser fixture.",
});

export async function setupPlanning(page: Page, bundleReview = false) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, permissions: ["purchasing:view", "purchasing:edit"], roles: ["admin"] } }));
  await page.route("**/api/purchasing/forecast-backtests?*", (route) => route.fulfill({ json: emptyAccuracyReport }));
  await page.route("**/api/procurement/health/recommendation-pipeline", (route) => route.fulfill({ json: emptyPipelineHealth }));
  const policy = { ...defaultPurchasePlanningPolicy(), growthPercent: 25, products: [{ productId: 10, essential: true, minimumStockPieces: 100, targetCoverDays: 180, leadTimeStages: null }] };
  const analysis = generatePurchasingRecommendations({ asOf: "2026-09-07T12:00:00.000Z", lookbackDays: 30, autoDraftSettings: { planningPolicy: policy }, rows: [{
    product_id: 10, variant_id: 100, base_sku: "PLAN-TEST", product_name: "Fictional planning item", total_pieces: 20, total_reserved_pieces: 0, total_outbound_pieces: 60, previous_outbound_pieces: 60, demand_order_count: 12, demand_active_days: 10, latest_demand_at: "2026-09-06", on_order_pieces: bundleReview ? 0 : 500, open_po_count: bundleReview ? 0 : 1, earliest_expected: "2026-09-30", lead_time_days: 120, safety_stock_days: 10,
    preferred_vendor_id: 2, preferred_vendor_name: "Test supplier", vendor_product_id: 20, estimated_cost_mills: 10000, vendor_currency: "USD", vendor_minimum_order_cents: 500000, vendor_free_freight_threshold_cents: 1000000, inbound_schedule: bundleReview ? [] : [{ purchaseOrderId: 17, purchaseOrderNumber: "TEST-PO-17", purchaseOrderLineId: 171, remainingPieces: 500, expectedDate: "2026-09-30" }],
  }] });
  await page.route("**/api/settings/procurement", (route) => route.fulfill({ json: { useNewPoEditor: true, useNewReorderCockpit: true } }));
  await page.route("**/api/purchasing/kpis", (route) => route.fulfill({ json: { criticalRestocks: 0, upcomingRestocks: 0, idleCapitalCents: 0, inboundPipelineValueCents: 50000, totalOpenLines: 1, lastComputedAt: "2026-09-07T12:00:00Z" } }));
  await page.route("**/api/purchasing/reorder-analysis", (route) => route.fulfill({ json: analysis }));
  await page.route("**/api/purchasing/exclusion-rules", (route) => route.fulfill({ json: { rules: [], totalExcluded: 0 } }));
  await page.route("**/api/purchasing/exclusion-rules/field-values?*", (route) => route.fulfill({ json: { field: "category", values: [] } }));
  await page.route("**/api/purchasing/auto-draft-settings", (route) => route.fulfill({ json: { autoDraftMode: "review_only", forecastPolicy: {} } }));
  await page.route("**/api/purchasing/planning-policy", (route) => route.fulfill({ json: { revision: 3, policy, products: [{ id: 10, sku: "PLAN-TEST", name: "Fictional planning item" }] } }));
  await page.route("**/api/purchasing/planning-policy/history", (route) => route.fulfill({ json: { changes: [] } }));
  return { failures, policy, analysis };
}
