import { expect, test, type Page } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import { defaultPurchasePlanningPolicy } from "../../shared/procurement/purchase-planning-policy";
import { installFixtures } from "./procurement-fixtures";
import { forecastBacktestReportSchema, purchaseRecommendationPipelineHealthSchema } from "../../client/src/features/purchasing/forecastBacktesting";
import { purchaseReceiptSupplyEvidenceSchema } from "../../shared/procurement/purchase-receipt-supply-evidence";

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

async function setup(page: Page, bundleReview = false) {
  const failures = await installFixtures(page);
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

for (const numericStatus of ["ok", "on_order"] as const) {
  test(`default daily review exposes uncertain receipt evidence despite ${numericStatus} zero-buy status`, async ({ page }, testInfo) => {
    const { failures, analysis } = await setup(page);
    const base = analysis.items[0];
    const receiptIssue = "Closed receiving line 313 has no provable original receipt quantity; review its frozen unit evidence.";
    const receiptDetail = "Receipt quantities need review. The fallback PO commitment is unresolved; zero suggested pieces are not trusted no-buy guidance.";
    const reviewItem = {
      ...base,
      status: numericStatus,
      actionable: false,
      skippedReason: numericStatus === "on_order" ? "already_on_order" : "not_actionable_status",
      suggestedOrderQty: 0,
      suggestedOrderPieces: 0,
      reorderPoint: 100,
      leadTimeBasis: { ...base.leadTimeBasis, reorderPointPieces: 100 },
      forwardDemandBasis: { ...base.forwardDemandBasis, adjustedReorderPoint: 100 },
      supplyTiming: {
        ...base.supplyTiming,
        signal: "unverified_receipts",
        reviewRequired: true,
        detail: receiptDetail,
        scheduleComplete: false,
        scheduledWithinCyclePieces: 0,
        undatedPieces: 500,
        pastDuePieces: 0,
        beyondCyclePieces: 0,
        arrivals: [],
        receiptEvidence: purchaseReceiptSupplyEvidenceSchema.parse({
          version: 1,
          lines: [{
            purchaseOrderId: 17,
            purchaseOrderNumber: "TEST-PO-17",
            purchaseOrderLineId: 171,
            orderedPieces: 500,
            cancelledPieces: 0,
            poReceivedPieces: 0,
            postedReceivedPieces: 0,
            closedGrossReceivedPieces: null,
            closedReceivedPieces: null,
            remainingPieces: 500,
            receivingLineIds: [313],
            reviewIssues: [receiptIssue],
          }],
        }),
      },
      qualityGate: {
        ...base.qualityGate,
        autoDraftEligible: false,
        reason: "quality_control_block",
        label: "Receipt quantities need review",
        detail: receiptDetail,
      },
      autopilotBlockers: [{
        area: "inbound_supply",
        severity: "block",
        code: "unverified_receipts",
        label: "Receipt quantities need review",
        detail: receiptDetail,
      }],
    };
    const trustedItem = {
      ...base,
      recommendationId: "trusted-no-buy-control",
      productId: 11,
      sku: "TRUSTED-NO-BUY",
      productName: "Fictional trusted no-buy control",
      status: "ok",
      actionable: false,
      skippedReason: null,
      suggestedOrderQty: 0,
      suggestedOrderPieces: 0,
      supplyTiming: { ...base.supplyTiming, reviewRequired: false, signal: "scheduled" },
    };
    await page.route("**/api/purchasing/reorder-analysis", (route) => route.fulfill({
      json: { ...analysis, items: [reviewItem, trustedItem], skippedItems: [reviewItem] },
    }));

    // No All chip, search, deep link, or Show Skipped escape hatch: this is the daily default.
    await page.goto("/reorder-analysis");
    await expect(page.getByText("No mature 30-day evaluations yet", { exact: false })).toBeVisible();
    await expect(page.getByText("Pipeline health unavailable", { exact: false })).toHaveCount(0);
    const row = page.getByRole("row").filter({ hasText: "PLAN-TEST" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Receipt review", { exact: true })).toBeVisible();
    await expect(row.getByText(/^(Healthy|On order)$/)).toHaveCount(0);
    await expect(row.getByText(/^ETA /)).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "TRUSTED-NO-BUY" })).toHaveCount(0);
    await row.getByRole("button", { name: "Review receipt evidence", exact: true }).click();

    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText(receiptDetail, { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText(receiptIssue, { exact: false })).toBeVisible();
    await expect(drawer.getByText("Unresolved PO commitment", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: /TEST-PO-17.*line 171/ }).last()).toHaveAttribute("href", "/purchase-orders/17");
    await expect(drawer.getByText("No order suggested — effective supply covers the target.", { exact: true })).toHaveCount(0);
    await expect(drawer.getByText(/^(Healthy|On order)$/)).toHaveCount(0);
    await expect(drawer.getByText(/^Effective supply .* covers adjusted RP/)).toHaveCount(0);
    const coverageWarning = drawer.getByText("Supply coverage is unresolved until the closed receipt evidence is reviewed.", { exact: true });
    await coverageWarning.scrollIntoViewIfNeeded();
    await expect(coverageWarning).toBeInViewport({ ratio: 1 });
    await drawer.getByText(receiptIssue, { exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`planning-receipt-review-${numericStatus}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(failures).toEqual([]);
  });
}

test("planning explains growth, arrival risk and the exact source PO in the same drawer", async ({ page }, testInfo) => {
  const { failures } = await setup(page);
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("button", { name: /^All / }).click();
  await expect(page.getByText("Essential", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review arrival coverage", exact: true }).click();
  await expect(page.getByText("Uniform growth adjustment: 25%.", { exact: false })).toBeVisible();
  const link = page.getByRole("link", { name: /TEST-PO-17 · line 171/ });
  await expect(link).toHaveAttribute("href", "/purchase-orders/17");
  await expect(page.getByText("Projected supply can run out", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-arrival-evidence.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("stock policy retries retain their command identity and show validation before saving", async ({ page }, testInfo) => {
  const { failures, policy } = await setup(page);
  const requests: Array<{ expectedRevision: number; idempotencyKey: string; policy: unknown }> = [];
  await page.route("**/api/purchasing/planning-policy", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { revision: 3, policy } });
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 500, json: { error: "Synthetic lost response; retry the same request" } });
    return route.fulfill({ json: { revision: 4, policy: { ...policy, growthPercent: 30 } } });
  });
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  const growth = page.getByLabel("Uniform growth adjustment (%)", { exact: true });
  await growth.fill("30");
  const save = page.getByRole("button", { name: "Save stock and growth policy", exact: true });
  await save.click();
  await expect(page.getByText("Synthetic lost response; retry the same request", { exact: true })).toBeVisible();
  await save.click();
  await expect(page.getByText("Planning policy saved", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await growth.fill("1001");
  await expect(save).toBeDisabled();
  await expect(page.getByText("Enter valid quantities and days.", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-policy-review.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});


test("new product names survive subsequent policy edits", async ({ page }) => {
  const { failures } = await setup(page);
  await page.route("**/api/purchasing/planning-policy/products?*", (route) => route.fulfill({ json: { items: [{ id: 11, sku: "NEW-TEST", name: "Fictional new item" }] } }));
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  await page.getByLabel("Find product planning policy", { exact: true }).fill("NEW");
  await page.getByRole("button", { name: "NEW-TEST · Fictional new item", exact: true }).click();
  await page.getByLabel("Uniform growth adjustment (%)", { exact: true }).fill("30");
  await expect(page.locator("legend", { hasText: "NEW-TEST · Fictional new item" })).toBeVisible();
  expect(failures).toEqual([]);
});


test("replacement forecasts require an explicit valid range and save the exact total", async ({ page }, testInfo) => {
  const { failures, policy } = await setup(page);
  let saved: any;
  await page.route("**/api/purchasing/planning-policy", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { revision: 3, policy } });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { revision: 4, policy: saved.policy } });
  });
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  await page.getByRole("button", { name: "Add replacement forecast", exact: true }).click();
  const save = page.getByRole("button", { name: "Save stock and growth policy", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("Forecast start date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("Forecast end date", { exact: true }).fill("2026-10-31");
  await page.getByLabel("Total forecast pieces", { exact: true }).fill("600");
  await page.getByLabel("Forecast reference", { exact: true }).fill("October club plan");
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "Add replacement forecast", exact: true }).click();
  await page.getByLabel("Forecast start date", { exact: true }).nth(1).fill("2026-10-31");
  await page.getByLabel("Forecast end date", { exact: true }).nth(1).fill("2026-11-30");
  await page.getByLabel("Total forecast pieces", { exact: true }).nth(1).fill("700");
  await page.getByLabel("Forecast reference", { exact: true }).nth(1).fill("Overlapping forecast");
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Remove forecast range", exact: true }).nth(1).click();
  await save.click();
  await expect(page.getByText("Planning policy saved", { exact: true })).toBeVisible();
  expect(saved.policy.replacementForecasts).toEqual([{ productId: 10, startDate: "2026-10-01", endDate: "2026-10-31", totalPieces: 600, reference: "October club plan" }]);
  await page.screenshot({ path: testInfo.outputPath("planning-replacement-policy.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("supplier minimum is visible before drafting and an unresolved RFQ remains reviewable", async ({ page }, testInfo) => {
  const { failures } = await setup(page, true);
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("checkbox", { name: "Add PLAN-TEST to order", exact: true }).click();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  await expect(page.getByText("Supplier minimum $5,000 USD", { exact: false })).toBeVisible();
  await expect(page.getByText("Free-freight target $10,000", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Continue → confirm 1 PO/ }).click();
  await expect(page.getByRole("alert")).toContainText("below the supplier order minimum");
  await expect(page.getByRole("button", { name: /Create.*PO/ })).toBeDisabled();
  await page.getByRole("button", { name: "← Back", exact: true }).last().click();
  await page.getByRole("radio", { name: "Request quote", exact: true }).check();
  await expect(page.getByText("An RFQ can still be drafted for review; the supplier basket is unresolved.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-supplier-bundle.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});


test("manual supplier override captures an explained RFQ with exact supplier identity", async ({ page }, testInfo) => {
  const { failures, analysis } = await setup(page, true);
  const item = analysis.items[0];
  const option = { vendorProductId: 20, vendorId: 2, vendorName: "Test supplier", preferred: true, priority: 100, revision: 0, eligible: true, rejectionReasons: [], pricingReviewReasons: ["quote_missing"], currency: "USD", leadTimeDays: 120, minimumOrderPieces: 1, orderIncrementPieces: 1, proposedPieces: item.suggestedOrderPieces, estimatedUnitCostMills: null, tier: null };
  item.supplierBasis.sourcingSelection = { version: 1, selectedVendorProductId: 20, method: "preferred", rankBasis: "preferred_then_priority_then_variant_then_lead_time_then_identity", priceComparison: "not_performed", options: [option, { ...option, vendorProductId: 30, vendorId: 3, vendorName: "Alternate supplier", preferred: false, priority: 10, leadTimeDays: 20, proposedPieces: 100 }] };
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/purchasing/rfq-queue", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [{ recommendationId: item.recommendationId, recommendationLineId: 901, remainingPieces: item.suggestedOrderPieces, vendorId: 2, vendorProductId: 20 }] } });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { rfqs: [{ id: 902 }], lines: [{ id: 903 }], reused: false } });
  });
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("checkbox", { name: "Add PLAN-TEST to order", exact: true }).click();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  await page.getByLabel("Supplier for PLAN-TEST", { exact: true }).selectOption("30");
  await expect(page.getByRole("radio", { name: "Request quote", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Draft PO", exact: true })).toBeDisabled();
  const next = page.getByRole("button", { name: /Continue → confirm 1 RFQ/ });
  await expect(next).toBeDisabled();
  await page.getByPlaceholder("Reason for changing the requested quantity", { exact: true }).fill("Faster delivery for club member demand");
  await next.click();
  await expect(page.getByText("Alternate supplier", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("manual-supplier-rfq-review.png"), fullPage: true });
  await page.getByRole("button", { name: /^Create 1 RFQ/ }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ requestNote: expect.stringContaining("supplier override to Alternate supplier (mapping 30). Faster delivery for club member demand"), lines: [{ recommendationLineId: 901, vendorId: 3, vendorProductId: 30, requestedPieces: 100, quantityOverrideReason: "Faster delivery for club member demand" }] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
